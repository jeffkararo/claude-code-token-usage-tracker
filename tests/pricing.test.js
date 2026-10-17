const test = require('node:test');
const assert = require('node:assert/strict');
const { PriceBook, normalizeModel, modelLabel } = require('../out/pricing');

const record = over => ({
	id: 'm',
	ts: 0,
	sessionId: 's',
	project: '',
	model: 'claude-opus-5-5',
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite5m: 0,
	cacheWrite1h: 0,
	thinking: 0,
	webSearches: 0,
	webFetches: 0,
	fast: false,
	sidechain: false,
	tools: [],
	file: '',
	...over,
});

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('normalizes provider prefixes, dates and context suffixes', () => {
	assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
	assert.equal(normalizeModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5');
	assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
	assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
});

test('labels models for display', () => {
	assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
	assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
	assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
	assert.equal(modelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5');
});

test('prices every token class including both cache-write TTLs', () => {
	const book = new PriceBook();
	// Opus 5.5: $4 in, $20 out, $0.20 cache read, writes 1.25x / 2x input.
	const cost = book.cost(record({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }));
	close(cost, 4 + 20 + 0.2 + 5 + 8);
});

test('distinguishes Opus 5 from Opus 5.5 and old Opus 4 from 4.5+', () => {
	const book = new PriceBook();
	assert.equal(book.lookup('claude-opus-5').input, 5);
	assert.equal(book.lookup('claude-opus-5-5').input, 4);
	assert.equal(book.lookup('claude-opus-4-8').input, 5);
	assert.equal(book.lookup('claude-opus-4-1-20250805').input, 15);
	assert.equal(book.lookup('claude-fable-5-1').cacheRead, 0.25);
	assert.equal(book.lookup('claude-fable-5').cacheRead, 1);
});

test('applies fast-mode multiplier and web search fees', () => {
	const book = new PriceBook();
	close(book.cost(record({ output: 1e6, fast: true })), 40);
	close(book.cost(record({ webSearches: 3 })), 0.03);
});

test('switches Haiku 5.5 to long-context rates above 100K prompt tokens', () => {
	const book = new PriceBook();
	close(book.cost(record({ model: 'claude-haiku-5-5', input: 50_000, output: 1e6 })), 0.005 + 0.5);
	close(book.cost(record({ model: 'claude-haiku-5-5', input: 150_000, output: 1e6 })), 0.075 + 2.5);
});

test('returns null for unknown models and honours overrides', () => {
	assert.equal(new PriceBook().cost(record({ model: 'mystery-model', input: 10 })), null);
	const book = new PriceBook({ 'mystery-model': { input: 1, output: 2 }, 'claude-opus-5-5': { output: 30 } });
	close(book.cost(record({ model: 'mystery-model', input: 1e6, cacheRead: 1e6 })), 1 + 0.1);
	close(book.cost(record({ output: 1e6 })), 30);
});

test('cache savings compare reads against fresh input', () => {
	close(new PriceBook().cacheSavings(record({ cacheRead: 1e6 })), 4 - 0.2);
});
