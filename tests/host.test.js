// Drives out/extension.js against a stub vscode whose setting defaults come from the real package.json, and checks status-bar colours,
// thresholds, validation, reset-to-default and used/remaining wording. Runs as a script; a non-zero exit fails the test.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ext = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const defaults = Object.fromEntries(Object.entries(pkg.contributes.configuration.properties).map(([k, v]) => [k.replace('claudeTracker.', ''), v.default]));

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-host-'));
fs.mkdirSync(path.join(claudeDir, 'projects'));
const dataDir = path.join(claudeDir, 'claude-code-tracker');
fs.mkdirSync(dataDir);
const writeLimits = (five, week) => {
	const reset = Math.round(Date.now() / 1000) + 3 * 3600;
	fs.writeFileSync(path.join(dataDir, 'rate-limits.json'), JSON.stringify({ receivedAt: Date.now(), rateLimits: { five_hour: { used_percentage: five, resets_at: reset }, seven_day: { used_percentage: week, resets_at: reset + 86400 } } }));
};

const store = { claudeDir, limitsPollMinutes: 0 };
const log = [];
const commands = new Map();
const items = [];
let provider;
const memento = () => { const m = new Map(); return { get: k => m.get(k), update: async (k, v) => void m.set(k, v) }; };
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } }
const disposable = { dispose() {} };
const vscode = {
	StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 }, MarkdownString,
	ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class { constructor(id) { this.id = id; } }, TerminalProfile: class {},
	extensions: { getExtension: () => undefined },
	Uri: { file: p => ({ fsPath: p }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
	RelativePattern: class {},
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		createStatusBarItem: id => { const it = { id, show() {}, hide() {}, dispose() {} }; items.push(it); return it; },
		registerWebviewViewProvider: (_i, p) => { provider = p; return disposable; },
		registerTerminalProfileProvider: () => disposable,
		showInformationMessage: async m => void log.push('INFO ' + m), showWarningMessage: async m => void log.push('WARN ' + m), showErrorMessage: async m => void log.push('ERROR ' + m),
		setStatusBarMessage: () => disposable,
	},
	commands: { registerCommand: (id, fn) => { commands.set(id, fn); return disposable; }, executeCommand: async () => {} },
	workspace: {
		getConfiguration: () => ({
			get: (k, d) => (k in store ? store[k] : k in defaults ? defaults[k] : d),
			inspect: k => (k in defaults ? {} : undefined),
			update: async (k, v) => { if (v === undefined) delete store[k]; else store[k] = v; },
		}),
		onDidChangeConfiguration: () => disposable, createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} }), fs: { writeFile: async () => {} },
	},
	env: { clipboard: { writeText: async () => {} } },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };

