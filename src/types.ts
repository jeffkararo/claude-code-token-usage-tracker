// Shared data shapes. Nothing in here imports vscode, so the parsing and
// aggregation modules can be unit tested with plain Node.

/** One API response from a Claude Code transcript, deduplicated by message id. */
export interface UsageRecord {
	id: string;
	ts: number;
	sessionId: string;
	project: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	thinking: number;
	webSearches: number;
	webFetches: number;
	fast: boolean;
	/** Reasoning effort the turn ran at (low … max), when Claude Code recorded one. */
	effort?: string;
	sidechain: boolean;
	tools: string[];
	file: string;
}

/** A prompt typed by a person (not tool results or injected context). */
export interface PromptRecord {
	uuid: string;
	ts: number;
	sessionId: string;
	project: string;
	text: string;
	gitBranch?: string;
	file: string;
}

export interface SessionMeta {
	sessionId: string;
	title?: string;
	file?: string;
}

export interface ModelPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m?: number;
	cacheWrite1h?: number;
	/** Multiplier applied to every token rate when usage.speed is "fast". */
	fastMultiplier?: number;
	/** Requests whose prompt exceeds `threshold` tokens bill at these rates instead. */
	longContext?: { threshold: number; input: number; output: number; cacheRead?: number };
}

export interface RateWindow {
	usedPercent: number;
	resetsAt: number;
}

export interface SpendWindow extends RateWindow {
	usedUsd?: number;
	limitUsd?: number;
	period?: string;
}

export interface BridgeRateLimits {
	receivedAt: number;
	fiveHour?: RateWindow;
	sevenDay?: RateWindow;
	spend?: SpendWindow;
}

export interface BridgeHistoryPoint {
	t: number;
	five: number | null;
	fiveReset?: number;
	week: number | null;
	weekReset?: number;
	spend?: number | null;
}

export interface LiveSession {
	sessionId: string;
	name?: string;
	cwd?: string;
	status?: string;
	updatedAt?: number;
	entrypoint?: string;
	model?: string;
	contextPercent?: number;
	contextSize?: number;
	contextTokens?: number;
	sessionCostUsd?: number;
	linesAdded?: number;
	linesRemoved?: number;
	cacheHitRatio?: number;
	cacheWarm?: boolean;
	cacheExpiresAt?: number;
	cacheTtl?: string;
	cacheMisses?: number;
	effort?: string;
	fastMode?: boolean;
	transcriptPath?: string;
	bridgeAt?: number;
}

export type RangeKey = '1d' | '24h' | '7d' | '14d' | '21d' | '30d' | '90d' | '365d' | 'all';

export type BreakdownMetric = 'total' | 'fresh' | 'output' | 'thinking';

/** Token usage for one model or one reasoning-effort level, with a per-bucket series for each metric. */
export interface BreakdownGroup {
	name: string;
	calls: number;
	total: number;
	fresh: number;
	cacheRead: number;
	output: number;
	thinking: number;
	cost: number;
	series: Record<BreakdownMetric, number[]>;
}

export interface Totals {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	thinking: number;
	calls: number;
	prompts: number;
	sessions: number;
	webSearches: number;
	toolCalls: number;
	cacheHitRate: number | null;
	cacheSavings: number;
	subagentCost: number;
	unpricedCalls: number;
}

export interface SeriesPoint {
	label: string;
	start: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	prompts: number;
	calls: number;
	cacheHitRate: number | null;
}

export interface ModelRow {
	model: string;
	cost: number;
	tokens: number;
	output: number;
	calls: number;
	share: number;
	priced: boolean;
}

export interface ProjectRow {
	project: string;
	name: string;
	cost: number;
	tokens: number;
	prompts: number;
	sessions: number;
	lastActive: number;
}

export interface SessionRow {
	sessionId: string;
	title: string;
	project: string;
	start: number;
	end: number;
	cost: number;
	tokens: number;
	prompts: number;
	calls: number;
	subagentCost: number;
	models: string[];
	file?: string;
}

export interface PromptRow {
	uuid: string;
	ts: number;
	text: string;
	sessionId: string;
	project: string;
	models: string[];
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	calls: number;
	tools: number;
	file: string;
}

export interface WindowInsight {
	key: 'fiveHour' | 'sevenDay' | 'spend';
	label: string;
	usedPercent: number | null;
	resetsAt: number | null;
	windowStart: number | null;
	stale: boolean;
	/** Local API-equivalent cost and tokens inside the window. */
	localCost: number;
	localTokens: number;
	localPrompts: number;
	costPerHour: number | null;
	/** Percentage points consumed per hour, from bridge history. */
	pctPerHour: number | null;
	/** Projected epoch ms when the window hits 100%, if before reset. */
	projectedFullAt: number | null;
	/** Fraction of the window's duration that has elapsed. */
	elapsedFraction: number | null;
	usedUsd?: number;
	limitUsd?: number;
	period?: string;
}

export interface DashboardModel {
	generatedAt: number;
	range: RangeKey;
	rangeStart: number | null;
	totals: Totals;
	previous: Totals | null;
	series: SeriesPoint[];
	bucket: 'hour' | 'day' | 'week';
	models: ModelRow[];
	projects: ProjectRow[];
	sessions: SessionRow[];
	prompts: PromptRow[];
	tools: { name: string; count: number }[];
	breakdown: { model: BreakdownGroup[]; effort: BreakdownGroup[]; modelEffort: BreakdownGroup[] };
	heatmap: number[][];
	heatmapMax: number;
	windows: WindowInsight[];
	live: LiveSession[];
	today: { cost: number; tokens: number; prompts: number };
	month: { cost: number; start: number };
	planValue: { monthlyPrice: number; monthCost: number; multiple: number } | null;
	bridge: { connected: boolean; receiving: boolean; lastAt: number | null; command?: string };
	scan: { files: number; records: number; prompts: number; durationMs: number; claudeDir: string };
}
