import { ModelPrice, UsageRecord } from './types';

// List prices in USD per million tokens, Anthropic first-party API rates.
// Cache writes default to 1.25x input (5-minute TTL) and 2x input (1-hour TTL).
// Costs shown by the extension are API-equivalent estimates: subscription
// plans are not billed per token. Users can override any entry in settings.
const BUILT_IN: { match: RegExp; price: ModelPrice }[] = [
	{ match: /^claude-(fable|mythos)-5-1/, price: { input: 10, output: 50, cacheRead: 0.25 } },
	{ match: /^claude-(fable|mythos)-5/, price: { input: 10, output: 50, cacheRead: 1 } },
	{ match: /^claude-opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2, fastMultiplier: 2 } },
	{ match: /^claude-opus-5(?!-\d)/, price: { input: 5, output: 25, cacheRead: 0.5, fastMultiplier: 2 } },
	{ match: /^claude-opus-4-[5-9]/, price: { input: 5, output: 25, cacheRead: 0.5 } },
	{ match: /^claude-opus-4/, price: { input: 15, output: 75, cacheRead: 1.5 } },
	{ match: /^claude-3-opus/, price: { input: 15, output: 75, cacheRead: 1.5 } },
	{ match: /^claude-sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2 } },
	{ match: /^claude-sonnet-4|^claude-3-[57]-sonnet/, price: { input: 3, output: 15, cacheRead: 0.3 } },
	{
		match: /^claude-haiku-5-5/,
		price: {
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
		},
	},
	{ match: /^claude-haiku-4/, price: { input: 1, output: 5, cacheRead: 0.1 } },
	{ match: /^claude-3-5-haiku/, price: { input: 0.8, output: 4, cacheRead: 0.08 } },
	{ match: /^claude-3-haiku/, price: { input: 0.25, output: 1.25, cacheRead: 0.03 } },
];

/** Web search is billed per search on top of tokens. */
export const WEB_SEARCH_USD = 10 / 1000;

/** Strip provider prefixes, date snapshots and context suffixes from a model id. */
export function normalizeModel(model: string): string {
	let id = String(model || '').trim().toLowerCase();
	id = id.replace(/\[[^\]]*\]$/, '');
	id = id.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '');
	id = id.replace(/@\d{8}$/, '').replace(/-v\d+(?::\d+)?$/, '').replace(/-\d{8}$/, '');
	return id;
}

/** Human label such as "Opus 5.5" for a model id. */
export function modelLabel(model: string): string {
	const id = normalizeModel(model);
	const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
	if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
	const legacy = /^claude-(\d)(?:-(\d))?-([a-z]+)/.exec(id);
	if (legacy) return `${legacy[3][0].toUpperCase()}${legacy[3].slice(1)} ${legacy[1]}${legacy[2] ? '.' + legacy[2] : ''}`;
	return id || 'unknown';
}

export class PriceBook {
	private readonly cache = new Map<string, ModelPrice | null>();

	constructor(private readonly overrides: Record<string, Partial<ModelPrice>> = {}) {}

	lookup(model: string): ModelPrice | null {
		const id = normalizeModel(model);
		if (this.cache.has(id)) return this.cache.get(id) ?? null;
		const builtIn = BUILT_IN.find(entry => entry.match.test(id))?.price ?? null;
		const overrideKey = Object.keys(this.overrides)
			.filter(key => id.startsWith(normalizeModel(key)))
			.sort((a, b) => b.length - a.length)[0];
		let price: ModelPrice | null = builtIn;
		if (overrideKey) {
			const o = this.overrides[overrideKey];
			if (typeof o?.input === 'number' && typeof o?.output === 'number') {
				price = { ...builtIn, ...o, cacheRead: o.cacheRead ?? builtIn?.cacheRead ?? o.input * 0.1 } as ModelPrice;
			} else if (builtIn) {
				price = { ...builtIn, ...o } as ModelPrice;
			}
		}
		this.cache.set(id, price);
		return price;
	}

	/** API-equivalent cost of one record, or null when the model has no known price. */
	cost(record: UsageRecord): number | null {
		const price = this.lookup(record.model);
		if (!price) return null;
		const promptTokens = record.input + record.cacheRead + record.cacheWrite5m + record.cacheWrite1h;
		let input = price.input;
		let output = price.output;
		let cacheRead = price.cacheRead;
		if (price.longContext && promptTokens > price.longContext.threshold) {
			input = price.longContext.input;
			output = price.longContext.output;
			cacheRead = price.longContext.cacheRead ?? input * 0.1;
		}
		const write5m = price.cacheWrite5m ?? input * 1.25;
		const write1h = price.cacheWrite1h ?? input * 2;
		const multiplier = record.fast ? (price.fastMultiplier ?? 1) : 1;
		const tokens =
			record.input * input +
			record.output * output +
			record.cacheRead * cacheRead +
			record.cacheWrite5m * write5m +
			record.cacheWrite1h * write1h;
		return (tokens * multiplier) / 1_000_000 + record.webSearches * WEB_SEARCH_USD;
	}

	/** What the cache reads would have cost if they had been billed as fresh input. */
	cacheSavings(record: UsageRecord): number {
		const price = this.lookup(record.model);
		if (!price || record.cacheRead === 0) return 0;
		const multiplier = record.fast ? (price.fastMultiplier ?? 1) : 1;
		return (record.cacheRead * (price.input - price.cacheRead) * multiplier) / 1_000_000;
	}
}
