import * as path from 'path';
import { modelLabel, PriceBook } from './pricing';
import {
	BreakdownGroup,
	BridgeHistoryPoint,
	BridgeRateLimits,
	DashboardModel,
	LiveSession,
	ModelRow,
	ProjectRow,
	PromptRecord,
	PromptRow,
	RangeKey,
	SeriesPoint,
	SessionRow,
	Totals,
	UsageRecord,
	WindowInsight,
} from './types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * DAY;
const STALE_AFTER_MS = 30 * 60 * 1000;

export interface AggregateInput {
	records: Iterable<UsageRecord>;
	prompts: Iterable<PromptRecord>;
	title: (sessionId: string) => string | undefined;
	sessionFile: (sessionId: string) => string | undefined;
	/** Resolves a record's project key to a display path. */
	projectPath?: (key: string) => string;
	prices: PriceBook;
	range: RangeKey;
	now: number;
	historyLimit: number;
	rate?: BridgeRateLimits;
	history: BridgeHistoryPoint[];
	live: LiveSession[];
	planMonthlyPrice: number;
	bridge: DashboardModel['bridge'];
	scan: Omit<DashboardModel['scan'], 'records' | 'prompts'>;
}

interface Priced {
	record: UsageRecord;
	cost: number;
	priced: boolean;
	savings: number;
}

export function startOfDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function rangeStart(range: RangeKey, now: number): number | null {
	const today = startOfDay(now);
	switch (range) {
		case '1d':
			return today;
		case '24h':
			return now - DAY;
		case '7d':
			return addDays(today, -6);
		case '14d':
			return addDays(today, -13);
		case '21d':
			return addDays(today, -20);
		case '30d':
			return addDays(today, -29);
		case '90d':
			return addDays(today, -89);
		case '365d':
			return addDays(today, -364);
		default:
			return null;
	}
}

function addDays(ts: number, days: number): number {
	const d = new Date(ts);
	d.setDate(d.getDate() + days);
	return d.getTime();
}

function emptyTotals(): Totals {
	return {
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		thinking: 0,
		calls: 0,
		prompts: 0,
		sessions: 0,
		webSearches: 0,
		toolCalls: 0,
		cacheHitRate: null,
		cacheSavings: 0,
		subagentCost: 0,
		unpricedCalls: 0,
	};
}

function tokensOf(r: UsageRecord): number {
	return r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
}

function hitRate(cacheRead: number, cacheWrite: number, input: number): number | null {
	const denominator = cacheRead + cacheWrite + input;
	return denominator > 0 ? cacheRead / denominator : null;
}

function totalsFor(items: Priced[], prompts: PromptRecord[]): Totals {
	const totals = emptyTotals();
	const sessions = new Set<string>();
	for (const { record: r, cost, priced, savings } of items) {
		totals.cost += cost;
		totals.input += r.input;
		totals.output += r.output;
		totals.cacheRead += r.cacheRead;
		totals.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
		totals.thinking += r.thinking;
		totals.calls += 1;
		totals.webSearches += r.webSearches;
		totals.toolCalls += r.tools.length;
		totals.cacheSavings += savings;
		if (r.sidechain) totals.subagentCost += cost;
		if (!priced) totals.unpricedCalls += 1;
		sessions.add(r.sessionId);
	}
	totals.prompts = prompts.length;
	totals.sessions = sessions.size;
	totals.cacheHitRate = hitRate(totals.cacheRead, totals.cacheWrite, totals.input);
	return totals;
}

function bucketKind(range: RangeKey, start: number, now: number): 'hour' | 'day' | 'week' {
	if (range === '1d' || range === '24h') return 'hour';
	return now - start > 120 * DAY ? 'week' : 'day';
}

