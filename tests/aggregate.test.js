const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregate, burnRate, currentLocalBlock, rangeStart } = require('../out/aggregate');
const { PriceBook } = require('../out/pricing');
const { parseRateLimits } = require('../out/bridgeData');

const HOUR = 3600_000;
const now = new Date(2026, 9, 14, 15, 30).getTime();
let n = 0;
const rec = over => ({
	id: `m${n++}`,
	ts: now - HOUR,
	sessionId: 's1',
	project: 'P--proj',
	model: 'claude-opus-5-5',
	input: 0,
	output: 1000,
	cacheRead: 0,
	cacheWrite5m: 0,
	cacheWrite1h: 0,
	thinking: 0,
	webSearches: 0,
	webFetches: 0,
	fast: false,
	sidechain: false,
	tools: [],
	file: 'f',
	...over,
});
const prompt = over => ({ uuid: `p${n++}`, ts: now - HOUR, sessionId: 's1', project: 'P--proj', text: 'do it', file: 'f', ...over });

function run(records, prompts, extra = {}) {
	return aggregate({
		records,
		prompts,
		title: () => 'Session title',
		sessionFile: () => 'f',
		projectPath: key => (key === 'P--proj' ? 'P:\\proj' : key),
		prices: new PriceBook(),
		range: '7d',
		now,
		historyLimit: 100,
		history: [],
		live: [],
		planMonthlyPrice: 0,
		bridge: { connected: false, receiving: false, lastAt: null },
		scan: { files: 1, durationMs: 0, claudeDir: '/c' },
		...extra,
	});
}

test('assigns each API call to the latest earlier prompt in its session', () => {
	const p1 = prompt({ ts: now - 3 * HOUR, text: 'first' });
	const p2 = prompt({ ts: now - 2 * HOUR, text: 'second' });
	const model = run(
		[rec({ ts: now - 2.5 * HOUR }), rec({ ts: now - 1.5 * HOUR }), rec({ ts: now - 1.4 * HOUR, sidechain: true, tools: ['Task'] }), rec({ ts: now - HOUR, sessionId: 'other' })],
		[p1, p2],
	);
	const [second, first] = model.prompts;
	assert.equal(second.text, 'second');
	assert.equal(second.calls, 2);
	assert.equal(second.tools, 1);
	assert.equal(first.calls, 1);
	assert.equal(model.totals.calls, 4);
	assert.equal(model.totals.sessions, 2);
	assert.ok(model.totals.subagentCost > 0);
});

test('groups projects by key and shows the resolved path', () => {
	const model = run([rec({}), rec({})], [prompt({})]);
	assert.equal(model.projects.length, 1);
	assert.equal(model.projects[0].project, 'P:\\proj');
	assert.equal(model.projects[0].name, 'proj');
	assert.equal(model.projects[0].prompts, 1);
	assert.equal(model.prompts[0].project, 'proj');
});

test('excludes calls outside the range and compares with the previous period', () => {
	const model = run([rec({ ts: now - 10 * 24 * HOUR }), rec({})], []);
	assert.equal(model.totals.calls, 1);
	assert.equal(model.previous.calls, 1);
	assert.equal(model.series.length, 7);
	assert.equal(model.bucket, 'day');
	assert.equal(rangeStart('all', now), null);
});

test('supports rolling 24-hour and 2- and 3-week ranges', () => {
	assert.equal(rangeStart('24h', now), now - 24 * HOUR);
	assert.equal(rangeStart('14d', now), new Date(2026, 9, 1).getTime());
	assert.equal(rangeStart('21d', now), new Date(2026, 8, 24).getTime());
	const day = run([rec({ ts: now - 20 * HOUR }), rec({ ts: now - 30 * HOUR })], [], { range: '24h' });
	assert.equal(day.totals.calls, 1);
	assert.equal(day.bucket, 'hour');
	assert.equal(day.previous.calls, 1);
	assert.equal(run([rec({ ts: now - 20 * 24 * HOUR })], [], { range: '21d' }).totals.calls, 1);
	assert.equal(run([rec({ ts: now - 20 * 24 * HOUR })], [], { range: '14d' }).totals.calls, 0);
	assert.equal(run([], [], { range: '14d' }).series.length, 14);
});

