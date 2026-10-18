import * as vscode from 'vscode';
import { formatClock, formatDuration, formatTokens, formatUsd } from './format';
import { Level, levelFor, statusText, worstLevel } from './levels';
import { DashboardModel } from './types';

export { Level, levelFor };

export interface StatusBarSettings {
	quotaDisplay: 'remaining' | 'used';
	/** Percent used at which a window turns to warning / critical (already normalised). */
	warning: number;
	critical: number;
	/** "background" uses the theme's warning/error status-bar background; "text" colours the text instead. */
	highlight: 'background' | 'text';
	/** Text colours. `normalColor` is empty when the theme's own status-bar colour should be used. */
	normalColor: string;
	warningColor: string;
	criticalColor: string;
	showCost: boolean;
	showResets: boolean;
}

const OPEN_PANEL = 'claudeTracker.showPanel';

/** One status-bar entry that combines the 5-hour window, the weekly window, their resets and today's cost. */
export class TrackerStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('claudeTracker.usage', vscode.StatusBarAlignment.Right, 10_000);

	constructor() {
		this.item.name = 'Claude Code Usage';
		this.item.command = OPEN_PANEL;
		this.item.text = '$(pulse) Claude';
		this.item.tooltip = 'Token Usage Tracker: scanning transcripts…';
		this.item.show();
	}

	update(model: DashboardModel, settings: StatusBarSettings): void {
		const now = model.generatedAt;
		this.item.text = statusText(model.windows, model.today.cost, now, settings);
		const levels = model.windows.filter(w => w.usedPercent !== null).map(w => levelFor(w.usedPercent as number, settings.warning, settings.critical));
		this.applyLevel(worstLevel(levels), settings);
		this.item.tooltip = this.tooltip(model, settings);
		this.item.show();
	}

	private applyLevel(level: Level, settings: StatusBarSettings): void {
		this.item.backgroundColor = undefined;
		this.item.color = undefined;
		if (settings.highlight === 'background' && level !== 'normal') {
			// VS Code only allows these two theme colours as status-bar backgrounds.
			this.item.backgroundColor = new vscode.ThemeColor(level === 'critical' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground');
			this.item.color = new vscode.ThemeColor(level === 'critical' ? 'statusBarItem.errorForeground' : 'statusBarItem.warningForeground');
			return;
		}
		if (level === 'critical') this.item.color = settings.criticalColor;
		else if (level === 'warning') this.item.color = settings.warningColor;
		else if (settings.normalColor) this.item.color = settings.normalColor;
	}

	private tooltip(model: DashboardModel, settings: StatusBarSettings): vscode.MarkdownString {
		const now = model.generatedAt;
		const used = settings.quotaDisplay === 'used';
		const md = new vscode.MarkdownString(undefined, true);
		md.supportThemeIcons = true;
		md.appendMarkdown('**Claude Code Usage**\n\n');
		const rows: string[] = ['| Window | ' + (used ? 'Used' : 'Left') + ' | Resets | Pace |', '|---|---:|---|---|'];
		for (const w of model.windows) {
			const value = w.usedPercent === null ? 'N/A' : `${Math.round(used ? w.usedPercent : 100 - w.usedPercent)}%`;
			const level = w.usedPercent === null ? 'normal' : levelFor(w.usedPercent, settings.warning, settings.critical);
			const icon = level === 'critical' ? '$(error) ' : level === 'warning' ? '$(warning) ' : '';
			const reset = w.resetsAt ? `${formatDuration(w.resetsAt - now)} (${formatClock(w.resetsAt, now)})` : '—';
			let pace = '—';
			if (w.projectedFullAt) pace = `$(warning) full ~${formatClock(w.projectedFullAt, now)}`;
			else if (w.pctPerHour !== null) pace = `${w.pctPerHour.toFixed(1)}%/h`;
			rows.push(`| ${icon}${w.label} | ${value}${w.stale ? ' (stale)' : ''} | ${reset} | ${pace} |`);
		}
		md.appendMarkdown(rows.join('\n') + '\n\n');
		md.appendMarkdown(
			`Today: **${formatUsd(model.today.cost)}** API-equivalent · ${formatTokens(model.today.tokens)} tokens · ${model.today.prompts} prompts\n\n`,
		);
		const five = model.windows[0];
		if (five.windowStart !== null) {
			md.appendMarkdown(`This 5h window: ${formatUsd(five.localCost)} · ${five.costPerHour !== null ? formatUsd(five.costPerHour) + '/h' : ''}\n\n`);
		}
		const live = model.live.find(s => s.contextPercent !== undefined);
		if (live) {
			md.appendMarkdown(`Context (${live.name ?? live.sessionId.slice(0, 8)}): ${Math.round(live.contextPercent ?? 0)}% of ${formatTokens(live.contextSize ?? 0)}\n\n`);
		}
		md.appendMarkdown(`Warning at ${settings.warning}% used · critical at ${settings.critical}% used\n\n`);
		md.appendMarkdown('_Click to open the dashboard._');
		return md;
	}

	dispose(): void {
		this.item.dispose();
	}
}
