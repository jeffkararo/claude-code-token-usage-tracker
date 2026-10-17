const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'resources', 'bridge', 'statusline-bridge.js');
const resets = Math.round(Date.now() / 1000) + 3600;
const payload = {
	session_id: 'abc-123',
	transcript_path: '/tmp/abc.jsonl',
	model: { id: 'claude-opus-5-5', display_name: 'Opus' },
	cost: { total_cost_usd: 1.234 },
	context_window: { used_percentage: 42, context_window_size: 1000000 },
	prompt_cache: { warm: true, hit_ratio: 0.9 },
	rate_limits: { five_hour: { used_percentage: 23.5, resets_at: resets }, seven_day: { used_percentage: 41.2, resets_at: resets + 86400 } },
};

function runBridge(dir, input) {
	return spawnSync(process.execPath, [script], { input, env: { ...process.env, CLAUDE_TRACKER_DIR: dir }, encoding: 'utf8' });
}

test('saves session and rate-limit snapshots and prints a default line', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-bridge-'));
	const result = runBridge(dir, JSON.stringify(payload));
	assert.equal(result.status, 0);
	assert.equal(result.stdout, '[Opus] · ctx 42% · 5h 24% · 7d 41% · $1.23');
	const session = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'abc-123.json'), 'utf8'));
	assert.equal(session.contextWindow.used_percentage, 42);
	const limits = JSON.parse(fs.readFileSync(path.join(dir, 'rate-limits.json'), 'utf8'));
	assert.equal(limits.rateLimits.five_hour.used_percentage, 23.5);
	// History only grows when a value changes.
	runBridge(dir, JSON.stringify(payload));
	runBridge(dir, JSON.stringify({ ...payload, rate_limits: { ...payload.rate_limits, five_hour: { used_percentage: 30, resets_at: resets } } }));
	const history = fs.readFileSync(path.join(dir, 'rate-history.jsonl'), 'utf8').trim().split('\n');
	assert.equal(history.length, 2);
	assert.equal(JSON.parse(history[1]).five, 30);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('runs the chained statusLine command with the same input', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-bridge-'));
	const echo = path.join(dir, 'echo.js');
	fs.writeFileSync(echo, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('chained:'+JSON.parse(d).session_id))");
	fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ chain: `"${process.execPath}" "${echo}"` }));
	const result = runBridge(dir, JSON.stringify(payload));
	assert.equal(result.stdout, 'chained:abc-123');
	assert.ok(fs.existsSync(path.join(dir, 'sessions', 'abc-123.json')));
	fs.rmSync(dir, { recursive: true, force: true });
});

test('survives invalid input without failing the status line', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-bridge-'));
	const result = runBridge(dir, 'not json');
	assert.equal(result.status, 0);
	assert.equal(result.stdout, 'Claude Code');
	fs.rmSync(dir, { recursive: true, force: true });
});
