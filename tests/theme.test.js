const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTheme, contrastRatio, cleanOverrides, cleanChartColors, THEMES, PALETTES, THEME_NAMES, PALETTE_NAMES, TOKEN_KEYS } = require('../out/theme');

test('contrast ratio matches the WCAG reference values', () => {
	assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
	assert.equal(contrastRatio('#ffffff', '#ffffff').toFixed(2), '1.00');
	assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), '4.48');
	assert.equal(contrastRatio('#767676', '#ffffff').toFixed(2), '4.54');
	assert.equal(contrastRatio('#ffffff', '#000000'), contrastRatio('#000000', '#ffffff'), 'order does not matter');
});

test('the default theme follows VS Code and changes nothing', () => {
	const t = resolveTheme({});
	assert.equal(t.name, 'vscode');
	assert.equal(t.forced, false);
	assert.equal(t.scheme, null);
	assert.deepEqual(t.tokens, {});
	assert.deepEqual(t.palette, PALETTES.default.series);
	assert.deepEqual(t.warnings, []);
});

test('every built-in theme is readable: text >= 7:1, muted text >= 4.5:1, with visible cards and borders', () => {
	for (const name of Object.keys(THEMES)) {
		const t = THEMES[name];
		assert.ok(contrastRatio(t.text, t.background) >= 7, `${name}: text on background ${contrastRatio(t.text, t.background).toFixed(1)}`);
		assert.ok(contrastRatio(t.text, t.surface) >= 7, `${name}: text on cards`);
		assert.ok(contrastRatio(t.mutedText, t.background) >= 4.5, `${name}: muted text ${contrastRatio(t.mutedText, t.background).toFixed(1)}`);
		assert.ok(contrastRatio(t.mutedText, t.surface) >= 4.5, `${name}: muted text on cards`);
		assert.ok(contrastRatio(t.border, t.surface) >= 1.2, `${name}: border visible`);
		assert.deepEqual(resolveTheme({ theme: name }).warnings, [], `${name} has no warnings`);
	}
	for (const name of THEME_NAMES.filter(n => n !== 'vscode')) assert.equal(resolveTheme({ theme: name }).forced, true);
});

test('themes set the colour scheme so native controls match', () => {
	assert.equal(resolveTheme({ theme: 'dark' }).scheme, 'dark');
	assert.equal(resolveTheme({ theme: 'light' }).scheme, 'light');
	assert.equal(resolveTheme({ theme: 'highContrast' }).scheme, 'dark');
});

test('overrides layer on top of a theme, and only valid hex colours are kept', () => {
	const t = resolveTheme({ theme: 'dark', colors: { accent: '#3FB950', text: 'red', background: '#000', marker: '#fff; background:url(x)', bogus: '#123456' } });
	assert.equal(t.tokens.accent, '#3fb950');
	assert.equal(t.tokens.background, '#000000', 'short hex is expanded');
	assert.equal(t.tokens.text, THEMES.dark.text, 'invalid override ignored, theme value kept');
	assert.equal(t.tokens.marker, THEMES.dark.marker);
	assert.ok(!('bogus' in t.tokens));
	assert.deepEqual(Object.keys(cleanOverrides({ accent: '#abc', nope: '#fff' })), ['accent']);
	assert.deepEqual(cleanOverrides('x'), {});
	assert.deepEqual(cleanOverrides([1]), {});
	assert.equal(TOKEN_KEYS.length, 7);
});

test('overrides on the follow-VS-Code theme stay partial', () => {
	const t = resolveTheme({ colors: { accent: '#00ff00' } });
	assert.deepEqual(t.tokens, { accent: '#00ff00' });
	assert.equal(t.forced, false);
});

test('unreadable combinations produce plain-language warnings', () => {
	const bad = resolveTheme({ theme: 'dark', colors: { text: '#333333' } });
	assert.ok(bad.warnings.some(w => /Text on background/.test(w)), bad.warnings.join('|'));
	assert.ok(bad.warnings.some(w => /Text on cards/.test(w)));
	const faint = resolveTheme({ theme: 'dark', colors: { mutedText: '#202024' } });
	assert.ok(faint.warnings.some(w => /Muted text/.test(w)));
	const flat = resolveTheme({ theme: 'dark', colors: { surface: '#17171a', border: '#17171a' } });
	assert.ok(flat.warnings.some(w => /card edges/.test(w)));
	assert.deepEqual(resolveTheme({ colors: { text: '#333333' } }).warnings, [], 'no background known, so nothing to compare');
});

test('chart palettes: every preset has 10 series and 12 contrast colours, all distinct enough', () => {
	for (const name of PALETTE_NAMES.filter(n => n !== 'custom')) {
		const t = resolveTheme({ chartPalette: name });
		assert.equal(t.palette.length, 10, name);
		assert.equal(t.contrast.length, 12, name);
		for (const c of [...t.palette, ...t.contrast]) assert.match(c, /^#[0-9a-f]{6}$/, `${name}: ${c}`);
		assert.equal(new Set(t.palette).size, 10, `${name} series colours are unique`);
	}
	assert.deepEqual(resolveTheme({ chartPalette: 'colorBlindSafe' }).palette.slice(0, 3), ['#0072b2', '#e69f00', '#009e73']);
});

test('adjacent series colours in every preset are visibly different', () => {
	const dist = (a, b) => {
		const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
		const [x, y] = [p(a), p(b)];
		return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
	};
	for (const name of ['default', 'colorBlindSafe', 'cool', 'warm', 'vivid']) {
		const { palette } = resolveTheme({ chartPalette: name });
		for (let i = 1; i < palette.length; i++) assert.ok(dist(palette[i - 1], palette[i]) > 45, `${name}: ${palette[i - 1]} vs ${palette[i]}`);
	}
});

test('custom palette: valid colours first, remaining slots fall back to the default palette', () => {
	const t = resolveTheme({ chartPalette: 'custom', customChartColors: ['#111111', 'nope', '#222', '#333333'] });
	assert.deepEqual(t.palette.slice(0, 3), ['#111111', '#222222', '#333333']);
	assert.equal(t.palette[3], PALETTES.default.series[3]);
	assert.equal(t.contrast.length, 12);
	assert.deepEqual(cleanChartColors(Array(20).fill('#abcdef')).length, 10, 'capped at ten');
	assert.deepEqual(resolveTheme({ chartPalette: 'custom', customChartColors: [] }).palette, PALETTES.default.series, 'empty custom list uses the default');
	assert.deepEqual(resolveTheme({ chartPalette: 'custom', customChartColors: 'x' }).palette, PALETTES.default.series);
});

test('unknown theme or palette names fall back safely', () => {
	const t = resolveTheme({ theme: 'neon', chartPalette: 'rainbow' });
	assert.equal(t.name, 'vscode');
	assert.equal(t.paletteName, 'default');
});
