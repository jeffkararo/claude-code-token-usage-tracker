const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEntry, promptText, TranscriptStore, encodeProjectDir } = require('../out/transcripts');

const ts = '2026-10-14T19:20:27.970Z';
const human = (text, extra = {}) => ({ type: 'user', uuid: 'u1', sessionId: 's1', cwd: 'P:\\proj', timestamp: ts, origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const assistant = (id, content, usage = {}, extra = {}) => ({
	type: 'assistant',
	uuid: `${id}-${Math.random()}`,
	sessionId: 's1',
	cwd: 'P:\\proj',
	timestamp: ts,
	message: {
		id,
		model: 'claude-opus-5-5',
		content,
		usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 }, ...usage },
	},
	...extra,
});

test('keeps typed prompts and drops tool results, meta and injected context', () => {
	assert.equal(promptText(human('Fix the bug')), 'Fix the bug');
	assert.equal(promptText(human('<system-reminder>hidden</system-reminder>Real ask')), 'Real ask');
	assert.equal(promptText(human('<system-reminder>only</system-reminder>')), undefined);
	assert.equal(promptText(human('x', { isMeta: true })), undefined);
	assert.equal(promptText(human('x', { origin: { kind: 'hook' } })), undefined);
	assert.equal(promptText({ ...human('x'), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }), undefined);
	assert.equal(promptText(human('<command-name>/review</command-name><command-args>src</command-args>')), '/review src');
	assert.equal(promptText({ ...human(''), message: { role: 'user', content: 'plain string prompt' } }), 'plain string prompt');
});

test('parses assistant usage with cache-write TTL split and tool names', () => {
	const parsed = parseEntry(assistant('msg_1', [{ type: 'tool_use', name: 'Bash' }]), '/p/s1.jsonl').usage;
	assert.equal(parsed.cacheWrite1h, 50);
	assert.equal(parsed.cacheWrite5m, 0);
	assert.deepEqual(parsed.tools, ['Bash']);
	assert.equal(parsed.sidechain, false);
	assert.equal(parsed.effort, undefined);
	assert.equal(parseEntry(assistant('msg_e', [], {}, { effort: 'high', perTurnEffort: 'xhigh' }), '/p/s1.jsonl').usage.effort, 'xhigh');
	assert.equal(parseEntry(assistant('msg_f', [], {}, { effort: 'medium' }), '/p/s1.jsonl').usage.effort, 'medium');
	const legacy = parseEntry(assistant('msg_2', [], { cache_creation: undefined }), '/p/s1.jsonl').usage;
	assert.equal(legacy.cacheWrite5m, 50);
	assert.equal(parseEntry({ ...assistant('x', []), message: { ...assistant('x', []).message, model: '<synthetic>' } }, 'f').usage, undefined);
});

test('reads titles from ai-title entries', () => {
	assert.deepEqual(parseEntry({ type: 'ai-title', aiTitle: 'Tracker work', sessionId: 's1' }, 'f').title, { sessionId: 's1', title: 'Tracker work' });
});

test('dedupes content-block lines that share a message id', () => {
	const store = new TranscriptStore('/projects');
	const lines = [
		assistant('msg_1', [{ type: 'thinking' }], { output_tokens: 5 }),
		assistant('msg_1', [{ type: 'tool_use', name: 'Read' }], { output_tokens: 40 }),
		assistant('msg_1', [{ type: 'tool_use', name: 'Edit' }], { output_tokens: 40 }),
	];
	store.ingest(lines.map(l => JSON.stringify(l)).join('\n'), '/projects/P--proj/s1.jsonl');
	assert.equal(store.records.size, 1);
	const rec = store.records.get('msg_1');
	assert.equal(rec.output, 40);
	assert.deepEqual(rec.tools, ['Read', 'Edit']);
});

test('tails appended bytes, holds partial lines and resolves the project path', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-'));
	const dir = path.join(root, encodeProjectDir('P:\\proj'));
	fs.mkdirSync(dir);
	const file = path.join(dir, 's1.jsonl');
	const store = new TranscriptStore(root);
	const first = JSON.stringify(human('hello', { cwd: 'p:\\proj\\sub' })) + '\n' + JSON.stringify(human('second', { uuid: 'u2', cwd: 'P:\\proj' }));
	fs.writeFileSync(file, first.slice(0, first.length - 10));
	assert.equal(await store.refresh(), true);
	assert.equal(store.prompts.size, 1, 'partial second line waits');
	fs.appendFileSync(file, first.slice(first.length - 10) + '\n' + JSON.stringify(assistant('msg_9', [])) + '\n');
	assert.equal(await store.refresh(), true);
	assert.equal(store.prompts.size, 2);
	assert.equal(store.records.size, 1);
	assert.equal(await store.refresh(), false, 'unchanged file is skipped');
	const key = store.records.get('msg_9').project;
	assert.equal(store.projectPath(key), 'P:\\proj');
	assert.equal(store.sessionFiles.get('s1'), file);
	fs.rmSync(root, { recursive: true, force: true });
});

test('marks subagent transcripts as sidechain and keeps their prompts out of history', () => {
	const store = new TranscriptStore('/projects');
	const file = '/projects/P--proj/s1/subagents/agent-1.jsonl';
	store.ingest([JSON.stringify(human('task for agent')), JSON.stringify(assistant('msg_sub', []))].join('\n'), file);
	assert.equal(store.prompts.size, 0);
	assert.equal(store.records.get('msg_sub').sidechain, true);
});
