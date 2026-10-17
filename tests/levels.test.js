const test = require('node:test');
const assert = require('node:assert/strict');
const { levelFor, worstLevel, statusText, formatResetShort, normalizeThresholds, safeColor, validateColor, DEFAULT_COLORS } = require('../out/levels');

const now = new Date(2026, 9, 14, 16, 30).getTime();
const win = over => ({
	key: 'fiveHour',
	label: '5-Hour',
	usedPercent: 36,
	resetsAt: new Date(2026, 9, 14, 19, 0).getTime(),
	windowStart: null,
	stale: false,
	localCost: 0,
	localTokens: 0,
	localPrompts: 0,
	costPerHour: null,
	pctPerHour: null,
	projectedFullAt: null,
	elapsedFraction: null,
	...over,
});
const options = { quotaDisplay: 'remaining', showResets: true, showCost: true };

test('levels use percent used with warning at 75 and critical at 90', () => {
	assert.equal(levelFor(0, 75, 90), 'normal');
	assert.equal(levelFor(74.9, 75, 90), 'normal');
	assert.equal(levelFor(75, 75, 90), 'warning');
	assert.equal(levelFor(89, 75, 90), 'warning');
	assert.equal(levelFor(90, 75, 90), 'critical');
	assert.equal(levelFor(100, 75, 90), 'critical');
	assert.equal(worstLevel(['normal', 'critical', 'warning']), 'critical');
	assert.equal(worstLevel(['normal', 'warning']), 'warning');
	assert.equal(worstLevel([]), 'normal');
});

test('custom thresholds move the boundaries', () => {
	assert.equal(levelFor(50, 50, 60), 'warning');
	assert.equal(levelFor(60, 50, 60), 'critical');
	assert.equal(levelFor(49, 50, 60), 'normal');
});

test('thresholds are clamped and critical never falls below warning', () => {
	assert.deepEqual(normalizeThresholds(75, 90), { warning: 75, critical: 90 });
	assert.deepEqual(normalizeThresholds(95, 80), { warning: 95, critical: 95 });
	assert.deepEqual(normalizeThresholds(-10, 500), { warning: 0, critical: 100 });
	assert.deepEqual(normalizeThresholds('abc', undefined), { warning: 75, critical: 90 });
	assert.deepEqual(normalizeThresholds('60', '70'), { warning: 60, critical: 70 });
});

test('only hex colours reach the dashboard', () => {
	assert.equal(safeColor('#E8A23A', 'x'), '#e8a23a');
	assert.equal(safeColor('#abc', 'x'), '#aabbcc');
	assert.equal(safeColor('', DEFAULT_COLORS.warning), DEFAULT_COLORS.warning);
	assert.equal(safeColor('red', '#111111'), '#111111');
	assert.equal(safeColor('#fff; background: url(//evil)', '#111111'), '#111111');
	assert.equal(safeColor(undefined, '#111111'), '#111111');
	assert.equal(validateColor(''), true);
	assert.equal(validateColor('#3fbca8'), true);
	assert.equal(validateColor('rgb(0,0,0)'), false);
	assert.equal(validateColor(null), false);
});

test('builds one combined status-bar entry with resets and cost', () => {
	const week = win({ key: 'sevenDay', label: 'Weekly', usedPercent: 3, resetsAt: new Date(2026, 9, 16, 3, 0).getTime() });
	const text = statusText([win({}), week], 12.345, now, options);
	assert.equal(text, `$(pulse) 5H: 64% / Rst: ${formatResetShort(win({}).resetsAt, now)} · Weekly: 97% / Rst: ${formatResetShort(week.resetsAt, now)} · $12.35`);
	assert.ok(!formatResetShort(new Date(2026, 9, 14, 19, 0).getTime(), now).includes(','), 'today shows only the time');
	assert.ok(formatResetShort(week.resetsAt, now).includes(','), 'another day shows the date');
});

test('shows used percentages instead of remaining when asked', () => {
	const week = win({ key: 'sevenDay', label: 'Weekly', usedPercent: 3 });
	const text = statusText([win({}), week], 1, now, { quotaDisplay: 'used', showResets: false, showCost: false });
	assert.equal(text, '$(pulse) 5H: 36% · Weekly: 3%');
	assert.equal(statusText([win({})], 1, now, { ...options, showResets: false, showCost: false }), '$(pulse) 5H: 64%');
});

test('marks stale values and respects hidden resets and cost', () => {
	const text = statusText([win({ stale: true })], 1, now, { quotaDisplay: 'used', showResets: false, showCost: false });
	assert.equal(text, '$(pulse) 5H: 36%~');
});

test('falls back to cost only when no limits are known', () => {
	const text = statusText([win({ usedPercent: null, resetsAt: null }), win({ key: 'sevenDay', usedPercent: null, resetsAt: null })], 4.2, now, options);
	assert.equal(text, '$(pulse) Claude $4.20');
});