function bucketStart(ts: number, kind: 'hour' | 'day' | 'week'): number {
	const d = new Date(ts);
	if (kind === 'hour') {
		d.setMinutes(0, 0, 0);
		return d.getTime();
	}
	d.setHours(0, 0, 0, 0);
	if (kind === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
}

function nextBucket(ts: number, kind: 'hour' | 'day' | 'week'): number {
	if (kind === 'hour') return ts + HOUR;
	return addDays(ts, kind === 'week' ? 7 : 1);
}

function bucketLabel(ts: number, kind: 'hour' | 'day' | 'week'): string {
	const d = new Date(ts);
	if (kind === 'hour') return `${String(d.getHours()).padStart(2, '0')}:00`;
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildSeries(items: Priced[], prompts: PromptRecord[], kind: 'hour' | 'day' | 'week', start: number, now: number): SeriesPoint[] {
	const points: SeriesPoint[] = [];
	const index = new Map<number, SeriesPoint>();
	for (let t = bucketStart(start, kind); t <= now; t = nextBucket(t, kind)) {
		const point: SeriesPoint = {
			label: bucketLabel(t, kind),
			start: t,
			cost: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			prompts: 0,
			calls: 0,
			cacheHitRate: null,
		};
		points.push(point);
		index.set(t, point);
	}
	for (const { record: r, cost } of items) {
		const point = index.get(bucketStart(r.ts, kind));
		if (!point) continue;
		point.cost += cost;
		point.input += r.input;
		point.output += r.output;
		point.cacheRead += r.cacheRead;
		point.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
		point.calls += 1;
	}
	for (const p of prompts) {
		const point = index.get(bucketStart(p.ts, kind));
		if (point) point.prompts += 1;
	}
	for (const point of points) point.cacheHitRate = hitRate(point.cacheRead, point.cacheWrite, point.input);
	return points;
}

function projectName(project: string): string {
	if (!project) return '(unknown)';
	return path.basename(project.replace(/[\\/]+$/, '')) || project;
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_MODEL_GROUPS = 8;
const MAX_COMBINED_GROUPS = 12;
/** Separates model and effort in combined group names, e.g. "Opus 5.5 · high". */
export const GROUP_SEPARATOR = ' · ';

/** Splits token usage by a grouping key, with one value per series bucket for each metric. */
function buildBreakdown(
	items: Priced[],
	series: SeriesPoint[],
	kind: 'hour' | 'day' | 'week',
	keyOf: (r: UsageRecord) => string,
	order: (groups: BreakdownGroup[]) => BreakdownGroup[],
): BreakdownGroup[] {
	const index = new Map(series.map((p, i) => [p.start, i]));
	const groups = new Map<string, BreakdownGroup>();
	const blank = (): number[] => new Array<number>(series.length).fill(0);
	for (const { record: r, cost } of items) {
		const name = keyOf(r);
		let group = groups.get(name);
		if (!group) {
			group = { name, calls: 0, total: 0, fresh: 0, cacheRead: 0, output: 0, thinking: 0, cost: 0, series: { total: blank(), fresh: blank(), output: blank(), thinking: blank() } };
			groups.set(name, group);
		}
		const total = tokensOf(r);
		const fresh = r.input + r.cacheWrite5m + r.cacheWrite1h;
		group.calls += 1;
		group.total += total;
		group.fresh += fresh;
		group.cacheRead += r.cacheRead;
		group.output += r.output;
		group.thinking += r.thinking;
		group.cost += cost;
		const i = index.get(bucketStart(r.ts, kind));
		if (i === undefined) continue;
		group.series.total[i] += total;
		group.series.fresh[i] += fresh;
		group.series.output[i] += r.output;
		group.series.thinking[i] += r.thinking;
	}
	return order([...groups.values()]);
}

function byTotalWithOther(groups: BreakdownGroup[], limit = MAX_MODEL_GROUPS): BreakdownGroup[] {
	const sorted = groups.sort((a, b) => b.total - a.total);
	if (sorted.length <= limit) return sorted;
	const rest = sorted.slice(limit - 1);
	const other = rest.reduce<BreakdownGroup>(
		(acc, g) => {
			for (const key of ['calls', 'total', 'fresh', 'cacheRead', 'output', 'thinking', 'cost'] as const) acc[key] += g[key];
			for (const metric of ['total', 'fresh', 'output', 'thinking'] as const) g.series[metric].forEach((v, i) => (acc.series[metric][i] += v));
			return acc;
		},
		{
			name: 'Other',
			calls: 0,
			total: 0,
			fresh: 0,
			cacheRead: 0,
			output: 0,
			thinking: 0,
			cost: 0,
			series: {
				total: rest[0].series.total.map(() => 0),
				fresh: rest[0].series.fresh.map(() => 0),
				output: rest[0].series.output.map(() => 0),
				thinking: rest[0].series.thinking.map(() => 0),
			},
		},
	);
	return [...sorted.slice(0, limit - 1), other];
}

function byEffortLevel(groups: BreakdownGroup[]): BreakdownGroup[] {
	const rank = (name: string) => {
		const i = EFFORT_ORDER.indexOf(name);
		return i === -1 ? (name === 'not set' ? 99 : 50) : i;
	};
	return groups.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** Finds the prompt each API call answered: the latest prompt in its session at or before the call. */
function assignToPrompts(items: Priced[], prompts: PromptRecord[]): Map<string, Priced[]> {
	const bySession = new Map<string, PromptRecord[]>();
	for (const p of prompts) {
		const list = bySession.get(p.sessionId) ?? [];
		list.push(p);
		bySession.set(p.sessionId, list);
	}
	for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts);
	const result = new Map<string, Priced[]>();
	for (const item of items) {
		const list = bySession.get(item.record.sessionId);
		if (!list || list[0].ts > item.record.ts) continue;
		let lo = 0;
		let hi = list.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (list[mid].ts <= item.record.ts) lo = mid;
			else hi = mid - 1;
		}
		const key = list[lo].uuid;
		const bucket = result.get(key) ?? [];
		bucket.push(item);
		result.set(key, bucket);
	}
	return result;
}

/** Local fallback for the 5-hour window: blocks start on the hour of the first call after the previous block ends. */
export function currentLocalBlock(timestamps: number[], now: number): number | null {
	let blockStart: number | null = null;
	for (const ts of timestamps) {
		if (blockStart === null || ts >= blockStart + FIVE_HOURS) {
			const d = new Date(ts);
			d.setMinutes(0, 0, 0);
			blockStart = d.getTime();
		}
	}
	return blockStart !== null && now < blockStart + FIVE_HOURS ? blockStart : null;
}

/** Percentage points per hour from bridge history inside the current window. */
export function burnRate(history: BridgeHistoryPoint[], key: 'five' | 'week', windowStart: number, now: number): number | null {
	const lookback = key === 'five' ? 90 * 60 * 1000 : DAY;
	const points = history.filter(p => p[key] !== null && p[key] !== undefined && p.t >= Math.max(windowStart, now - lookback));
	if (points.length < 2) return null;
	const first = points[0];
	const last = points[points.length - 1];
	const hours = (last.t - first.t) / HOUR;
	if (hours < 5 / 60) return null;
	const delta = (last[key] as number) - (first[key] as number);
	return delta > 0 ? delta / hours : 0;
}

function windowInsight(
	key: WindowInsight['key'],
	label: string,
	span: number,
	window: { usedPercent: number; resetsAt: number; usedUsd?: number; limitUsd?: number; period?: string } | undefined,
	fallbackStart: number | null,
	receivedAt: number | undefined,
	all: Priced[],
	prompts: PromptRecord[],
	history: BridgeHistoryPoint[],
	now: number,
): WindowInsight {
	const windowStart = window ? window.resetsAt - span : fallbackStart;
	let localCost = 0;
	let localTokens = 0;
	let localPrompts = 0;
	if (windowStart !== null) {
		for (const { record, cost } of all) {
			if (record.ts >= windowStart && record.ts <= now) {
				localCost += cost;
				localTokens += tokensOf(record);
			}
		}
		localPrompts = prompts.filter(p => p.ts >= windowStart && p.ts <= now).length;
	}
	const elapsedHours = windowStart !== null ? Math.max((now - windowStart) / HOUR, 1 / 60) : null;
	const pctPerHour = window && windowStart !== null && key !== 'spend' ? burnRate(history, key === 'fiveHour' ? 'five' : 'week', windowStart, now) : null;
	let projectedFullAt: number | null = null;
	if (window && pctPerHour && pctPerHour > 0) {
		const eta = now + ((100 - window.usedPercent) / pctPerHour) * HOUR;
		if (eta < window.resetsAt) projectedFullAt = eta;
	}
	const insight: WindowInsight = {
		key,
		label,
		usedPercent: window ? window.usedPercent : null,
		resetsAt: window ? window.resetsAt : windowStart !== null && key === 'fiveHour' ? windowStart + span : null,
		windowStart,
		stale: window !== undefined && receivedAt !== undefined && now - receivedAt > STALE_AFTER_MS,
		localCost,
		localTokens,
		localPrompts,
		costPerHour: elapsedHours ? localCost / elapsedHours : null,
		pctPerHour,
		projectedFullAt,
		elapsedFraction:
			windowStart !== null && (window || key === 'fiveHour') ? Math.min(1, Math.max(0, (now - windowStart) / span)) : null,
	};
	if (window?.usedUsd !== undefined) insight.usedUsd = window.usedUsd;
	if (window?.limitUsd !== undefined) insight.limitUsd = window.limitUsd;
	if (window?.period !== undefined) insight.period = window.period;
	return insight;
}

export function aggregate(input: AggregateInput): DashboardModel {
	const { now, prices } = input;
	const proj = (key: string) => (key ? (input.projectPath?.(key) ?? key) : '');
	const all: Priced[] = [];
	for (const record of input.records) {
		const cost = prices.cost(record);
		all.push({ record, cost: cost ?? 0, priced: cost !== null, savings: prices.cacheSavings(record) });
	}
	all.sort((a, b) => a.record.ts - b.record.ts);
	const allPrompts = [...input.prompts].sort((a, b) => a.ts - b.ts);

	const earliest = all.length ? all[0].record.ts : now;
	const start = rangeStart(input.range, now);
	const effectiveStart = start ?? startOfDay(earliest);
	const inRange = all.filter(p => p.record.ts >= effectiveStart);
	const promptsInRange = allPrompts.filter(p => p.ts >= effectiveStart);

	let previous: Totals | null = null;
	if (start !== null) {
		const length = now - start;
		const prevStart = start - length;
		previous = totalsFor(
			all.filter(p => p.record.ts >= prevStart && p.record.ts < start),
			allPrompts.filter(p => p.ts >= prevStart && p.ts < start),
		);
	}

	const kind = bucketKind(input.range, effectiveStart, now);
	const series = buildSeries(inRange, promptsInRange, kind, effectiveStart, now);
	const breakdown = {
		model: buildBreakdown(inRange, series, kind, r => modelLabel(r.model), byTotalWithOther),
		effort: buildBreakdown(inRange, series, kind, r => r.effort || 'not set', byEffortLevel),
		modelEffort: buildBreakdown(
			inRange,
			series,
			kind,
			r => `${modelLabel(r.model)}${GROUP_SEPARATOR}${r.effort || 'not set'}`,
			groups => byTotalWithOther(groups, MAX_COMBINED_GROUPS),
		),
	};

	const modelMap = new Map<string, ModelRow>();
	const projectMap = new Map<string, ProjectRow & { sessionSet: Set<string> }>();
	const sessionMap = new Map<string, SessionRow & { modelSet: Set<string> }>();
	const toolMap = new Map<string, number>();
	const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
	let rangeCost = 0;
	for (const item of inRange) {
		const r = item.record;
		const tokens = tokensOf(r);
		rangeCost += item.cost;
		const label = modelLabel(r.model);
		const m = modelMap.get(label) ?? { model: label, cost: 0, tokens: 0, output: 0, calls: 0, share: 0, priced: item.priced };
		m.cost += item.cost;
		m.tokens += tokens;
		m.output += r.output;
		m.calls += 1;
		m.priced = m.priced && item.priced;
		modelMap.set(label, m);

		const pKey = r.project || '(unknown)';
		const p = projectMap.get(pKey) ?? {
			project: proj(r.project) || pKey,
			name: projectName(proj(r.project)),
			cost: 0,
			tokens: 0,
			prompts: 0,
			sessions: 0,
			lastActive: 0,
			sessionSet: new Set<string>(),
		};
		p.cost += item.cost;
		p.tokens += tokens;
		p.lastActive = Math.max(p.lastActive, r.ts);
		p.sessionSet.add(r.sessionId);
		projectMap.set(pKey, p);

		const s = sessionMap.get(r.sessionId) ?? {
			sessionId: r.sessionId,
			title: input.title(r.sessionId) ?? '',
			project: proj(r.project),
			start: r.ts,
			end: r.ts,
			cost: 0,
			tokens: 0,
			prompts: 0,
			calls: 0,
			subagentCost: 0,
			models: [],
			file: input.sessionFile(r.sessionId),
			modelSet: new Set<string>(),
		};
		s.cost += item.cost;
		s.tokens += tokens;
		s.calls += 1;
		s.start = Math.min(s.start, r.ts);
		s.end = Math.max(s.end, r.ts);
		if (r.sidechain) s.subagentCost += item.cost;
		s.modelSet.add(label);
		if (!s.project && r.project) s.project = proj(r.project);
		sessionMap.set(r.sessionId, s);

		for (const tool of r.tools) toolMap.set(tool, (toolMap.get(tool) ?? 0) + 1);
		const d = new Date(r.ts);
		heatmap[(d.getDay() + 6) % 7][d.getHours()] += item.cost;
	}

	for (const prompt of promptsInRange) {
		const s = sessionMap.get(prompt.sessionId);
		if (s) s.prompts += 1;
		const p = projectMap.get(prompt.project || '(unknown)');
		if (p) p.prompts += 1;
	}

	const assigned = assignToPrompts(inRange, promptsInRange);
	const promptRows: PromptRow[] = promptsInRange
		.slice(-input.historyLimit)
		.reverse()
		.map(prompt => {
			const items = assigned.get(prompt.uuid) ?? [];
			const models = new Set<string>();
			const row: PromptRow = {
				uuid: prompt.uuid,
				ts: prompt.ts,
				text: prompt.text,
				sessionId: prompt.sessionId,
				project: projectName(proj(prompt.project)),
				models: [],
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				calls: 0,
				tools: 0,
				file: prompt.file,
			};
			for (const { record: r, cost } of items) {
				row.input += r.input;
				row.output += r.output;
				row.cacheRead += r.cacheRead;
				row.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
				row.cost += cost;
				row.calls += 1;
				row.tools += r.tools.length;
				models.add(modelLabel(r.model));
			}
			row.models = [...models];
			return row;
		});

	const models = [...modelMap.values()]
		.map(m => ({ ...m, share: rangeCost > 0 ? m.cost / rangeCost : 0 }))
		.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
	const projects = [...projectMap.values()]
		.map(({ sessionSet, ...p }) => ({ ...p, sessions: sessionSet.size }))
		.sort((a, b) => b.cost - a.cost);
	const sessions = [...sessionMap.values()]
		.map(({ modelSet, ...s }) => ({ ...s, models: [...modelSet] }))
		.sort((a, b) => b.end - a.end);
	const heatmapMax = Math.max(0, ...heatmap.flat());

	const fiveFallback = currentLocalBlock(
		all.map(p => p.record.ts),
		now,
	);
	const rate = input.rate;
	const windows: WindowInsight[] = [
		windowInsight('fiveHour', '5-Hour', FIVE_HOURS, rate?.fiveHour, fiveFallback, rate?.receivedAt, all, allPrompts, input.history, now),
		windowInsight('sevenDay', 'Weekly', SEVEN_DAYS, rate?.sevenDay, now - SEVEN_DAYS, rate?.receivedAt, all, allPrompts, input.history, now),
	];
	if (rate?.spend) {
		const span = rate.spend.period === 'daily' ? DAY : rate.spend.period === 'weekly' ? SEVEN_DAYS : 30 * DAY;
		windows.push(windowInsight('spend', 'Spend Limit', span, rate.spend, null, rate.receivedAt, all, allPrompts, input.history, now));
	}

	const todayStart = startOfDay(now);
	const today = { cost: 0, tokens: 0, prompts: allPrompts.filter(p => p.ts >= todayStart).length };
	const monthDate = new Date(now);
	monthDate.setDate(1);
	monthDate.setHours(0, 0, 0, 0);
	const month = { cost: 0, start: monthDate.getTime() };
	for (const { record, cost } of all) {
		if (record.ts >= todayStart) {
			today.cost += cost;
			today.tokens += tokensOf(record);
		}
		if (record.ts >= month.start) month.cost += cost;
	}
	const planValue =
		input.planMonthlyPrice > 0
			? { monthlyPrice: input.planMonthlyPrice, monthCost: month.cost, multiple: month.cost / input.planMonthlyPrice }
			: null;

	return {
		generatedAt: now,
		range: input.range,
		rangeStart: effectiveStart,
		totals: totalsFor(inRange, promptsInRange),
		previous,
		series,
		bucket: kind,
		models,
		projects,
		sessions,
		prompts: promptRows,
		tools: [...toolMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
		heatmap,
		breakdown,
		heatmapMax,
		windows,
		live: input.live,
		today,
		month,
		planValue,
		bridge: input.bridge,
		scan: { ...input.scan, records: all.length, prompts: allPrompts.length },
	};
}