test('breaks token usage down by model and by reasoning effort', () => {
	const model = run(
		[
			rec({ model: 'claude-opus-5-5', effort: 'high', output: 1000, thinking: 600, input: 10 }),
			rec({ model: 'claude-opus-5-5', effort: 'low', output: 500, thinking: 100 }),
			rec({ model: 'claude-sonnet-5-5', effort: 'max', output: 200, thinking: 150, ts: now - 2 * 24 * HOUR }),
			rec({ model: 'claude-haiku-4-5', output: 50, thinking: 0 }),
		],
		[],
	);
	const { model: byModel, effort: byEffort } = model.breakdown;
	assert.deepEqual(
		byModel.map(g => g.name),
		['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5'],
	);
	assert.equal(byModel[0].thinking, 700);
	assert.equal(byModel[0].fresh, 10);
	assert.deepEqual(
		byEffort.map(g => g.name),
		['low', 'high', 'max', 'not set'],
	);
	const max = byEffort.find(g => g.name === 'max');
	assert.equal(max.series.thinking.length, model.series.length);
	assert.equal(max.series.thinking.reduce((a, b) => a + b, 0), 150);
	assert.equal(max.series.output[model.series.length - 3], 200, 'lands in the bucket two days back');
});

test('combines model and effort when both are selected', () => {
	const model = run(
		[
			rec({ model: 'claude-opus-5-5', effort: 'high', output: 1000 }),
			rec({ model: 'claude-opus-5-5', effort: 'high', output: 500 }),
			rec({ model: 'claude-opus-5-5', effort: 'low', output: 300 }),
			rec({ model: 'claude-sonnet-5-5', output: 100 }),
		],
		[],
	);
	const combined = model.breakdown.modelEffort;
	assert.deepEqual(
		combined.map(g => [g.name, g.calls]),
		[
			['Opus 5.5 · high', 2],
			['Opus 5.5 · low', 1],
			['Sonnet 5.5 · not set', 1],
		],
	);
	assert.equal(combined.reduce((a, g) => a + g.output, 0), model.totals.output);
	assert.equal(model.windows[0].label, '5-Hour');
});

test('folds models beyond the eighth into Other', () => {
	const models = ['opus-5-5', 'opus-5', 'opus-4-8', 'opus-4-7', 'sonnet-5-5', 'sonnet-5', 'sonnet-4-6', 'haiku-5-5', 'haiku-4-5', 'fable-5-1'];
	const model = run(
		models.map((m, i) => rec({ model: `claude-${m}`, output: 1000 - i })),
		[],
	);
	const groups = model.breakdown.model;
	assert.equal(groups.length, 8);
	assert.equal(groups[7].name, 'Other');
	assert.equal(groups[7].calls, 3);
	assert.equal(groups.reduce((a, g) => a + g.output, 0), model.totals.output);
});

test('fills the weekday-by-hour heatmap with cost', () => {
	const model = run([rec({ ts: now - HOUR })], []);
	const d = new Date(now - HOUR);
	assert.ok(model.heatmap[(d.getDay() + 6) % 7][d.getHours()] > 0);
	assert.equal(model.heatmapMax, model.heatmap.flat().reduce((a, b) => Math.max(a, b), 0));
});

test('finds the current local 5-hour block on the hour of its first call', () => {
	const start = new Date(2026, 9, 14, 13, 17).getTime();
	const block = currentLocalBlock([start - 6 * HOUR, start, start + HOUR], now);
	assert.equal(block, new Date(2026, 9, 14, 13, 0).getTime());
	assert.equal(currentLocalBlock([now - 6 * HOUR], now), null);
});

test('projects when a window runs out from bridge history', () => {
	const history = [
		{ t: now - HOUR, five: 40, week: 10 },
		{ t: now - 30 * 60_000, five: 50, week: 10 },
		{ t: now, five: 60, week: 11 },
	];
	assert.equal(burnRate(history, 'five', now - 2 * HOUR, now), 20);
	const resets = Math.round((now + 3 * HOUR) / 1000);
	const rate = parseRateLimits({ five_hour: { used_percentage: 60, resets_at: resets }, seven_day: { used_percentage: 11, resets_at: resets + 86400 } }, now, now);
	const model = run([rec({})], [], { rate, history });
	const five = model.windows[0];
	assert.equal(five.usedPercent, 60);
	assert.equal(five.pctPerHour, 20);
	// 40 points left at 20 points/hour runs out in 2h, before the 3h reset.
	assert.equal(five.projectedFullAt, now + 2 * HOUR);
	assert.ok(Math.abs(five.elapsedFraction - 0.4) < 0.01);
});

test('drops rate-limit windows whose reset time has passed', () => {
	const past = Math.round((now - 60_000) / 1000);
	const rate = parseRateLimits({ five_hour: { used_percentage: 99, resets_at: past }, seven_day: { used_percentage: 5, resets_at: past + 7200 } }, now - HOUR, now);
	assert.equal(rate.fiveHour, undefined);
	assert.equal(rate.sevenDay.usedPercent, 5);
});

test('reports plan value when a monthly price is set', () => {
	const model = run([rec({ output: 1_000_000 })], [], { planMonthlyPrice: 10 });
	assert.equal(model.planValue.monthCost, 20);
	assert.equal(model.planValue.multiple, 2);
});
