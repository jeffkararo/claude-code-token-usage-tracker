import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'refresh' }
	| { type: 'setRange'; range: string }
	| { type: 'saveSettings'; values: Record<string, unknown> }
	| { type: 'saveLayout'; layout: unknown }
	| { type: 'resetLayout' }
	| { type: 'openFile'; file: string }
	| { type: 'copyResume'; sessionId: string }
	| { type: 'export'; format: 'csv' | 'json' }
	| { type: 'connectBridge' }
	| { type: 'disconnectBridge' }
	| { type: 'showOutput' }
	| { type: 'openClaudeTerminal' };

export class DashboardProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'claudeTracker.dashboard';
	private view: vscode.WebviewView | undefined;
	private lastState: unknown;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onMessage: (message: WebviewMessage) => void,
	) {}

	get visible(): boolean {
		return this.view?.visible ?? false;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		view.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message));
		view.onDidChangeVisibility(() => {
			if (view.visible) this.onMessage({ type: 'refresh' });
		});
		view.onDidDispose(() => {
			this.view = undefined;
		});
	}

	post(state: unknown): void {
		this.lastState = state;
		void this.view?.webview.postMessage({ type: 'state', ...(state as object) });
	}

	repost(): void {
		if (this.lastState) this.post(this.lastState);
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = randomBytes(16).toString('base64');
		const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('dashboard.css')}">
<title>Token Usage Tracker</title>
</head>
<body>
	<header class="topbar">
		<div class="brand"><span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 17.5a9 9 0 1 1 15 0"/><path d="M12 13l4.2-4.2"/><circle cx="12" cy="13" r="1.4" fill="currentColor"/></svg></span><span class="title">Usage</span><div id="quotaStrip" class="quota-strip" aria-label="Rate-limit windows"></div></div>
		<nav id="ranges" class="ranges" aria-label="Date range"></nav>
		<div class="top-actions">
			<button id="displayToggle" class="btn small" type="button" title="Switch between remaining and used">Showing: Left</button>
			<span id="updated" class="muted">Loading…</span>
			<button id="refreshButton" class="icon-button" type="button" title="Refresh">⟳</button>
			<button id="settingsToggle" class="icon-button" type="button" title="Settings" aria-expanded="false" aria-controls="settings">⚙</button>
		</div>
	</header>
	<section id="bridgeBanner" class="banner" hidden></section>
	<section id="meters" class="meter-row" aria-label="Rate-limit windows"></section>
	<aside id="settings" class="settings" hidden></aside>
	<main id="content" class="grid"><div class="loading">Scanning Claude Code transcripts…</div></main>
	<div id="tooltip" class="tooltip" role="tooltip" hidden></div>
	<script nonce="${nonce}" src="${asset('chart.umd.js')}"></script>
	<script nonce="${nonce}" src="${asset('dashboard.js')}"></script>
</body>
</html>`;
	}
}
