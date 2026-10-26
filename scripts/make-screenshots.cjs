// Renders docs/images/*.png from made-up sample data. It builds a throwaway Claude config directory, runs the compiled extension
// (out/) against a stub vscode to get the real dashboard state, then photographs the real webview in headless Edge or Chrome.
// Nothing under ~/.claude is read or written. Run `npm run compile` first (the npm script does). No dependencies.
//   npm run screenshots                 # all shots, dark theme
//   BROWSER=<path to msedge/chrome> ...   # if no browser is found
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'images');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const defaults = Object.fromEntries(Object.entries(pkg.contributes.configuration.properties).map(([k, v]) => [k.replace('claudeTracker.', ''), v.default]));

// ---------- sample data ----------
let seed = 20261026;
const rand = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (lo, hi) => lo + rand() * (hi - lo);
const pick = list => list[Math.floor(rand() * list.length)];
const weighted = list => {
	let r = rand() * list.reduce((s, [, w]) => s + w, 0);
	for (const [value, w] of list) if ((r -= w) <= 0) return value;
	return list[0][0];
};
const hex = n => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const PROJECTS = [
	{ cwd: '/home/dev/acme-api', weight: 4, branch: 'main', prompts: ['Add cursor pagination to the /orders endpoint', 'Why does the invoice job time out on large accounts?', 'Write tests for the refund service', 'Replace the hand-rolled retry loop with a shared helper', 'Explain how the rate limiter picks its key', 'Fix the flaky webhook signature test', 'Add an index for the customer lookup query', 'Log a request id on every error response', 'Split the billing module into smaller files', 'Add a health check that covers the database', 'Summarise what changed in the auth middleware'] },
	{ cwd: '/home/dev/docs-site', weight: 2, branch: 'main', prompts: ['Rewrite the quick-start page for the new CLI', 'Find broken links in the guides folder', 'Add a dark-mode logo variant to the header', 'Generate the changelog page from the release notes', 'Make the search box reachable with a keyboard shortcut', 'Proofread the migration guide'] },
	{ cwd: '/home/dev/mobile-app', weight: 2, branch: 'feature/offline', prompts: ['Cache the feed so it opens offline', 'Reduce the cold-start time on Android', 'Fix the keyboard covering the comment box', 'Migrate the settings screen to the new navigation', 'Add a retry button to the upload error state', 'Why is the list janky on older phones?'] },
	{ cwd: '/home/dev/data-pipeline', weight: 1.5, branch: 'main', prompts: ['Backfill the events table for last month', 'Make the nightly job idempotent', 'Profile the slowest stage and suggest a fix', 'Add a schema check before the load step', 'Write a runbook for a failed backfill'] },
];
const MODELS = [
	['claude-opus-5-5', 4],
	['claude-sonnet-5-5', 4.5],
	['claude-haiku-5-5', 1.5],
];
const EFFORTS = [['low', 1], ['medium', 3], ['high', 3.5], ['xhigh', 1.2], ['max', 0.5]];
const TOOLS = [['Read', 9], ['Edit', 6], ['Bash', 7], ['Grep', 5], ['Glob', 2.5], ['Write', 2], ['TodoWrite', 1.5], ['Task', 1.2], ['WebSearch', 0.6], ['WebFetch', 0.4]];
const TITLES = new Map([
	['/home/dev/acme-api', ['Paginate the orders endpoint', 'Fix webhook signature test', 'Refund service tests']],
	['/home/dev/docs-site', ['Rewrite the quick-start', 'Link checker pass']],
	['/home/dev/mobile-app', ['Offline feed cache', 'Android cold start']],
	['/home/dev/data-pipeline', ['Nightly job idempotency']],
]);

