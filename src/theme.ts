// Dashboard appearance: base theme, chart palette and colour overrides. Pure (no vscode import) so it is unit tested.
import { safeColor, validateColor } from './levels';

export type ThemeName = 'vscode' | 'dark' | 'light' | 'highContrast';
export type PaletteName = 'default' | 'colorBlindSafe' | 'cool' | 'warm' | 'vivid' | 'custom';

export const THEME_NAMES: ThemeName[] = ['vscode', 'dark', 'light', 'highContrast'];
export const PALETTE_NAMES: PaletteName[] = ['default', 'colorBlindSafe', 'cool', 'warm', 'vivid', 'custom'];

/** The colours a user can override. Each is a #rrggbb string. */
export const TOKEN_KEYS = ['accent', 'marker', 'background', 'surface', 'text', 'mutedText', 'border'] as const;
export type TokenKey = (typeof TOKEN_KEYS)[number];
export type ThemeTokens = Partial<Record<TokenKey, string>>;

/** Series colours: 10 for single-dimension charts, 12 for model × effort pairs, where neighbours must differ clearly. */
export interface Palette {
	series: string[];
	contrast: string[];
}

export const SERIES_COUNT = 10;
export const CONTRAST_COUNT = 12;

// "vscode" follows the editor theme (no forced colours). The others fix every surface and text colour.
export const THEMES: Record<Exclude<ThemeName, 'vscode'>, Required<ThemeTokens> & { scheme: 'dark' | 'light' }> = {
	dark: { scheme: 'dark', background: '#17171a', surface: '#202024', text: '#e8e8ea', mutedText: '#a1a1aa', border: '#35353c', accent: '#d97757', marker: '#a45de3' },
	light: { scheme: 'light', background: '#f6f4f1', surface: '#ffffff', text: '#1d1c1a', mutedText: '#625f5a', border: '#d8d3cb', accent: '#c2573a', marker: '#7c3aed' },
	highContrast: { scheme: 'dark', background: '#000000', surface: '#0b0b0b', text: '#ffffff', mutedText: '#e0e0e0', border: '#9a9a9a', accent: '#ffb000', marker: '#00e5ff' },
};

const pad = (colors: string[], to: number): string[] => Array.from({ length: to }, (_, i) => colors[i % colors.length]);

export const PALETTES: Record<Exclude<PaletteName, 'custom'>, Palette> = {
	default: {
		series: ['#d97757', '#3fbca8', '#a45de3', '#3794ff', '#e8a23a', '#e05d9e', '#7cc36a', '#8b9bb4', '#c9a227', '#5ac8e0'],
		contrast: ['#e8684a', '#3794ff', '#f2c14e', '#3fbca8', '#c86dd7', '#7cc36a', '#ff9f43', '#5ac8e0', '#e05d9e', '#b8e986', '#9aa5b8', '#c0392b'],
	},
	// Okabe-Ito: distinguishable with the common forms of colour-vision deficiency.
	colorBlindSafe: {
		series: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999', '#44aa99', '#882255'],
		contrast: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999', '#44aa99', '#882255', '#332288', '#88ccee'],
	},
	cool: {
		series: ['#3794ff', '#3fbca8', '#a45de3', '#5ac8e0', '#7c8cf8', '#2f9e8f', '#8b9bb4', '#4f6bed', '#9b7fe6', '#38b2ac'],
		contrast: pad(['#3794ff', '#3fbca8', '#a45de3', '#5ac8e0', '#7c8cf8', '#2f9e8f', '#8b9bb4', '#4f6bed', '#9b7fe6', '#38b2ac', '#6ee7b7', '#c4b5fd'], CONTRAST_COUNT),
	},
	warm: {
		series: ['#d97757', '#e8a23a', '#e05d9e', '#c9a227', '#ff9f43', '#c0392b', '#e8684a', '#b8860b', '#f2c14e', '#d4577a'],
		contrast: pad(['#d97757', '#e8a23a', '#e05d9e', '#c9a227', '#ff9f43', '#c0392b', '#e8684a', '#b8860b', '#f2c14e', '#d4577a', '#ff7f6e', '#a8431f'], CONTRAST_COUNT),
	},
	vivid: {
		series: ['#ffb000', '#00e5ff', '#ff3b30', '#34c759', '#ff2d92', '#5e5ce6', '#ffd60a', '#64d2ff', '#ff9f0a', '#bf5af2'],
		contrast: pad(['#ffb000', '#00e5ff', '#ff3b30', '#34c759', '#ff2d92', '#5e5ce6', '#ffd60a', '#64d2ff', '#ff9f0a', '#bf5af2', '#30d158', '#ff6482'], CONTRAST_COUNT),
	},
};

