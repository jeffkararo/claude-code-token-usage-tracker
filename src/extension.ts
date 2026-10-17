import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { aggregate } from './aggregate';
import { BridgeReader, liveSessions } from './bridgeData';
import { BridgeInstaller } from './bridgeInstall';
import { DashboardProvider, WebviewMessage } from './dashboard';
import { csvCell } from './format';
import { PriceBook } from './pricing';
import { DEFAULT_COLORS, Level, levelFor, normalizeThresholds, safeColor, validateColor } from './levels';
import { cleanChartColors, cleanOverrides, PALETTE_NAMES, PALETTES, resolveTheme, THEME_NAMES, THEMES } from './theme';
import { StatusBarSettings, TrackerStatusBar } from './statusBar';
import { registerClaudeTerminal, resolveClaudeCli } from './terminal';
import { runUsageCommand, saveReport } from './usagePoller';
import { TranscriptStore } from './transcripts';
import { DashboardModel, ModelPrice, RangeKey } from './types';

const RANGES: RangeKey[] = ['1d', '24h', '7d', '14d', '21d', '30d', '90d', '365d', 'all'];
const LAYOUT_KEY = 'claudeTracker.layout';
const RANGE_KEY = 'claudeTracker.range';
const DEBOUNCE_MS = 600;

function cfg() {
	return vscode.workspace.getConfiguration('claudeTracker');
}