/** Writes ~/.claude-shaped sample data into `dir` and returns the ids of the two sessions shown as running. */
function seedData(dir, now) {
	const projectsDir = path.join(dir, 'projects');
	const dataDir = path.join(dir, 'claude-code-tracker');
	fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
	const DAY = 86400000;
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	const live = [];

	for (let back = 13; back >= 0; back--) {
		const day = midnight.getTime() - back * DAY;
		const weekday = new Date(day).getDay();
		const busy = weekday === 0 || weekday === 6 ? 0.35 : 1;
		for (const project of PROJECTS) {
			if (rand() > 0.8 * busy * project.weight ** 0.5) continue;
			const sessionId = uuid();
			const dirKey = project.cwd.replace(/[^a-zA-Z0-9]/g, '-');
			fs.mkdirSync(path.join(projectsDir, dirKey), { recursive: true });
			const lines = [];
			const title = pick(TITLES.get(project.cwd));
			lines.push({ type: 'ai-title', sessionId, aiTitle: title });
			let t = day + between(8.5, 17) * 3600000;
			const prompts = 2 + Math.floor(rand() * 4);
			const model = weighted(MODELS);
			for (let p = 0; p < prompts; p++) {
				if (t > now - 60000) break;
				const base = { sessionId, cwd: project.cwd, gitBranch: project.branch, version: '2.1.0', userType: 'external' };
				lines.push({ ...base, type: 'user', uuid: uuid(), timestamp: new Date(t).toISOString(), message: { role: 'user', content: pick(project.prompts) } });
				const turns = 2 + Math.floor(rand() * 5);
				const effort = weighted(EFFORTS);
				for (let k = 0; k < turns; k++) {
					t += between(8, 90) * 1000;
					if (t > now - 30000) break;
					const output = Math.round(between(300, 3800));
					const thinking = Math.round(output * between(0.1, 0.5));
					const tools = [];
					for (let n = Math.floor(rand() * 3); n > 0; n--) tools.push(weighted(TOOLS));
					lines.push({
						...base,
						type: 'assistant',
						uuid: uuid(),
						requestId: 'req_' + hex(10),
						perTurnEffort: effort,
						timestamp: new Date(t).toISOString(),
						message: {
							id: 'msg_' + hex(14),
							model: k === 0 && rand() < 0.15 ? 'claude-haiku-5-5' : model,
							role: 'assistant',
							content: tools.map(name => ({ type: 'tool_use', name, id: 'toolu_' + hex(8), input: {} })).concat([{ type: 'text', text: 'Done.' }]),
							usage: {
								input_tokens: Math.round(between(2, 900)),
								output_tokens: output,
								cache_read_input_tokens: Math.round(between(18000, 140000)),
								cache_creation_input_tokens: Math.round(between(1500, 14000)),
								cache_creation: {},
								output_tokens_details: { thinking_tokens: thinking },
							},
						},
					});
				}
				t += between(60, 900) * 1000;
			}
			fs.writeFileSync(path.join(projectsDir, dirKey, sessionId + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
		}
	}

	// Two sessions that are running now.
	const runningNow = [
		{ name: 'acme-api', cwd: '/home/dev/acme-api', status: 'working', model: 'Opus 5.5', effort: 'high', cost: 6.12, added: 412, removed: 38, ctx: 34, tokens: 338000, hit: 0.96, warm: true, expires: 48 },
		{ name: 'docs-site', cwd: '/home/dev/docs-site', status: 'idle', model: 'Sonnet 5.5', effort: 'medium', cost: 0.84, added: 57, removed: 9, ctx: 12, tokens: 121000, hit: 0.88, warm: false, expires: 0 },
	];
	const pids = [process.pid, process.ppid];
	runningNow.forEach((s, i) => {
		const sessionId = uuid();
		live.push(sessionId);
		fs.writeFileSync(path.join(dir, 'sessions', `${pids[i]}.json`), JSON.stringify({ pid: pids[i], sessionId, name: s.name, cwd: s.cwd, status: s.status, updatedAt: now - i * 40000, entrypoint: 'cli' }));
		fs.writeFileSync(
			path.join(dataDir, 'sessions', `${sessionId}.json`),
			JSON.stringify({
				receivedAt: now - 20000,
				sessionId,
				sessionName: s.name,
				workspace: { currentDir: s.cwd },
				model: { display_name: s.model },
				effort: { level: s.effort },
				cost: { total_cost_usd: s.cost, total_lines_added: s.added, total_lines_removed: s.removed },
				contextWindow: { used_percentage: s.ctx, context_window_size: 1000000, current_usage: { input_tokens: 1200, cache_creation_input_tokens: 9000, cache_read_input_tokens: s.tokens - 10200 } },
				promptCache: { hit_ratio: s.hit, warm: s.warm, expires_at: Math.round((now + s.expires * 60000) / 1000), ttl: '1h' },
			}),
		);
	});

	// Rate-limit windows: 41% of the 5-hour and 27% of the weekly window used.
	const fiveReset = Math.round((now + 2.6 * 3600000) / 1000);
	const weekReset = Math.round((now + 4.08 * DAY) / 1000);
	fs.writeFileSync(path.join(dataDir, 'rate-limits.json'), JSON.stringify({ receivedAt: now - 15000, rateLimits: { five_hour: { used_percentage: 41, resets_at: fiveReset }, seven_day: { used_percentage: 27, resets_at: weekReset } } }));
	const history = [];
	for (let i = 0; i <= 24; i++) {
		const t = now - (24 - i) * 6 * 60000;
		history.push({ t, five: +(41 - (24 - i) * 0.55 + between(-0.3, 0.3)).toFixed(1), fiveReset, week: +(27 - (24 - i) * 0.1).toFixed(1), weekReset });
	}
	fs.writeFileSync(path.join(dataDir, 'rate-history.jsonl'), history.map(h => JSON.stringify(h)).join('\n') + '\n');
	// Only the script's name matters to the extension; keep the real temp path (it holds a user name) out of the screenshots.
	fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node "~/.claude/claude-code-tracker/statusline-bridge.js"' } }));
	return live;
}

// ---------- the extension, against a stub vscode ----------
async function dashboardState(claudeDir, extra) {
	const store = { claudeDir, limitsPollMinutes: 0, historyLimit: 50, ...extra };
	const commands = new Map();
	const noop = { dispose() {} };
	let provider;
	const view = {
		visible: true,
		webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: u => ({ toString: () => pathToFileURL(u.fsPath).href }), postMessage: async m => void (view.last = m), onDidReceiveMessage: fn => void (view.handler = fn) },
		onDidChangeVisibility() {},
		onDidDispose() {},
	};
	const vscode = {
		StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 }, MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } },
		ThemeColor: class {}, ThemeIcon: class {}, TerminalProfile: class {}, RelativePattern: class {},
		extensions: { getExtension: () => undefined },
		Uri: { file: p => ({ fsPath: p }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
		window: {
			createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
			createStatusBarItem: id => ({ id, show() {}, hide() {}, dispose() {} }),
			registerWebviewViewProvider: (_id, p) => ((provider = p), noop),
			registerTerminalProfileProvider: () => noop,
			showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, setStatusBarMessage: () => noop,
		},
		commands: { registerCommand: (id, fn) => (commands.set(id, fn), noop), executeCommand: async () => {} },
		workspace: {
			getConfiguration: () => ({ get: (k, d) => (k in store ? store[k] : k in defaults ? defaults[k] : d), inspect: () => ({}), update: async () => {} }),
			onDidChangeConfiguration: () => noop, createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} }), fs: { writeFile: async () => {} },
		},
		env: { clipboard: { writeText: async () => {} } },
	};
	const load = Module._load;
	Module._load = function (request, ...rest) {
		return request === 'vscode' ? vscode : load.call(this, request, ...rest);
	};
	const memento = () => { const m = new Map(); return { get: k => m.get(k), update: async (k, v) => void m.set(k, v) }; };
	const { activate } = require(path.join(root, 'out', 'extension.js'));
	const context = { subscriptions: [], extensionUri: { fsPath: root }, globalState: memento(), workspaceState: memento(), globalStorageUri: { fsPath: path.join(claudeDir, 'gs') }, extension: { packageJSON: { version: pkg.version } } };
	activate(context);
	provider.resolveWebviewView(view);
	view.handler({ type: 'ready' });
	for (let i = 0; i < 100 && !view.last; i++) await new Promise(r => setTimeout(r, 100));
	if (!view.last) throw new Error('The extension never posted dashboard state.');
	for (const d of context.subscriptions) try { d.dispose(); } catch { /* ignore */ }
	return { html: view.webview.html, state: view.last };
}