const failures = [];
const check = (label, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : '')); if (!ok) failures.push(label); };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const { activate } = require(path.join(ext, 'out', 'extension.js'));
	const context = { subscriptions: [], extensionUri: { fsPath: ext }, globalState: memento(), workspaceState: memento(), globalStorageUri: { fsPath: path.join(claudeDir, 'gs') }, extension: { packageJSON: { version: pkg.version } } };
	const posted = [];
	const view = { visible: true, webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: u => u, postMessage: async m => void posted.push(m), onDidReceiveMessage: fn => { view.handler = fn; } }, onDidChangeVisibility() {}, onDidDispose() {} };
	const item = () => items[0];
	const state = () => `bg=${item().backgroundColor?.id ?? 'none'} color=${item().color?.id ?? item().color ?? 'default'}`;
	const refresh = async () => { await commands.get('claudeTracker.refresh')(); await wait(150); };
	const save = async values => { view.handler({ type: 'saveSettings', values }); await wait(150); };

	writeLimits(30, 10);
	activate(context);
	provider.resolveWebviewView(view);
	view.handler({ type: 'ready' });
	await wait(900);

	check('exactly one status-bar item', items.length === 1, String(items.length));
	check('normal level with defaults: theme colour, no background', !item().backgroundColor && !item().color, state());
	check('text shows remaining by default', /5H: 70% \/ Rst:/.test(item().text), item().text);

	await save({ normalColor: '#3fb950' }); await refresh();
	check('normal colour applies to status-bar text', item().color === '#3fb950' && !item().backgroundColor, state());

	writeLimits(78, 10); await refresh();
	check('78% used (>= 75): warning background (default highlight)', item().backgroundColor?.id === 'statusBarItem.warningBackground', state());
	writeLimits(93, 10); await refresh();
	check('93% used (>= 90): critical background', item().backgroundColor?.id === 'statusBarItem.errorBackground', state());

	await save({ statusBarHighlight: 'text' }); await refresh();
	check('text highlight: critical default colour #e5484d, no background', item().color === '#e5484d' && !item().backgroundColor, state());
	writeLimits(78, 10); await refresh();
	check('text highlight: warning default colour #e8a23a', item().color === '#e8a23a', state());
	await save({ warningColor: '#112233' }); await refresh();
	check('custom warning colour applies', item().color === '#112233', state());

	await save({ warningAtUsedPercent: 80 }); await refresh();
	check('raising warning to 80 makes 78% normal again (normal colour)', item().color === '#3fb950', state());
	await save({ warningAtUsedPercent: 50, criticalAtUsedPercent: 60 }); await refresh();
	check('custom thresholds 50/60: 78% is critical', item().color === '#e5484d', state());

	log.length = 0;
	await save({ warningAtUsedPercent: 95, criticalAtUsedPercent: 70 });
	check('inverted thresholds are rejected with a message', log.some(l => /^WARN .*critical \(70%\) must be at least warning \(95%\)/.test(l)), log.join(' | '));
	check('and the previous thresholds are kept', store.warningAtUsedPercent === 50 && store.criticalAtUsedPercent === 60, `${store.warningAtUsedPercent}/${store.criticalAtUsedPercent}`);
	log.length = 0;
	await save({ criticalColor: 'red', warningAtUsedPercent: 120 });
	check('non-hex colour and out-of-range threshold are rejected', log.some(l => /criticalColor must be a hex colour/.test(l)) && log.some(l => /warningAtUsedPercent must be a number from 0 to 100/.test(l)) && store.criticalColor === undefined && store.warningAtUsedPercent === 50, log.join(' | '));

	// a hand-edited settings.json with inverted values is corrected rather than breaking the levels
	store.warningAtUsedPercent = 95; store.criticalAtUsedPercent = 70; writeLimits(80, 10); await refresh();
	check('inverted values in settings.json: 80% is below the effective warning (95), so normal', item().color === '#3fb950', state());
	const effective = posted.at(-1).settings.effective;
	check('dashboard receives the corrected thresholds', effective.warning === 95 && effective.critical === 95, JSON.stringify(effective));
	store.warningAtUsedPercent = 75; store.criticalAtUsedPercent = 90;

	await save({ normalColor: null, warningColor: null, criticalColor: null }); await refresh();
	check('null resets the three colours to their defaults', !('normalColor' in store) && !('warningColor' in store) && !('criticalColor' in store), JSON.stringify(Object.keys(store)));
	check('after reset the dashboard gets default colours', (() => { const e = posted.at(-1).settings.effective; return e.normalColor === '' && e.warningColor === '#e8a23a' && e.criticalColor === '#e5484d'; })());

	await save({ quotaDisplay: 'used', statusBarHighlight: 'background' }); writeLimits(36, 41); await refresh();
	check('used mode: status text shows used percentages', /5H: 36% .*Weekly: 41%/.test(item().text), item().text);
	log.length = 0;
	writeLimits(30, 10); await refresh(); writeLimits(80, 10); await refresh();
	check('used mode: notification wording says used', log.some(l => /5-Hour window: 80% used/.test(l)), log.join(' | '));

	await save({ quotaDisplay: 'remaining' }); await refresh();
	check('back to remaining', /5H: 20% \/ Rst:/.test(item().text), item().text);
	check('tooltip lists the thresholds', /Warning at 75% used · critical at 90% used/.test(item().tooltip.value));

	// ---- appearance: theme, chart palette and colour overrides ----
	const lastSettings = () => posted.at(-1).settings;
	check('dashboard receives the preset catalogue', Boolean(lastSettings().catalog?.themes?.dark?.background) && Boolean(lastSettings().catalog?.palettes?.colorBlindSafe?.series), Object.keys(lastSettings().catalog || {}).join());
	check('defaults follow VS Code with the default palette', lastSettings().effective.theme.name === 'vscode' && lastSettings().effective.theme.forced === false && lastSettings().effective.theme.palette[0] === '#d97757');

	await save({ theme: 'dark' });
	check('saving a theme forces its colours', store.theme === 'dark' && lastSettings().effective.theme.forced === true && lastSettings().effective.theme.tokens.background === '#17171a', JSON.stringify(lastSettings().effective.theme.tokens));

	log.length = 0;
	await save({ theme: 'neon', chartPalette: 'rainbow' });
	check('unknown theme and palette names are rejected with a message', log.some(l => /theme must be one of/.test(l)) && log.some(l => /chartPalette must be one of/.test(l)) && store.theme === 'dark' && !('chartPalette' in store), log.join(' | '));

	log.length = 0;
	await save({ colors: { accent: '#00ff00', text: 'red', bogus: '#fff' } });
	check('only valid known colours are stored, and the rest are reported', JSON.stringify(store.colors) === '{"accent":"#00ff00"}' && log.some(l => /Ignored invalid colours: text, bogus/.test(l)), JSON.stringify(store.colors) + ' | ' + log.join(' | '));
	check('the dashboard gets the override on top of the theme', lastSettings().effective.theme.tokens.accent === '#00ff00' && lastSettings().effective.theme.tokens.text === '#e8e8ea');

	log.length = 0;
	await save({ colors: { accent: '#00ff00', text: '#333333' } });
	check('unreadable text triggers a contrast warning on save', log.some(l => /Text on background has a contrast of \d\.\d:1/.test(l)), log.join(' | '));

	log.length = 0;
	await save({ chartPalette: 'custom', customChartColors: ['#111111', 'x', '#222222'] });
	check('custom chart colours: invalid ones dropped, palette applied', JSON.stringify(store.customChartColors) === '["#111111","#222222"]' && lastSettings().effective.theme.palette[0] === '#111111' && lastSettings().effective.theme.palette[2] === '#a45de3' && log.some(l => /chart colours were invalid/.test(l)), JSON.stringify(store.customChartColors) + ' | ' + lastSettings().effective.theme.palette.slice(0, 3).join());

	await save({ chartPalette: 'colorBlindSafe' });
	check('a preset palette replaces the custom one', lastSettings().effective.theme.palette[0] === '#0072b2');

	await save({ theme: null, chartPalette: null, customChartColors: null, colors: null });
	check('null resets every appearance setting to its default', !['theme', 'chartPalette', 'customChartColors', 'colors'].some(k => k in store) && lastSettings().effective.theme.name === 'vscode' && lastSettings().effective.theme.palette[0] === '#d97757' && Object.keys(lastSettings().effective.theme.tokens).length === 0, JSON.stringify(Object.keys(store)));

	for (const d of context.subscriptions) d.dispose();
	fs.rmSync(claudeDir, { recursive: true, force: true });
	console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nall checks passed');
	process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