function resolveClaudeDir(): string {
	const configured = cfg().get<string>('claudeDir', '').trim();
	if (configured) return configured.replace(/^~(?=$|[\\/])/, os.homedir());
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

class Tracker implements vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel('Usage Tracker');
	private readonly statusBar = new TrackerStatusBar();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly watchers: vscode.Disposable[] = [];
	private claudeDir = resolveClaudeDir();
	private readonly store = new TranscriptStore(path.join(this.claudeDir, 'projects'));
	private readonly bridge = new BridgeReader(path.join(this.claudeDir, 'claude-code-tracker'));
	private readonly installer: BridgeInstaller;
	private readonly dashboard: DashboardProvider;
	private timer: NodeJS.Timeout | undefined;
	private limitsTimer: NodeJS.Timeout | undefined;
	private polling = false;
	private lastPollAt = 0;
	private pollDisabledReason: string | undefined;
	private debounce: NodeJS.Timeout | undefined;
	private running: Promise<void> | undefined;
	private rerun = false;
	private model: DashboardModel | undefined;
	private readonly notified = new Map<string, Level>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.installer = new BridgeInstaller(context.extensionUri, this.claudeDir, this.bridge.directory, m => this.log(m));
		this.dashboard = new DashboardProvider(context.extensionUri, message => void this.handleMessage(message));
		this.disposables.push(
			this.output,
			this.statusBar,
			vscode.window.registerWebviewViewProvider(DashboardProvider.viewId, this.dashboard, { webviewOptions: { retainContextWhenHidden: true } }),
			vscode.commands.registerCommand('claudeTracker.showPanel', () => vscode.commands.executeCommand(`${DashboardProvider.viewId}.focus`)),
			vscode.commands.registerCommand('claudeTracker.refresh', async () => {
				await this.pollLimits(true);
				await this.refresh(true);
			}),
			vscode.commands.registerCommand('claudeTracker.refreshLimits', () => this.pollLimits(true, true)),
			vscode.commands.registerCommand('claudeTracker.showOutput', () => this.output.show()),
			vscode.commands.registerCommand('claudeTracker.connectBridge', () => this.connectBridge()),
			vscode.commands.registerCommand('claudeTracker.disconnectBridge', () => this.disconnectBridge()),
			...registerClaudeTerminal(m => this.log(m)),
			vscode.commands.registerCommand('claudeTracker.exportCsv', () => this.exportData('csv')),
			vscode.commands.registerCommand('claudeTracker.exportJson', () => this.exportData('json')),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (!event.affectsConfiguration('claudeTracker')) return;
				if (event.affectsConfiguration('claudeTracker.claudeDir')) this.relocate();
				if (event.affectsConfiguration('claudeTracker.pollIntervalSeconds')) this.startTimer();
				if (event.affectsConfiguration('claudeTracker.limitsPollMinutes') || event.affectsConfiguration('claudeTracker.claudePath')) {
					this.pollDisabledReason = undefined;
					this.startLimitsTimer();
				}
				void this.refresh();
			}),
		);
	}

	async start(): Promise<void> {
		this.watch();
		this.startTimer();
		this.startLimitsTimer();
		if (await this.installer.isConnected()) {
			await this.installer.syncScript().catch(error => this.log(`Bridge script sync failed: ${String(error)}`));
		}
		await this.refresh();
	}

	private log(message: string): void {
		this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
	}

	private debug(message: string): void {
		if (cfg().get<boolean>('outputDebug', false)) this.log(message);
	}

	private relocate(): void {
		this.claudeDir = resolveClaudeDir();
		this.store.setProjectsDir(path.join(this.claudeDir, 'projects'));
		this.bridge.setDirectory(path.join(this.claudeDir, 'claude-code-tracker'));
		this.installer.setDirectories(this.claudeDir, this.bridge.directory);
		this.watch();
		this.log(`Claude directory set to ${this.claudeDir}`);
	}

	private watch(): void {
		for (const watcher of this.watchers.splice(0)) watcher.dispose();
		const patterns: [string, string][] = [
			[path.join(this.claudeDir, 'projects'), '**/*.jsonl'],
			[this.bridge.directory, '**/*.json'],
			[path.join(this.claudeDir, 'sessions'), '*.json'],
		];
		for (const [base, glob] of patterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
			const schedule = () => this.schedule();
			watcher.onDidChange(schedule);
			watcher.onDidCreate(schedule);
			this.watchers.push(watcher);
		}
	}

	private startTimer(): void {
		if (this.timer) clearInterval(this.timer);
		const seconds = Math.max(10, cfg().get<number>('pollIntervalSeconds', 60));
		this.timer = setInterval(() => void this.refresh(), seconds * 1000);
	}

	private startLimitsTimer(): void {
		if (this.limitsTimer) clearInterval(this.limitsTimer);
		this.limitsTimer = undefined;
		const minutes = cfg().get<number>('limitsPollMinutes', 5);
		if (!minutes || minutes <= 0) return;
		this.limitsTimer = setInterval(() => void this.pollLimits(false), Math.max(1, minutes) * 60_000);
		void this.pollLimits(false);
	}

	/**
	 * Runs Claude Code's local /usage command and saves the 5-hour and weekly windows.
	 * `force` skips the 30-second throttle; `announce` reports the outcome to the user.
	 */
	private async pollLimits(force: boolean, announce = false): Promise<void> {
		const minutes = cfg().get<number>('limitsPollMinutes', 5);
		if ((!minutes || minutes <= 0) && !announce) return;
		if (this.pollDisabledReason && !announce) return;
		if (this.polling || (!force && Date.now() - this.lastPollAt < 30_000)) return;
		this.polling = true;
		try {
			const cli = await resolveClaudeCli();
			if (!cli) {
				this.log('Limits poll skipped: Claude Code CLI not found.');
				if (announce) void vscode.window.showWarningMessage('Usage Tracker: could not find the Claude Code CLI to read limits.');
				return;
			}
			const cwd = this.context.globalStorageUri.fsPath;
			await fsp.mkdir(cwd, { recursive: true });
			const started = Date.now();
			const result = await runUsageCommand(cli, cwd);
			this.lastPollAt = Date.now();
			if (result.unsafe) {
				// Never let a future CLI turn polling into billed model calls.
				this.pollDisabledReason = result.error;
				this.log(`Limits polling stopped: ${result.error}`);
				void vscode.window.showWarningMessage(`Usage Tracker stopped polling limits: ${result.error}. The statusline bridge still works.`);
				return;
			}
			if (!result.report) {
				this.log(`Limits poll failed: ${result.error}`);
				if (announce) void vscode.window.showWarningMessage(`Usage Tracker: could not read limits. ${result.error ?? ''}`);
				return;
			}
			const saved = await saveReport(this.bridge.directory, result.report);
			const r = result.report;
			this.debug(
				`Limits poll in ${Date.now() - started}ms: 5h ${r.fiveHour?.usedPercent ?? 'n/a'}%, week ${r.sevenDay?.usedPercent ?? 'n/a'}%` +
					(r.other.length ? `, ${r.other.map(w => `${w.label} ${w.usedPercent}%`).join(', ')}` : ''),
			);
			if (!saved && announce) {
				void vscode.window.showInformationMessage(
					r.subscription ? 'Usage Tracker: /usage returned no limit windows.' : 'Usage Tracker: rate limits are only reported for Claude Pro and Max subscriptions.',
				);
			}
			if (saved) await this.refresh();
		} catch (error) {
			this.log(`Limits poll error: ${String(error)}`);
		} finally {
			this.polling = false;
		}
	}

	private schedule(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
	}

	private get range(): RangeKey {
		const stored = this.context.globalState.get<RangeKey>(RANGE_KEY);
		if (stored && RANGES.includes(stored)) return stored;
		const configured = cfg().get<RangeKey>('defaultRange', '7d');
		return RANGES.includes(configured) ? configured : '7d';
	}

	private get layoutStore(): vscode.Memento {
		return cfg().get<string>('layoutScope', 'global') === 'workspace' ? this.context.workspaceState : this.context.globalState;
	}

	/** Serialises refreshes; a request made while one is running triggers one more pass. */
	refresh(reportErrors = false): Promise<void> {
		if (this.running) {
			this.rerun = true;
			return this.running;
		}
		this.running = this.doRefresh(reportErrors).finally(() => {
			this.running = undefined;
			if (this.rerun) {
				this.rerun = false;
				void this.refresh();
			}
		});
		return this.running;
	}

	private async doRefresh(reportErrors: boolean): Promise<void> {
		const started = Date.now();
		try {
			const changed = await this.store.refresh();
			const [rate, history, snapshots, connected, command, lastSeen] = await Promise.all([
				this.bridge.rateLimits(),
				this.bridge.history(),
				this.bridge.sessionSnapshots(),
				this.installer.isConnected(),
				this.installer.currentCommand(),
				this.bridge.lastSeen(),
			]);
			const live = await liveSessions(this.claudeDir, snapshots);
			const config = cfg();
			const historyLimit = config.get<number>('historyLimit', 200);
			const range = this.range;
			const now = Date.now();
			this.model = aggregate({
				records: this.store.records.values(),
				prompts: this.store.prompts.values(),
				title: id => this.store.title(id),
				sessionFile: id => this.store.sessionFiles.get(id),
				projectPath: key => this.store.projectPath(key),
				prices: new PriceBook(config.get<Record<string, Partial<ModelPrice>>>('pricingOverrides', {})),
				range,
				now,
				historyLimit,
				rate,
				history,
				live,
				planMonthlyPrice: config.get<number>('planMonthlyPriceUsd', 0),
				bridge: { connected, receiving: Boolean(rate && (rate.fiveHour || rate.sevenDay || rate.spend)), lastAt: lastSeen, command },
				scan: { files: this.store.fileCount, durationMs: 0, claudeDir: this.claudeDir },
			});
			this.model.scan.durationMs = Date.now() - started;
			this.debug(
				`Refresh: ${changed ? 'changed' : 'unchanged'}, ${this.model.scan.files} files, ${this.model.scan.records} calls, ` +
					`${this.model.scan.prompts} prompts in ${this.model.scan.durationMs}ms; bridge ${connected ? 'connected' : 'off'}${rate ? `, limits at ${new Date(rate.receivedAt).toLocaleTimeString()}` : ''}`,
			);
			const statusSettings = this.statusSettings();
			this.statusBar.update(this.model, statusSettings);
			this.notifyThresholds(this.model, statusSettings);
			this.postState();
		} catch (error) {
			this.log(`Refresh failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			if (reportErrors) void vscode.window.showErrorMessage(`Usage Tracker refresh failed: ${String(error)}`);
		}
	}

	private statusSettings(): StatusBarSettings {
		const config = cfg();
		// Bad or inverted values in settings.json are corrected here, so every consumer sees valid levels.
		const thresholds = normalizeThresholds(config.get<number>('warningAtUsedPercent', 75), config.get<number>('criticalAtUsedPercent', 90));
		return {
			quotaDisplay: config.get<'remaining' | 'used'>('quotaDisplay', 'remaining'),
			warning: thresholds.warning,
			critical: thresholds.critical,
			highlight: config.get<'background' | 'text'>('statusBarHighlight', 'background'),
			showResets: config.get<boolean>('statusBarShowResets', true),
			normalColor: safeColor(config.get<string>('normalColor', ''), ''),
			warningColor: safeColor(config.get<string>('warningColor', ''), DEFAULT_COLORS.warning),
			criticalColor: safeColor(config.get<string>('criticalColor', ''), DEFAULT_COLORS.critical),
			showCost: config.get<boolean>('showCostInStatusBar', true),
		};
	}

	/** The thresholds and colours the dashboard should draw with (validated, unlike the raw settings it also shows). */
	private effectiveLevels() {
		const s = this.statusSettings();
		return { warning: s.warning, critical: s.critical, normalColor: s.normalColor, warningColor: s.warningColor, criticalColor: s.criticalColor, theme: this.effectiveTheme() };
	}

	/** The dashboard appearance after validation: base theme, chart palette and any colour overrides. */
	private effectiveTheme() {
		const config = cfg();
		return resolveTheme({
			theme: config.get('theme', 'vscode'),
			chartPalette: config.get('chartPalette', 'default'),
			customChartColors: config.get('customChartColors', []),
			colors: config.get('colors', {}),
		});
	}

	private notifyThresholds(model: DashboardModel, settings: StatusBarSettings): void {
		if (!cfg().get<boolean>('notifyOnThreshold', true)) return;
		for (const w of model.windows) {
			if (w.usedPercent === null || w.resetsAt === null || w.key === 'spend') continue;
			const key = `${w.key}:${Math.round(w.resetsAt / 60000)}`;
			const level = levelFor(w.usedPercent, settings.warning, settings.critical);
			const previous = this.notified.get(key);
			this.notified.set(key, level);
			if (previous === undefined || level === previous) continue;
			if (level === 'warning' || (level === 'critical' && previous !== 'critical')) {
				const remaining = Math.round(100 - w.usedPercent);
				const message = `Claude Code ${w.label} window: ${settings.quotaDisplay === 'used' ? Math.round(w.usedPercent) + '% used' : remaining + '% left'}, resets ${new Date(w.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`;
				if (level === 'critical') void vscode.window.showWarningMessage(message, 'Open Dashboard').then(pick => pick && this.showPanel());
				else void vscode.window.showInformationMessage(message, 'Open Dashboard').then(pick => pick && this.showPanel());
			}
		}
	}

	private showPanel(): void {
		void vscode.commands.executeCommand(`${DashboardProvider.viewId}.focus`);
	}

	private postState(): void {
		if (!this.model) return;
		const config = cfg();
		this.dashboard.post({
			model: this.model,
			layout: this.layoutStore.get(LAYOUT_KEY) ?? null,
			version: this.context.extension.packageJSON.version,
			settings: {
				effective: this.effectiveLevels(),
				defaultRange: config.get('defaultRange'),
				quotaDisplay: config.get('quotaDisplay'),
				warningAtUsedPercent: config.get('warningAtUsedPercent'),
				criticalAtUsedPercent: config.get('criticalAtUsedPercent'),
				statusBarHighlight: config.get('statusBarHighlight'),
				statusBarShowResets: config.get('statusBarShowResets'),
				warningColor: config.get('warningColor'),
				criticalColor: config.get('criticalColor'),
				normalColor: config.get('normalColor'),
				theme: config.get('theme'),
				chartPalette: config.get('chartPalette'),
				customChartColors: config.get('customChartColors'),
				colors: config.get('colors'),
				catalog: { themes: THEMES, palettes: PALETTES },
				notifyOnThreshold: config.get('notifyOnThreshold'),
				showCostInStatusBar: config.get('showCostInStatusBar'),
				planMonthlyPriceUsd: config.get('planMonthlyPriceUsd'),
				layoutScope: config.get('layoutScope'),
				historyLimit: config.get('historyLimit'),
				outputDebug: config.get('outputDebug'),
			},
		});
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				if (this.model) this.postState();
				else await this.refresh();
				return;
			case 'refresh':
				await this.pollLimits(false);
				await this.refresh();
				return;
			case 'setRange':
				if (RANGES.includes(message.range as RangeKey)) {
					await this.context.globalState.update(RANGE_KEY, message.range);
					await this.refresh();
				}
				return;
			case 'saveSettings': {
				const config = cfg();
				const { values, problems } = this.validateSettings(message.values);
				for (const [key, value] of Object.entries(values)) {
					if (config.inspect(key) === undefined) continue;
					// null resets a setting to its default.
					await config.update(key, value === null ? undefined : value, vscode.ConfigurationTarget.Global);
				}
				// Readability warnings come from the saved result, so they also catch a good colour on a bad base.
				if (['theme', 'colors', 'chartPalette', 'customChartColors'].some(k => k in values)) problems.push(...this.effectiveTheme().warnings);
				if (problems.length) void vscode.window.showWarningMessage(`Usage Tracker: ${problems.join(' ')}`);
				if ('defaultRange' in message.values) await this.context.globalState.update(RANGE_KEY, message.values.defaultRange);
				void vscode.window.setStatusBarMessage('Usage Tracker settings saved', 2500);
				// Re-post even when every change was rejected, so a live preview in the dashboard snaps back to what is saved.
				this.postState();
				return;
			}
			case 'saveLayout':
				await this.layoutStore.update(LAYOUT_KEY, message.layout);
				return;
			case 'resetLayout':
				await this.layoutStore.update(LAYOUT_KEY, undefined);
				this.postState();
				return;
			case 'openFile':
				await this.openTranscript(message.file);
				return;
			case 'copyResume':
				if (/^[\w-]+$/.test(message.sessionId)) {
					await vscode.env.clipboard.writeText(`claude --resume ${message.sessionId}`);
					void vscode.window.setStatusBarMessage('Copied: claude --resume …', 2500);
				}
				return;
			case 'export':
				await this.exportData(message.format);
				return;
			case 'connectBridge':
				await this.connectBridge();
				return;
			case 'disconnectBridge':
				await this.disconnectBridge();
				return;
			case 'openClaudeTerminal':
				await vscode.commands.executeCommand('claudeTracker.openClaudeTerminal');
				return;
			case 'showOutput':
				this.output.show();
				return;
		}
	}

	/** Rejects values the dashboard form could send that would break the levels; the rest are saved. */
	private validateSettings(input: Record<string, unknown>): { values: Record<string, unknown>; problems: string[] } {
		const values = { ...input };
		const problems: string[] = [];
		const config = cfg();
		for (const key of ['warningAtUsedPercent', 'criticalAtUsedPercent']) {
			const v = values[key];
			if (key in values && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100)) {
				delete values[key];
				problems.push(`${key} must be a number from 0 to 100.`);
			}
		}
		if ('warningAtUsedPercent' in values || 'criticalAtUsedPercent' in values) {
			const warning = Number(values.warningAtUsedPercent ?? config.get<number>('warningAtUsedPercent', 75));
			const critical = Number(values.criticalAtUsedPercent ?? config.get<number>('criticalAtUsedPercent', 90));
			if (critical < warning) {
				delete values.warningAtUsedPercent;
				delete values.criticalAtUsedPercent;
				problems.push(`Thresholds were not saved: critical (${critical}%) must be at least warning (${warning}%).`);
			}
		}
		for (const key of ['normalColor', 'warningColor', 'criticalColor']) {
			if (key in values && values[key] !== null && !validateColor(values[key])) {
				delete values[key];
				problems.push(`${key} must be a hex colour such as #e8a23a.`);
			}
		}
		if ('theme' in values && values.theme !== null && !THEME_NAMES.includes(values.theme as never)) {
			delete values.theme;
			problems.push(`theme must be one of: ${THEME_NAMES.join(', ')}.`);
		}
		if ('chartPalette' in values && values.chartPalette !== null && !PALETTE_NAMES.includes(values.chartPalette as never)) {
			delete values.chartPalette;
			problems.push(`chartPalette must be one of: ${PALETTE_NAMES.join(', ')}.`);
		}
		if ('colors' in values && values.colors !== null) {
			const cleaned = cleanOverrides(values.colors);
			const given = values.colors && typeof values.colors === 'object' ? Object.keys(values.colors) : [];
			const dropped = given.filter(k => !(k in cleaned));
			if (dropped.length) problems.push(`Ignored invalid colours: ${dropped.join(', ')} (use hex such as #3fb950).`);
			values.colors = cleaned;
		}
		if ('customChartColors' in values && values.customChartColors !== null) {
			const cleaned = cleanChartColors(values.customChartColors);
			if (Array.isArray(values.customChartColors) && cleaned.length < values.customChartColors.length) problems.push('Some chart colours were invalid or beyond the first ten and were ignored.');
			values.customChartColors = cleaned;
		}
		return { values, problems };
	}

	private async openTranscript(file: string): Promise<void> {
		const projects = path.resolve(this.claudeDir, 'projects');
		const target = path.resolve(file);
		// Only open transcripts the scanner found; the webview is not trusted to name arbitrary files.
		if (!target.startsWith(projects + path.sep) || !target.endsWith('.jsonl')) return;
		try {
			await fsp.access(target);
			await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not open transcript: ${String(error)}`);
		}
	}

	private async connectBridge(): Promise<void> {
		if (await this.installer.connect()) await this.refresh();
	}

	private async disconnectBridge(): Promise<void> {
		if (await this.installer.disconnect()) await this.refresh();
	}

	private async exportData(format: 'csv' | 'json'): Promise<void> {
		if (!this.model) await this.refresh();
		const config = cfg();
		const range = this.range;
		const now = Date.now();
		const base = this.model;
		if (!base) return;
		const full = aggregate({
			records: this.store.records.values(),
			prompts: this.store.prompts.values(),
			title: id => this.store.title(id),
			sessionFile: id => this.store.sessionFiles.get(id),
			projectPath: key => this.store.projectPath(key),
			prices: new PriceBook(config.get<Record<string, Partial<ModelPrice>>>('pricingOverrides', {})),
			range,
			now,
			historyLimit: Number.MAX_SAFE_INTEGER,
			history: [],
			live: [],
			planMonthlyPrice: config.get<number>('planMonthlyPriceUsd', 0),
			bridge: base.bridge,
			scan: { files: base.scan.files, durationMs: 0, claudeDir: this.claudeDir },
		});
		const stamp = new Date(now).toISOString().slice(0, 10);
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(os.homedir(), `claude-code-usage-${range}-${stamp}.${format}`)),
			filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
		});
		if (!uri) return;
		let text: string;
		if (format === 'csv') {
			const header = ['timestamp', 'project', 'session_id', 'models', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'api_calls', 'tool_calls', 'cost_usd', 'prompt'];
			const lines = full.prompts.map(p =>
				[new Date(p.ts).toISOString(), p.project, p.sessionId, p.models.join(' '), p.input, p.output, p.cacheRead, p.cacheWrite, p.calls, p.tools, p.cost.toFixed(6), p.text]
					.map(csvCell)
					.join(','),
			);
			text = [header.join(','), ...lines].join('\r\n') + '\r\n';
		} else {
			const { prompts: _prompts, live: _live, ...summary } = full;
			text = JSON.stringify({ exportedAt: new Date(now).toISOString(), note: 'Costs are API-equivalent list-price estimates.', ...summary }, null, 2);
		}
		await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
		const pick = await vscode.window.showInformationMessage(`Exported ${format.toUpperCase()} to ${uri.fsPath}`, 'Open');
		if (pick) await vscode.window.showTextDocument(uri);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.limitsTimer) clearInterval(this.limitsTimer);
		if (this.debounce) clearTimeout(this.debounce);
		for (const d of [...this.watchers, ...this.disposables]) d.dispose();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const tracker = new Tracker(context);
	context.subscriptions.push(tracker);
	// The first scan can take a few seconds on a large history; do not hold up activation for it.
	void tracker.start();
}

export function deactivate(): void {
	/* disposables are released through context.subscriptions */
}
