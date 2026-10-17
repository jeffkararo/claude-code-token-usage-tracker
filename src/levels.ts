// Pure helpers for threshold levels, colours and the status-bar text. No vscode import, so they are unit tested.
import { formatUsd } from './format';
import { WindowInsight } from './types';

export type Level = 'normal' | 'warning' | 'critical';

/** Defaults for the warning and critical colours. The normal colour defaults to the theme (empty). */
export const DEFAULT_COLORS = { warning: '#e8a23a', critical: '#e5484d' };
export const DEFAULT_THRESHOLDS = { warning: 75, critical: 90 };

function clampPercent(value: unknown, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

/** Clamps both thresholds to 0-100 and keeps critical at or above warning, so a bad setting cannot invert the levels. */
export function normalizeThresholds(warning: unknown, critical: unknown): { warning: number; critical: number } {
	const w = clampPercent(warning, DEFAULT_THRESHOLDS.warning);
	const c = clampPercent(critical, DEFAULT_THRESHOLDS.critical);
	return { warning: w, critical: Math.max(c, w) };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True for "" (use the default) or a #rgb / #rrggbb colour. */
export function validateColor(value: unknown): boolean {
	return typeof value === 'string' && (value === '' || HEX.test(value));
}

/** Returns the colour as lowercase #rrggbb, or `fallback` when it is empty or not a hex colour. Nothing else reaches CSS. */
export function safeColor(value: unknown, fallback: string): string {
	if (typeof value !== 'string' || !HEX.test(value)) return fallback;
	const hex = value.toLowerCase();
	return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

/** Thresholds are percentages *used*: warning at 75% used, critical at 90% used by default. */
export function levelFor(usedPercent: number, warningAtUsed: number, criticalAtUsed: number): Level {
	if (usedPercent >= criticalAtUsed) return 'critical';
	if (usedPercent >= warningAtUsed) return 'warning';
	return 'normal';
}

const RANK: Record<Level, number> = { normal: 0, warning: 1, critical: 2 };

export function worstLevel(levels: Level[]): Level {
	return levels.reduce<Level>((worst, level) => (RANK[level] > RANK[worst] ? level : worst), 'normal');
}

/** "19:00" today, "10/16, 03:00" on another day (locale order and clock style). */
export function formatResetShort(ts: number, now: number): string {
	const d = new Date(ts);
	const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	if (new Date(now).toDateString() === d.toDateString()) return time;
	return `${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}, ${time}`;
}

export interface StatusTextOptions {
	quotaDisplay: 'remaining' | 'used';
	showResets: boolean;
	showCost: boolean;
}

/** Builds the single status-bar entry, e.g. "$(pulse) 5H: 64% / Rst: 19:00 · Weekly: 97% / Rst: 10/16, 03:00 · $12.34". */
export function statusText(windows: WindowInsight[], todayCost: number, now: number, options: StatusTextOptions): string {
	const parts: string[] = [];
	for (const w of windows) {
		if (w.key === 'spend' && w.usedPercent === null) continue;
		const label = w.key === 'fiveHour' ? '5H' : w.key === 'sevenDay' ? 'Weekly' : 'Spend';
		if (w.usedPercent === null) {
			if (w.key !== 'spend') parts.push(`${label}: N/A`);
			continue;
		}
		const value = Math.round(options.quotaDisplay === 'used' ? w.usedPercent : 100 - w.usedPercent);
		let part = `${label}: ${value}%${w.stale ? '~' : ''}`;
		if (options.showResets && w.resetsAt) part += ` / Rst: ${formatResetShort(w.resetsAt, now)}`;
		parts.push(part);
	}
	const haveLimits = windows.some(w => w.usedPercent !== null);
	if (!haveLimits) return `$(pulse) Claude ${formatUsd(todayCost, true)}`;
	if (options.showCost) parts.push(formatUsd(todayCost, true));
	return `$(pulse) ${parts.join(' · ')}`;
}
