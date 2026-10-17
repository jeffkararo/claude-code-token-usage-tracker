import { promises as fsp } from 'fs';
import * as path from 'path';
import { PromptRecord, UsageRecord } from './types';

const MAX_PROMPT_CHARS = 400;
const INJECTED_BLOCK = /<(system-reminder|ide_[a-z_]+|local-command-[a-z]+|command-message|command-args)>[\s\S]*?<\/\1>/g;

export interface ParsedLine {
	usage?: UsageRecord;
	prompt?: PromptRecord;
	title?: { sessionId: string; title: string };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function num(value: any): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Turns a raw user message into display text, or undefined when it was not typed by a person. */
export function promptText(entry: any): string | undefined {
	if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.toolUseResult !== undefined) return undefined;
	if (entry.origin && entry.origin.kind && entry.origin.kind !== 'human') return undefined;
	const content = entry.message?.content;
	let text = '';
	if (typeof content === 'string') {
		text = content;
	} else if (Array.isArray(content)) {
		if (content.some((block: any) => block?.type === 'tool_result')) return undefined;
		text = content
			.filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
			.map((block: any) => block.text)
			.join('\n');
	}
	if (!text) return undefined;
	const command = /<command-name>([^<]+)<\/command-name>/.exec(text);
	if (command) {
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
		text = `${command[1].trim()} ${args ? args[1].trim() : ''}`;
	}
	if (/^\s*<local-command-stdout>|^Caveat: The messages below/.test(text)) return undefined;
	text = text.replace(INJECTED_BLOCK, '').replace(/<command-name>[^<]*<\/command-name>/g, '').replace(/\s+/g, ' ').trim();
	if (!text) return undefined;
	return text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS - 1) + '…' : text;
}