// Colours VS Code's Dark Modern and Light Modern themes give a webview.
const VSCODE_THEMES = {
	dark: { '--vscode-font-family': "'Segoe UI', system-ui, sans-serif", '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-panel-background': '#181818', '--vscode-editor-background': '#1f1f1f', '--vscode-sideBar-background': '#181818', '--vscode-widget-border': '#2b2b2b', '--vscode-panel-border': '#2b2b2b', '--vscode-input-background': '#313131', '--vscode-errorForeground': '#f85149', '--vscode-charts-green': '#3fbca8', '--vscode-charts-purple': '#a45de3', '--vscode-charts-blue': '#3794ff', '--vscode-toolbar-hoverBackground': '#2b2b2b', '--vscode-list-hoverBackground': '#2a2d2e', '--vscode-editorHoverWidget-background': '#202020', '--vscode-editorHoverWidget-border': '#454545', '--vscode-progressBar-background': '#0078d4' },
	light: { '--vscode-font-family': "'Segoe UI', system-ui, sans-serif", '--vscode-foreground': '#3b3b3b', '--vscode-descriptionForeground': '#6e6e6e', '--vscode-panel-background': '#f8f8f8', '--vscode-editor-background': '#ffffff', '--vscode-sideBar-background': '#f8f8f8', '--vscode-widget-border': '#e5e5e5', '--vscode-panel-border': '#e5e5e5', '--vscode-input-background': '#ffffff', '--vscode-errorForeground': '#f85149', '--vscode-charts-green': '#2a9d8b', '--vscode-charts-purple': '#8a3fc7', '--vscode-charts-blue': '#1a85ff', '--vscode-toolbar-hoverBackground': '#e8e8e8', '--vscode-list-hoverBackground': '#f0f0f0', '--vscode-editorHoverWidget-background': '#f8f8f8', '--vscode-editorHoverWidget-border': '#c8c8c8', '--vscode-progressBar-background': '#0078d4' },
};

