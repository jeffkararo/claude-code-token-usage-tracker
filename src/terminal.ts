import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const PROFILE_ID = 'claudeTracker.claudeTerminal';
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

function onPath(): Promise<string | undefined> {
	const finder = process.platform === 'win32' ? 'where.exe' : 'which';
	return new Promise(resolve => {
		execFile(finder, ['claude'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
			const first = stdout
				?.split(/\r?\n/)
				.map(line => line.trim())
				.find(Boolean);
			resolve(error ? undefined : first);
		});
	});
}

async function exists(file: string): Promise<boolean> {
	try {
		await fsp.access(file);
		return true;
	} catch {
		return false;
	}
}

/** The CLI bundled with Anthropic's Claude Code extension, if it is installed. */
async function bundledBinary(): Promise<string | undefined> {
	const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
	if (!extension) return undefined;
	const binary = path.join(extension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
	return (await exists(binary)) ? binary : undefined;
}

/** Resolves the Claude Code CLI: the setting, then PATH, then the copy inside the Claude Code extension. */
export async function resolveClaudeCli(): Promise<string | undefined> {
	const configured = vscode.workspace.getConfiguration('claudeTracker').get<string>('claudePath', '').trim();
	if (configured) return configured.replace(/^~(?=$|[\\/])/, os.homedir());
	return (await onPath()) ?? (await bundledBinary());
}

function missingCliMessage(): void {
	void vscode.window
		.showErrorMessage(
			'Token Usage Tracker: could not find the Claude Code CLI. Install the Claude Code extension or the CLI, or set claudeTracker.claudePath.',
			'Open Setting',
		)
		.then(pick => pick && vscode.commands.executeCommand('workbench.action.openSettings', 'claudeTracker.claudePath'));
}

async function terminalOptions(): Promise<vscode.TerminalOptions | undefined> {
	const cli = await resolveClaudeCli();
	if (!cli) {
		missingCliMessage();
		return undefined;
	}
	return {
		name: 'Claude Code',
		shellPath: cli,
		iconPath: new vscode.ThemeIcon('sparkle'),
		cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
	};
}

/** Adds "Claude Code" to the terminal + menu and a command that opens it. */
export function registerClaudeTerminal(log: (message: string) => void): vscode.Disposable[] {
	return [
		vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
			async provideTerminalProfile() {
				const options = await terminalOptions();
				if (options) log(`Opening Claude Code terminal: ${options.shellPath}`);
				// Returning undefined cancels the terminal; the error message explains why.
				return options ? new vscode.TerminalProfile(options) : undefined;
			},
		}),
		vscode.commands.registerCommand('claudeTracker.openClaudeTerminal', async () => {
			const options = await terminalOptions();
			if (!options) return;
			log(`Opening Claude Code terminal: ${options.shellPath}`);
			vscode.window.createTerminal(options).show();
		}),
	];
}