/** Parses one transcript JSON object. Pure, so it is unit tested directly. */
export function parseEntry(entry: any, file: string): ParsedLine {
	if (!entry || typeof entry !== 'object') return {};
	const sessionId: string = entry.sessionId || path.basename(file, '.jsonl');
	if (entry.type === 'ai-title' && entry.aiTitle) return { title: { sessionId, title: String(entry.aiTitle) } };
	if (entry.type === 'summary' && entry.summary && entry.sessionId) return { title: { sessionId, title: String(entry.summary) } };

	const ts = Date.parse(entry.timestamp);
	if (!Number.isFinite(ts)) return {};
	const project: string = entry.cwd || '';

	if (entry.type === 'assistant') {
		const message = entry.message;
		const usage = message?.usage;
		if (!usage || !message.model || message.model === '<synthetic>') return {};
		const cacheCreation = usage.cache_creation || {};
		const totalWrite = num(usage.cache_creation_input_tokens);
		let write1h = num(cacheCreation.ephemeral_1h_input_tokens);
		let write5m = num(cacheCreation.ephemeral_5m_input_tokens);
		if (write1h + write5m === 0 && totalWrite > 0) write5m = totalWrite;
		if (write1h + write5m > totalWrite && totalWrite > 0) write1h = Math.max(0, totalWrite - write5m);
		const tools = Array.isArray(message.content)
			? message.content.filter((block: any) => block?.type === 'tool_use' && block.name).map((block: any) => String(block.name))
			: [];
		const id = message.id ? `${message.id}` : `${entry.requestId || entry.uuid}`;
		return {
			usage: {
				id,
				ts,
				sessionId,
				project,
				model: String(message.model),
				input: num(usage.input_tokens),
				output: num(usage.output_tokens),
				cacheRead: num(usage.cache_read_input_tokens),
				cacheWrite5m: write5m,
				cacheWrite1h: write1h,
				thinking: num(usage.output_tokens_details?.thinking_tokens),
				webSearches: num(usage.server_tool_use?.web_search_requests),
				webFetches: num(usage.server_tool_use?.web_fetch_requests),
				fast: usage.speed === 'fast',
				effort: typeof entry.perTurnEffort === 'string' ? entry.perTurnEffort : typeof entry.effort === 'string' ? entry.effort : undefined,
				sidechain: Boolean(entry.isSidechain) || /[\\/]subagents[\\/]/.test(file),
				tools,
				file,
			},
		};
	}

	const text = promptText(entry);
	if (text && !/[\\/]subagents[\\/]/.test(file)) {
		return {
			prompt: { uuid: String(entry.uuid || `${sessionId}:${ts}`), ts, sessionId, project, text, gitBranch: entry.gitBranch, file },
		};
	}
	return {};
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Upper-cases a Windows drive letter so `p:\x` and `P:\x` are one project. */
export function normalizeCwd(cwd: string): string {
	return cwd.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

/** Claude Code's folder name for a project: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

interface FileState {
	size: number;
	mtimeMs: number;
	offset: number;
	remainder: Buffer;
}

/** Merges a repeated record. Claude Code writes one line per content block with the same message id. */
function mergeRecord(existing: UsageRecord, next: UsageRecord): UsageRecord {
	const tools = next.tools.length ? existing.tools.concat(next.tools) : existing.tools;
	return {
		...existing,
		output: Math.max(existing.output, next.output),
		thinking: Math.max(existing.thinking, next.thinking),
		webSearches: Math.max(existing.webSearches, next.webSearches),
		webFetches: Math.max(existing.webFetches, next.webFetches),
		tools: existing.file === next.file ? tools : existing.tools,
		sidechain: existing.sidechain && next.sidechain,
	};
}

/** Incrementally reads every transcript under <claudeDir>/projects, tailing appended bytes only. */
export class TranscriptStore {
	readonly records = new Map<string, UsageRecord>();
	readonly prompts = new Map<string, PromptRecord>();
	readonly titles = new Map<string, string>();
	readonly customTitles = new Map<string, string>();
	readonly sessionFiles = new Map<string, string>();
	private readonly projectPaths = new Map<string, string>();
	private readonly files = new Map<string, FileState>();
	private readonly seenLineIds = new Map<string, Set<string>>();

	constructor(private projectsDir: string) {}

	setProjectsDir(dir: string): void {
		if (dir === this.projectsDir) return;
		this.projectsDir = dir;
		this.reset();
	}

	reset(): void {
		this.records.clear();
		this.prompts.clear();
		this.titles.clear();
		this.customTitles.clear();
		this.sessionFiles.clear();
		this.projectPaths.clear();
		this.files.clear();
		this.seenLineIds.clear();
	}

	get fileCount(): number {
		return this.files.size;
	}

	title(sessionId: string): string | undefined {
		return this.customTitles.get(sessionId) ?? this.titles.get(sessionId);
	}

	/** Scans for new and changed files. Returns true when anything changed. */
	async refresh(): Promise<boolean> {
		let entries: string[];
		try {
			entries = (await fsp.readdir(this.projectsDir, { recursive: true })) as string[];
		} catch {
			return false;
		}
		let changed = false;
		for (const relative of entries) {
			const full = path.join(this.projectsDir, relative);
			if (relative.endsWith('.jsonl')) {
				if (await this.readFile(full)) changed = true;
			} else if (path.basename(relative) === 'custom-title.json') {
				if (await this.readCustomTitle(full)) changed = true;
			}
		}
		return changed;
	}

	private async readCustomTitle(file: string): Promise<boolean> {
		try {
			const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
			const sessionId = path.basename(path.dirname(file));
			if (typeof parsed.customTitle === 'string' && this.customTitles.get(sessionId) !== parsed.customTitle) {
				this.customTitles.set(sessionId, parsed.customTitle);
				return true;
			}
		} catch {
			/* ignore unreadable title files */
		}
		return false;
	}

	private async readFile(file: string): Promise<boolean> {
		let stat;
		try {
			stat = await fsp.stat(file);
		} catch {
			return false;
		}
		let state = this.files.get(file);
		if (state && stat.size === state.size && stat.mtimeMs === state.mtimeMs) return false;
		if (!state || stat.size < state.offset) {
			state = { size: 0, mtimeMs: 0, offset: 0, remainder: Buffer.alloc(0) };
			this.files.set(file, state);
		}
		const length = stat.size - state.offset;
		if (length <= 0) {
			state.size = stat.size;
			state.mtimeMs = stat.mtimeMs;
			return false;
		}
		const handle = await fsp.open(file, 'r');
		let chunk: Buffer;
		try {
			chunk = Buffer.alloc(length);
			const { bytesRead } = await handle.read(chunk, 0, length, state.offset);
			chunk = chunk.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
		state.offset += chunk.length;
		state.size = stat.size;
		state.mtimeMs = stat.mtimeMs;

		const data = state.remainder.length ? Buffer.concat([state.remainder, chunk]) : chunk;
		const lastNewline = data.lastIndexOf(0x0a);
		if (lastNewline === -1) {
			state.remainder = data;
			return false;
		}
		state.remainder = Buffer.from(data.subarray(lastNewline + 1));
		this.ingest(data.subarray(0, lastNewline).toString('utf8'), file);
		return true;
	}

	/** Display path for a project key (the transcript folder name). */
	projectPath(key: string): string {
		return this.projectPaths.get(key) ?? key;
	}

	/** Claude Code stores each project's transcripts in a folder named after the launch directory. */
	private projectKey(file: string): string {
		const relative = path.relative(this.projectsDir, file);
		const first = relative.split(/[\\/]/)[0];
		return first && first !== '..' && !relative.startsWith('..') && first !== path.basename(file) ? first : '';
	}

	private learnProjectPath(key: string, cwd: string): void {
		if (!key || !cwd) return;
		const normalized = normalizeCwd(cwd);
		const current = this.projectPaths.get(key);
		// Prefer the cwd whose encoding matches the folder: that is the directory the session was launched from.
		if (encodeProjectDir(normalized).toLowerCase() === key.toLowerCase()) {
			if (current !== normalized) this.projectPaths.set(key, normalized);
		} else if (current === undefined) {
			this.projectPaths.set(key, normalized);
		}
	}

	/** Parses newline-delimited JSON text from `file`. Public for tests. */
	ingest(text: string, file: string): void {
		const isSubagent = /[\\/]subagents[\\/]/.test(file);
		const key = this.projectKey(file);
		let seen = this.seenLineIds.get(file);
		if (!seen) {
			seen = new Set();
			this.seenLineIds.set(file, seen);
		}
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const parsed = parseEntry(entry, file);
			if (parsed.title) this.titles.set(parsed.title.sessionId, parsed.title.title);
			const record = parsed.prompt ?? parsed.usage;
			if (record && key) {
				this.learnProjectPath(key, record.project);
				record.project = key;
			} else if (record) {
				record.project = normalizeCwd(record.project);
			}
			if (parsed.prompt) {
				this.prompts.set(parsed.prompt.uuid, parsed.prompt);
				if (!isSubagent && !this.sessionFiles.has(parsed.prompt.sessionId)) this.sessionFiles.set(parsed.prompt.sessionId, file);
			}
			if (parsed.usage) {
				const usage = parsed.usage;
				// The same content block can be logged twice; its line uuid identifies it.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const lineId = (entry as any).uuid as string | undefined;
				if (lineId && seen.has(lineId)) continue;
				if (lineId) seen.add(lineId);
				const existing = this.records.get(usage.id);
				this.records.set(usage.id, existing ? mergeRecord(existing, usage) : usage);
				if (!isSubagent && !this.sessionFiles.has(usage.sessionId)) this.sessionFiles.set(usage.sessionId, file);
			}
		}
	}
}