export interface RawAppearance {
	theme?: unknown;
	chartPalette?: unknown;
	customChartColors?: unknown;
	colors?: unknown;
}

export interface EffectiveTheme {
	name: ThemeName;
	paletteName: PaletteName;
	/** Overrides applied on top of the base theme; absent keys keep the editor theme / stylesheet default. */
	tokens: ThemeTokens;
	palette: string[];
	contrast: string[];
	/** True when the theme fixes the surface and text colours instead of following VS Code. */
	forced: boolean;
	scheme: 'dark' | 'light' | null;
	/** Plain-language problems, such as unreadable text. Shown when saving and in the dashboard. */
	warnings: string[];
}

function hexToRgb(hex: string): [number, number, number] {
	const h = safeColor(hex, '');
	if (!h) return [0, 0, 0];
	const n = parseInt(h.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(v => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. Body text needs at least 4.5. */
export function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const MIN_TEXT_CONTRAST = 4.5;

/** Keeps only valid hex values for known token keys. */
export function cleanOverrides(input: unknown): ThemeTokens {
	const out: ThemeTokens = {};
	if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
	for (const key of TOKEN_KEYS) {
		const value = (input as Record<string, unknown>)[key];
		if (typeof value === 'string' && validateColor(value) && value !== '') out[key] = safeColor(value, '');
	}
	return out;
}

/** Up to ten valid hex colours, in order; invalid entries are dropped. */
export function cleanChartColors(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input
		.map(v => (typeof v === 'string' && validateColor(v) && v !== '' ? safeColor(v, '') : ''))
		.filter(Boolean)
		.slice(0, SERIES_COUNT);
}

export function resolveTheme(raw: RawAppearance): EffectiveTheme {
	const name = THEME_NAMES.includes(raw.theme as ThemeName) ? (raw.theme as ThemeName) : 'vscode';
	const paletteName = PALETTE_NAMES.includes(raw.chartPalette as PaletteName) ? (raw.chartPalette as PaletteName) : 'default';
	const base = name === 'vscode' ? undefined : THEMES[name];
	const tokens: ThemeTokens = {};
	if (base) for (const key of TOKEN_KEYS) tokens[key] = base[key];
	Object.assign(tokens, cleanOverrides(raw.colors));

	let palette: string[];
	let contrast: string[];
	const custom = cleanChartColors(raw.customChartColors);
	if (paletteName === 'custom' && custom.length) {
		// Missing slots fall back to the default palette, so a short custom list still colours every series.
		palette = Array.from({ length: SERIES_COUNT }, (_, i) => custom[i] ?? PALETTES.default.series[i]);
		contrast = Array.from({ length: CONTRAST_COUNT }, (_, i) => palette[i % SERIES_COUNT]);
	} else {
		const preset = PALETTES[paletteName === 'custom' ? 'default' : paletteName];
		palette = [...preset.series];
		contrast = [...preset.contrast];
	}

	const warnings: string[] = [];
	if (tokens.text && tokens.background) {
		const ratio = contrastRatio(tokens.text, tokens.background);
		if (ratio < MIN_TEXT_CONTRAST) warnings.push(`Text on background has a contrast of ${ratio.toFixed(1)}:1; ${MIN_TEXT_CONTRAST}:1 or more is easier to read.`);
	}
	if (tokens.mutedText && tokens.background) {
		const ratio = contrastRatio(tokens.mutedText, tokens.background);
		if (ratio < 3) warnings.push(`Muted text on background has a contrast of ${ratio.toFixed(1)}:1; it may be hard to read.`);
	}
	if (tokens.text && tokens.surface) {
		const ratio = contrastRatio(tokens.text, tokens.surface);
		if (ratio < MIN_TEXT_CONTRAST) warnings.push(`Text on cards has a contrast of ${ratio.toFixed(1)}:1; ${MIN_TEXT_CONTRAST}:1 or more is easier to read.`);
	}
	if (tokens.background && tokens.surface && contrastRatio(tokens.background, tokens.surface) < 1.05 && tokens.border && contrastRatio(tokens.border, tokens.surface) < 1.3) {
		warnings.push('Cards are almost the same colour as the background and the border is faint, so card edges will be hard to see.');
	}

	return { name, paletteName, tokens, palette, contrast, forced: Boolean(base), scheme: base ? base.scheme : null, warnings };
}
