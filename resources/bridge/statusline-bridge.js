#!/usr/bin/env node
'use strict';
// Claude Code statusline bridge for Usage Tracker for Claude Code.
//
// Claude Code pipes a JSON snapshot of the session (model, context window,
// cost, prompt cache and, for Pro/Max subscribers, rate limits) to the
// configured statusLine command. This script saves that snapshot under
// ~/.claude/claude-code-tracker/ for the VS Code extension to read, then
// either runs the user's previous statusLine command with the same input or
// prints a compact default line. It must stay fast and never throw.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BRIDGE_VERSION = 1;
const HISTORY_MAX_BYTES = 512 * 1024;

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const dataDir = process.env.CLAUDE_TRACKER_DIR || path.join(claudeDir, 'claude-code-tracker');

function readStdin() {
	return new Promise(resolve => {
		let raw = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', chunk => (raw += chunk));
		process.stdin.on('end', () => resolve(raw));
		process.stdin.on('error', () => resolve(raw));
	});
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

function writeAtomic(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, file);
	} catch {
		// A reader holding the file open on Windows can block the rename.
		try {
			fs.writeFileSync(file, text);
		} catch {
			/* give up quietly */
		}
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* already gone */
		}
	}
}

function safeId(value) {
	return String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
}

function windowPct(limits, key) {
	const value = limits && limits[key] && limits[key].used_percentage;
	return typeof value === 'number' ? Math.round(value * 10) / 10 : null;
}

function record(data) {
	const now = Date.now();
	const sessionsDir = path.join(dataDir, 'sessions');
	fs.mkdirSync(sessionsDir, { recursive: true });

	const snapshot = {
		bridgeVersion: BRIDGE_VERSION,
		receivedAt: now,
		sessionId: data.session_id,
		sessionName: data.session_name,
		transcriptPath: data.transcript_path,
		version: data.version,
		model: data.model,
		workspace: data.workspace ? { currentDir: data.workspace.current_dir, projectDir: data.workspace.project_dir } : undefined,
		cost: data.cost,
		contextWindow: data.context_window,
		promptCache: data.prompt_cache,
		effort: data.effort,
		fastMode: data.fast_mode,
		rateLimits: data.rate_limits,
	};
	writeAtomic(path.join(sessionsDir, `${safeId(data.session_id)}.json`), JSON.stringify(snapshot));

	const limits = data.rate_limits;
	if (!limits || typeof limits !== 'object') return;
	writeAtomic(
		path.join(dataDir, 'rate-limits.json'),
		JSON.stringify({ bridgeVersion: BRIDGE_VERSION, receivedAt: now, sessionId: data.session_id, rateLimits: limits }),
	);

	// Append to the history only when a window value changes, so burn rate can be projected.
	const five = windowPct(limits, 'five_hour');
	const week = windowPct(limits, 'seven_day');
	const spend = windowPct(limits, 'spend_limit');
	const statePath = path.join(dataDir, 'rate-history.state.json');
	const last = readJson(statePath) || {};
	if (last.five === five && last.week === week && last.spend === spend) return;
	const historyPath = path.join(dataDir, 'rate-history.jsonl');
	const entry = {
		t: now,
		five,
		fiveReset: limits.five_hour && limits.five_hour.resets_at,
		week,
		weekReset: limits.seven_day && limits.seven_day.resets_at,
		spend,
	};
	try {
		const size = fs.existsSync(historyPath) ? fs.statSync(historyPath).size : 0;
		if (size > HISTORY_MAX_BYTES) {
			const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
			writeAtomic(historyPath, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n');
		}
		fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n');
		writeAtomic(statePath, JSON.stringify({ five, week, spend }));
	} catch {
		/* history is best-effort */
	}
}

function defaultLine(data) {
	if (!data) return 'Claude Code';
	const parts = [];
	const model = data.model && (data.model.display_name || data.model.id);
	if (model) parts.push(`[${model}]`);
	const ctx = data.context_window && data.context_window.used_percentage;
	if (typeof ctx === 'number') parts.push(`ctx ${Math.round(ctx)}%`);
	const five = windowPct(data.rate_limits, 'five_hour');
	const week = windowPct(data.rate_limits, 'seven_day');
	if (five !== null) parts.push(`5h ${Math.round(five)}%`);
	if (week !== null) parts.push(`7d ${Math.round(week)}%`);
	const cost = data.cost && data.cost.total_cost_usd;
	if (typeof cost === 'number') parts.push(`$${cost.toFixed(2)}`);
	return parts.join(' · ');
}

async function main() {
	const raw = await readStdin();
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		data = undefined;
	}
	if (data) {
		try {
			record(data);
		} catch {
			/* never break the user's status line */
		}
	}

	const config = readJson(path.join(dataDir, 'bridge.json')) || {};
	if (typeof config.chain === 'string' && config.chain.trim()) {
		const child = spawn(config.chain, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
		child.on('error', () => {
			process.stdout.write(defaultLine(data));
			process.exit(0);
		});
		child.on('exit', code => process.exit(code === null ? 0 : code));
		child.stdin.on('error', () => undefined);
		child.stdin.end(raw);
		return;
	}
	process.stdout.write(defaultLine(data));
}

main();
