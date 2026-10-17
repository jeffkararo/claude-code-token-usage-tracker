import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';

// Claude Code's `/usage` command runs locally in print mode (no model call, no tokens) and prints the
// same 5-hour and weekly windows the statusline reports. Polling it keeps limits fresh even when the
// only Claude Code in use is the VS Code chat panel, which never runs the statusline.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LINE = /^\s*Current (session|week)(?: \(([^)]+)\))?:\s*([\d.]+)% used(?:\s*·\s*resets\s+(.+?))?\s*$/i;

export interface PolledWindow {
	label: string;
	usedPercent: number;
	resetsAt: number | null;
}

export interface UsageReport {
	fiveHour?: PolledWindow;
	sevenDay?: PolledWindow;
	/** Model-specific weekly windows, such as "Current week (Opus)". */
	other: PolledWindow[];
	subscription: boolean;
}

function zoneOffset(ts: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric',
	}).formatToParts(ts);
	const value = (type: string) => Number(parts.find(p => p.type === type)?.value);
	return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second')) - ts;
}

/** Epoch ms for a wall-clock time in an IANA zone (falls back to the local zone if the name is unknown). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
	if (!timeZone) return new Date(year, month, day, hour, minute).getTime();
	try {
		const guess = Date.UTC(year, month, day, hour, minute);
		const first = guess - zoneOffset(guess, timeZone);
		return guess - zoneOffset(first, timeZone);
	} catch {
		return new Date(year, month, day, hour, minute).getTime();
	}
}

/** Parses "Oct 14, 6:59pm (America/Chicago)" or "6:59pm (America/Chicago)" relative to `now`. */
export function parseReset(text: string, now: number): number | null {
	const m = /^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?$/i.exec(text.trim());
	if (!m) return null;
	const [, monthName, dayText, hourText, minuteText, meridiem, zone] = m;
	let hour = Number(hourText) % 12;
	if (!meridiem) hour = Number(hourText);
	else if (meridiem.toLowerCase() === 'pm') hour += 12;
	const minute = Number(minuteText ?? 0);
	const today = new Date(now);
	let month = today.getMonth();
	let day = today.getDate();
	if (monthName) {
		month = MONTHS.indexOf(monthName.toLowerCase());
		if (month === -1) return null;
		day = Number(dayText);
	}
	let ts = zonedTime(today.getFullYear(), month, day, hour, minute, zone);
	if (monthName && ts < now - 2 * 86_400_000) ts = zonedTime(today.getFullYear() + 1, month, day, hour, minute, zone);
	else if (!monthName && ts < now) ts += 86_400_000;
	return ts;
}

/** Extracts rate-limit windows from the text `/usage` prints. */
export function parseUsageText(text: string, now: number): UsageReport {
	const report: UsageReport = { other: [], subscription: /using your subscription/i.test(text) };
	for (const line of text.split(/\r?\n/)) {
		const m = LINE.exec(line);
		if (!m) continue;
		const [, kind, qualifier, percent, reset] = m;
		const window: PolledWindow = {
			label: qualifier ? `${kind} (${qualifier})` : kind,
			usedPercent: Number(percent),
			resetsAt: reset ? parseReset(reset, now) : null,
		};
		if (kind.toLowerCase() === 'session') report.fiveHour ??= window;
		else if (!qualifier || /all models/i.test(qualifier)) report.sevenDay ??= window;
		else report.other.push(window);
	}
	return report;
}

export interface PollResult {
	report?: UsageReport;
	/** True when Claude Code answered with a model call instead of the local command; polling must stop. */
	unsafe?: boolean;
	error?: string;
}

/** Runs `claude -p /usage` and parses its JSON result. */
export function runUsageCommand(cli: string, cwd: string, now = Date.now()): Promise<PollResult> {
	return new Promise(resolve => {
		execFile(
			cli,
			['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
			{ cwd, timeout: 45_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
			(error, stdout, stderr) => {
				let parsed: { local_command?: string; total_cost_usd?: number; num_turns?: number; result?: string; is_error?: boolean } | undefined;
				try {
					parsed = JSON.parse(stdout);
				} catch {
					resolve({ error: error ? `${error.message} ${stderr}`.trim() : 'Unexpected /usage output' });
					return;
				}
				if (!parsed) {
					resolve({ error: 'Empty /usage output' });
					return;
				}
				if (parsed.local_command !== 'usage' || (parsed.total_cost_usd ?? 0) > 0 || (parsed.num_turns ?? 0) > 0) {
					resolve({ unsafe: true, error: '/usage was not handled locally by this Claude Code version' });
					return;
				}
				if (parsed.is_error) {
					resolve({ error: parsed.result || '/usage reported an error' });
					return;
				}
				resolve({ report: parseUsageText(parsed.result ?? '', now) });
			},
		);
	});
}

function rawWindow(window: PolledWindow | undefined): { used_percentage: number; resets_at: number } | undefined {
	if (!window || window.resetsAt === null) return undefined;
	return { used_percentage: window.usedPercent, resets_at: Math.round(window.resetsAt / 1000) };
}

/**
 * Saves a polled report in the same files the statusline bridge writes, so every reader
 * (status bar, meters, burn-rate history) treats both sources alike.
 */
export async function saveReport(dataDir: string, report: UsageReport, now = Date.now()): Promise<boolean> {
	const five = rawWindow(report.fiveHour);
	const week = rawWindow(report.sevenDay);
	if (!five && !week) return false;
	const rateLimits: Record<string, unknown> = {};
	if (five) rateLimits.five_hour = five;
	if (week) rateLimits.seven_day = week;
	await fsp.mkdir(dataDir, { recursive: true });
	const tmp = path.join(dataDir, `rate-limits.json.${process.pid}.tmp`);
	await fsp.writeFile(tmp, JSON.stringify({ bridgeVersion: 1, source: 'usage-poll', receivedAt: now, rateLimits }));
	try {
		await fsp.rename(tmp, path.join(dataDir, 'rate-limits.json'));
	} catch {
		await fsp.copyFile(tmp, path.join(dataDir, 'rate-limits.json'));
		await fsp.unlink(tmp).catch(() => undefined);
	}

	const statePath = path.join(dataDir, 'rate-history.state.json');
	let last: { five?: number | null; week?: number | null };
	try {
		last = JSON.parse(await fsp.readFile(statePath, 'utf8'));
	} catch {
		last = {};
	}
	const fivePct = five?.used_percentage ?? null;
	const weekPct = week?.used_percentage ?? null;
	if (last.five !== fivePct || last.week !== weekPct) {
		const entry = { t: now, five: fivePct, fiveReset: five?.resets_at, week: weekPct, weekReset: week?.resets_at, spend: null };
		await fsp.appendFile(path.join(dataDir, 'rate-history.jsonl'), JSON.stringify(entry) + '\n');
		await fsp.writeFile(statePath, JSON.stringify({ five: fivePct, week: weekPct, spend: null }));
	}
	return true;
}
