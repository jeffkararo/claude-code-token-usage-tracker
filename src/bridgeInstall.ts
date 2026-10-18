import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const SCRIPT_NAME = 'statusline-bridge.js';

interface StatusLineSetting {
	type?: string;
	command?: string;
	padding?: number;
	refreshInterval?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function readSettings(file: string): Promise<{ settings: any; exists: boolean }> {
	let text: string;
	try {
		text = await fsp.readFile(file, 'utf8');
	} catch {
		return { settings: {}, exists: false };
	}
	if (!text.trim()) return { settings: {}, exists: true };
	// Refuse to rewrite a file we cannot parse rather than risk losing the user's settings.
	return { settings: JSON.parse(text), exists: true };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function nodeAvailable(): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile('node', ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
	});
}

function toCommandPath(file: string): string {
	// Claude Code runs statusLine through Git Bash on Windows when it is installed; forward slashes work in both shells.
	return file.replace(/\\/g, '/');
}

export class BridgeInstaller {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private claudeDir: string,
		private dataDir: string,
		private readonly log: (message: string) => void,
	) {}

	setDirectories(claudeDir: string, dataDir: string): void {
		this.claudeDir = claudeDir;
		this.dataDir = dataDir;
	}

	get settingsPath(): string {
		return path.join(this.claudeDir, 'settings.json');
	}

	get scriptPath(): string {
		return path.join(this.dataDir, SCRIPT_NAME);
	}

	async currentCommand(): Promise<string | undefined> {
		try {
			const { settings } = await readSettings(this.settingsPath);
			return typeof settings?.statusLine?.command === 'string' ? settings.statusLine.command : undefined;
		} catch {
			return undefined;
		}
	}

	async isConnected(): Promise<boolean> {
		return (await this.currentCommand())?.includes(SCRIPT_NAME) ?? false;
	}

	/** Copies the bundled bridge script so the statusLine path survives extension updates. */
	async syncScript(): Promise<void> {
		const source = vscode.Uri.joinPath(this.extensionUri, 'resources', 'bridge', SCRIPT_NAME).fsPath;
		await fsp.mkdir(this.dataDir, { recursive: true });
		const next = await fsp.readFile(source);
		let current: Buffer | undefined;
		try {
			current = await fsp.readFile(this.scriptPath);
		} catch {
			current = undefined;
		}
		if (!current || !current.equals(next)) {
			await fsp.writeFile(this.scriptPath, next);
			this.log(`Bridge script updated at ${this.scriptPath}`);
		}
	}

	async connect(): Promise<boolean> {
		const nodeVersion = await nodeAvailable();
		if (!nodeVersion) {
			void vscode.window.showErrorMessage(
				'Token Usage Tracker: the statusline bridge needs Node.js on PATH (Claude Code runs it as `node …`). Install Node.js and try again.',
			);
			return false;
		}
		let parsed;
		try {
			parsed = await readSettings(this.settingsPath);
		} catch (error) {
			void vscode.window.showErrorMessage(`Token Usage Tracker: could not parse ${this.settingsPath}; it was left unchanged. ${String(error)}`);
			return false;
		}
		const { settings, exists } = parsed;
		const existing: StatusLineSetting | undefined = settings.statusLine;
		if (existing?.command?.includes(SCRIPT_NAME)) {
			await this.syncScript();
			void vscode.window.showInformationMessage('Token Usage Tracker: the statusline bridge is already connected.');
			return true;
		}

		const chainNote = existing?.command
			? `\n\nYour current status line command will keep working: the bridge saves the data, then runs it with the same input.\n  ${existing.command}`
			: '\n\nClaude Code will show a compact status line (model, context, limits, cost).';
		const choice = await vscode.window.showWarningMessage(
			'Connect the Claude Code statusline bridge?',
			{
				modal: true,
				detail:
					`This sets "statusLine" in ${this.settingsPath} to run a small local script (${this.scriptPath}). ` +
					'Claude Code passes it your 5-hour and weekly rate-limit usage, context window and prompt-cache stats; the script saves them under ' +
					`${this.dataDir} for this extension. Nothing is sent anywhere.${chainNote}\n\n` +
					'A backup of settings.json is written next to it. Use "Token Usage Tracker: Disconnect Statusline Bridge" to undo.',
			},
			'Connect',
		);
		if (choice !== 'Connect') return false;

		await this.syncScript();
		await fsp.writeFile(
			path.join(this.dataDir, 'bridge.json'),
			JSON.stringify({ chain: existing?.command ?? null, previousStatusLine: existing ?? null, installedAt: new Date().toISOString() }, null, 2),
		);
		if (exists) await fsp.copyFile(this.settingsPath, `${this.settingsPath}.claude-tracker.bak`);
		const statusLine: StatusLineSetting = { type: 'command', command: `node "${toCommandPath(this.scriptPath)}"` };
		if (existing?.padding !== undefined) statusLine.padding = existing.padding;
		if (existing?.refreshInterval !== undefined) statusLine.refreshInterval = existing.refreshInterval;
		settings.statusLine = statusLine;
		await fsp.mkdir(this.claudeDir, { recursive: true });
		await fsp.writeFile(this.settingsPath, JSON.stringify(settings, null, 2) + '\n');
		this.log(`Bridge connected using Node ${nodeVersion}: ${statusLine.command}`);
		void vscode.window.showInformationMessage(
			'Token Usage Tracker: bridge connected. Live limits appear after the next Claude Code response (Pro and Max plans report rate limits).',
		);
		return true;
	}

	async disconnect(): Promise<boolean> {
		let parsed;
		try {
			parsed = await readSettings(this.settingsPath);
		} catch (error) {
			void vscode.window.showErrorMessage(`Token Usage Tracker: could not parse ${this.settingsPath}; it was left unchanged. ${String(error)}`);
			return false;
		}
		const { settings } = parsed;
		if (!settings.statusLine?.command?.includes(SCRIPT_NAME)) {
			void vscode.window.showInformationMessage('Token Usage Tracker: the statusline bridge is not connected.');
			return false;
		}
		let previous: StatusLineSetting | null;
		try {
			previous = JSON.parse(await fsp.readFile(path.join(this.dataDir, 'bridge.json'), 'utf8')).previousStatusLine ?? null;
		} catch {
			previous = null;
		}
		const choice = await vscode.window.showWarningMessage(
			'Disconnect the statusline bridge?',
			{
				modal: true,
				detail: previous?.command
					? `Your previous status line will be restored:\n  ${previous.command}`
					: 'The statusLine setting will be removed from Claude Code settings.',
			},
			'Disconnect',
		);
		if (choice !== 'Disconnect') return false;
		if (previous) settings.statusLine = previous;
		else delete settings.statusLine;
		await fsp.writeFile(this.settingsPath, JSON.stringify(settings, null, 2) + '\n');
		this.log('Bridge disconnected.');
		return true;
	}
}
