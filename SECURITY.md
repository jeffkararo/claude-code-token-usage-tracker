# Security

## What this extension touches

Claude Code Token Usage Tracker reads files Claude Code already writes on your machine and makes no network
requests of its own:

- transcripts under `~/.claude/projects/` (token counts, timestamps, tool names, and the text of your prompts,
  which stay in the dashboard unless you export them),
- `~/.claude/sessions/`, to list running sessions,
- if you connect the optional statusline bridge, a small script it writes to `~/.claude/claude-code-tracker/`
  and a `statusLine` entry in `~/.claude/settings.json` (a backup of the original is written first).

It also runs Claude Code's own `claude -p /usage` command, which is answered locally and makes no model call.

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use
**Security → Report a vulnerability** on the GitHub repository, which opens a private advisory with the maintainer.

Include what you found, the version (shown in the dashboard settings drawer), and steps to reproduce. You can expect an
acknowledgement within a few days. Fixes are released as a new version and credited in the changelog unless you prefer
otherwise.

Things that would count as security issues here include: the extension reading or writing outside the Claude Code
folders, the webview running untrusted content, or the bridge being able to alter settings beyond the `statusLine`
entry.
