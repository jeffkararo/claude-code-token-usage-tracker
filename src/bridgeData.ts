import { promises as fsp } from 'fs';
import * as path from 'path';
import { BridgeHistoryPoint, BridgeRateLimits, LiveSession, RateWindow, SpendWindow } from './types';

const HISTORY_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const LIVE_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function readJson(file: string): Promise<any> {
	try {
		return JSON.parse(await fsp.readFile(file, 'utf8'));
	} catch {
		return undefined;
	}
}

function toWindow(raw: any, now: number): RateWindow | undefined {
	if (!raw || typeof raw.used_percentage !== 'number') return undefined;
	const resetsAt = typeof raw.resets_at === 'number' ? raw.resets_at * 1000 : NaN;
	// Claude Code drops a window once it resets; a saved snapshot past reset is no longer true.
	if (!Number.isFinite(resetsAt) || resetsAt <= now) return undefined;
	return { usedPercent: Math.max(0, raw.used_percentage), resetsAt };
}

/** Converts the raw `rate_limits` object into windows that are still current at `now`. */
export function parseRateLimits(raw: any, receivedAt: number, now: number): BridgeRateLimits {
	const result: BridgeRateLimits = { receivedAt };
	const five = toWindow(raw?.five_hour, now);
	const week = toWindow(raw?.seven_day, now);
	const spendBase = toWindow(raw?.spend_limit, now);
	if (five) result.fiveHour = five;
	if (week) result.sevenDay = week;
	if (spendBase) {
		const spend: SpendWindow = { ...spendBase };
		if (typeof raw.spend_limit.used_usd === 'number') spend.usedUsd = raw.spend_limit.used_usd;
		if (typeof raw.spend_limit.limit_usd === 'number') spend.limitUsd = raw.spend_limit.limit_usd;
		if (typeof raw.spend_limit.period === 'string') spend.period = raw.spend_limit.period;
		result.spend = spend;
	}
	return result;
}

export class BridgeReader {
	constructor(private dataDir: string) {}

	get directory(): string {
		return this.dataDir;
	}

	setDirectory(dir: string): void {
		this.dataDir = dir;
	}

	async rateLimits(now = Date.now()): Promise<BridgeRateLimits | undefined> {
		const raw = await readJson(path.join(this.dataDir, 'rate-limits.json'));
		if (!raw || typeof raw.receivedAt !== 'number') return undefined;
		return parseRateLimits(raw.rateLimits, raw.receivedAt, now);
	}

	async history(now = Date.now()): Promise<BridgeHistoryPoint[]> {
		let text: string;
		try {
			text = await fsp.readFile(path.join(this.dataDir, 'rate-history.jsonl'), 'utf8');
		} catch {
			return [];
		}
		const points: BridgeHistoryPoint[] = [];
		for (const line of text.split('\n')) {
			if (!line) continue;
			try {
				const point = JSON.parse(line);
				if (typeof point.t === 'number' && now - point.t < HISTORY_LOOKBACK_MS) points.push(point);
			} catch {
				/* skip torn lines */
			}
		}
		return points.sort((a, b) => a.t - b.t);
	}

	/** Latest per-session snapshots written by the bridge, keyed by session id. */
	async sessionSnapshots(now = Date.now()): Promise<Map<string, any>> {
		const dir = path.join(this.dataDir, 'sessions');
		const result = new Map<string, any>();
		let names: string[];
		try {
			names = await fsp.readdir(dir);
		} catch {
			return result;
		}
		for (const name of names) {
			if (!name.endsWith('.json')) continue;
			const snapshot = await readJson(path.join(dir, name));
			if (!snapshot?.sessionId || typeof snapshot.receivedAt !== 'number') continue;
			if (now - snapshot.receivedAt > LIVE_SESSION_MAX_AGE_MS) continue;
			result.set(snapshot.sessionId, snapshot);
		}
		return result;
	}

	/** Most recent time the bridge wrote anything. */
	async lastSeen(): Promise<number | null> {
		try {
			const stat = await fsp.stat(path.join(this.dataDir, 'sessions'));
			return stat.mtimeMs;
		} catch {
			return null;
		}
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === 'EPERM';
	}
}

/**
 * Running Claude Code processes register in <claudeDir>/sessions/<pid>.json.
 * Merges those with bridge snapshots to describe sessions that are open now.
 */
export async function liveSessions(claudeDir: string, snapshots: Map<string, any>, now = Date.now()): Promise<LiveSession[]> {
	const sessionsDir = path.join(claudeDir, 'sessions');
	const byId = new Map<string, LiveSession>();
	let names: string[] = [];
	try {
		names = await fsp.readdir(sessionsDir);
	} catch {
		/* no registry */
	}
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) continue;
		const info = await readJson(path.join(sessionsDir, name));
		if (!info?.sessionId || typeof info.pid !== 'number' || !processAlive(info.pid)) continue;
		byId.set(info.sessionId, {
			sessionId: info.sessionId,
			name: info.name,
			cwd: info.cwd,
			status: info.status,
			updatedAt: info.updatedAt,
			entrypoint: info.entrypoint,
		});
	}
	for (const [sessionId, snap] of snapshots) {
		const live = byId.get(sessionId) ?? (now - snap.receivedAt < 15 * 60 * 1000 ? { sessionId } : undefined);
		if (!live) continue;
		const ctx = snap.contextWindow || {};
		const cache = snap.promptCache || {};
		Object.assign(live, {
			name: snap.sessionName || live.name,
			cwd: live.cwd || snap.workspace?.currentDir,
			model: snap.model?.display_name || snap.model?.id,
			contextPercent: typeof ctx.used_percentage === 'number' ? ctx.used_percentage : undefined,
			contextSize: ctx.context_window_size,
			contextTokens: ctx.current_usage
				? (ctx.current_usage.input_tokens || 0) +
					(ctx.current_usage.cache_creation_input_tokens || 0) +
					(ctx.current_usage.cache_read_input_tokens || 0)
				: undefined,
			sessionCostUsd: snap.cost?.total_cost_usd,
			linesAdded: snap.cost?.total_lines_added,
			linesRemoved: snap.cost?.total_lines_removed,
			cacheHitRatio: typeof cache.hit_ratio === 'number' ? cache.hit_ratio : undefined,
			cacheWarm: cache.warm,
			cacheExpiresAt: typeof cache.expires_at === 'number' ? cache.expires_at * 1000 : undefined,
			cacheTtl: cache.ttl,
			cacheMisses: cache.misses,
			effort: snap.effort?.level,
			fastMode: snap.fastMode,
			transcriptPath: snap.transcriptPath,
			bridgeAt: snap.receivedAt,
		} satisfies Partial<LiveSession>);
		byId.set(sessionId, live);
	}
	return [...byId.values()].sort((a, b) => (b.bridgeAt ?? b.updatedAt ?? 0) - (a.bridgeAt ?? a.updatedAt ?? 0));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