/** The dashboard page as VS Code would serve it, but standalone: local file URLs, no CSP, and a stub of the webview API. */
function harness({ html, state }, scheme, dir) {
	const vars = Object.entries(VSCODE_THEMES[scheme]).map(([k, v]) => `${k}:${v}`).join(';');
	const json = JSON.stringify(state).replace(/</g, '\\u003c');
	const page = html
		.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<style>:root{${vars};color-scheme:${scheme}}</style>`)
		.replace(/<script nonce="[^"]*" src="([^"]*dashboard\.js)"><\/script>/, `<script>window.acquireVsCodeApi=()=>({postMessage(){},getState(){},setState(){}});</script><script src="$1"></script><script>window.dispatchEvent(new MessageEvent('message',{data:${json}}));</script>`)
		.replace(/<script nonce="[^"]*"/g, '<script');
	const file = path.join(dir, `harness-${scheme}.html`);
	fs.writeFileSync(file, page);
	return pathToFileURL(file).href;
}

// ---------- headless browser over the DevTools protocol ----------
function findBrowser() {
	const candidates = [
		process.env.BROWSER,
		'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		'/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
	].filter(Boolean);
	const found = candidates.find(p => fs.existsSync(p));
	if (!found) throw new Error('No Edge or Chrome found. Set BROWSER to the executable path.');
	return found;
}

async function launch(profileDir) {
	// On Windows msedge.exe can hand off to another process and exit, so wait on the debugging port rather than the child.
	const port = await new Promise(resolve => {
		const server = require('net').createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port: free } = server.address();
			server.close(() => resolve(free));
		});
	});
	const child = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
	let targets;
	for (let i = 0; i < 100 && !targets; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			if (list.some(t => t.type === 'page')) targets = list;
		} catch { /* not listening yet */ }
		if (!targets) await new Promise(r => setTimeout(r, 200));
	}
	if (!targets) throw new Error('Timed out waiting for the browser.');
	const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let id = 0;
	const waiting = new Map();
	ws.onmessage = e => {
		const m = JSON.parse(e.data);
		if (m.id && waiting.has(m.id)) {
			const { resolve, reject } = waiting.get(m.id);
			waiting.delete(m.id);
			m.error ? reject(new Error(m.error.message)) : resolve(m.result);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => { waiting.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
	const evaluate = async expression => {
		const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
		return r.result.value;
	};
	return { send, evaluate, close: async () => { await send('Browser.close').catch(() => {}); ws.close(); child.kill(); } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-shots-'));
	const claudeDir = path.join(work, 'claude');
	const now = Date.now();
	seedData(claudeDir, now);
	const page = await dashboardState(claudeDir, {});
	page.state.model.scan.claudeDir = ''; // the settings footer prints this; it is a temp path
	const browser = await launch(path.join(work, 'profile'));
	fs.mkdirSync(outDir, { recursive: true });

	const open = async (scheme, width, height) => {
		await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
		await browser.send('Page.navigate', { url: harness(page, scheme, work) });
		await sleep(2500); // chart animations
	};
	const shoot = async (name, clip) => {
		const { data } = await browser.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
		fs.writeFileSync(path.join(outDir, name), Buffer.from(data, 'base64'));
		console.log(`wrote docs/images/${name} (${Math.round(fs.statSync(path.join(outDir, name)).size / 1024)} KB)`);
	};
	/** Bounding box of one or more elements, with a little padding. */
	const around = async (selector, pad = 0) => {
		const r = await browser.evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; if (!els.length) return null; const b = els.map(e => e.getBoundingClientRect()); const x = Math.min(...b.map(r => r.left)), y = Math.min(...b.map(r => r.top)) + scrollY; return { x, y, w: Math.max(...b.map(r => r.right)) - x, h: Math.max(...b.map(r => r.bottom)) + scrollY - y }; })()`);
		if (!r) throw new Error(`Nothing matches ${selector}`);
		return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + 2 * pad, height: r.h + 2 * pad };
	};
	const card = id => `[data-card="${id}"]`;

	/** Hides every card except `ids` so the grid reflows, and returns the area they now fill. */
	const only = async ids => {
		await browser.evaluate(`document.querySelectorAll('.card').forEach(c => { c.style.display = ${JSON.stringify(ids)}.includes(c.dataset.card) ? '' : 'none'; })`);
		await sleep(1200); // charts resize
		return around('#content', 0);
	};

	await open('dark', 1480, 1500);
	await shoot('dashboard.png', { x: 0, y: 0, width: 1480, height: 680 });
	await shoot('limits-and-pace.png', await around(card('windows')));
	await shoot('tokens-by-model-and-reasoning.png', await around(card('breakdown')));
	// Select Reasoning Effort, then deselect Model, to group by effort alone.
	await browser.evaluate(`['effort', 'model'].forEach(d => document.querySelector('${card('breakdown')} [data-dim="' + d + '"]').click())`);
	await sleep(800);
	await shoot('tokens-by-reasoning-effort.png', await around(card('breakdown')));
	await shoot('prompt-history.png', await around(card('prompts')));
	await shoot('sessions.png', await around(card('sessions')));

	await browser.evaluate(`document.getElementById('settingsToggle').click()`);
	await sleep(800);
	await shoot('settings.png', await around('#settings', 0));

	await open('dark', 1480, 1500);
	await shoot('breakdowns.png', await only(['models', 'heatmap', 'projects', 'tools']));

	await open('light', 1480, 1500);
	await shoot('dashboard-light.png', { x: 0, y: 0, width: 1480, height: 680 });

	await browser.close();
	await sleep(500); // let the browser release its profile folder
	fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
