# Changelog

Versions below 1.0.0 are development builds and are not published to the Marketplace.
The first Marketplace release will be **1.0.0**.

## 0.8.0 — 2026-10-17

- Renamed to **Usage Tracker for Claude Code** (extension ID `usage-tracker-for-claude-code`), to avoid implying it is an Anthropic product. The README now carries a "not affiliated with Anthropic" notice.
- Command palette entries now start with **Usage Tracker:** instead of "Claude Tracker:", and the panel, output channel and messages say "Usage Tracker".
- **Because the extension ID changed, VS Code treats this as a new extension.** Uninstall the old "Claude Code Usage Tracker" (`kararo.claude-code-tracker`) after installing this one, or both will run side by side.
- Unchanged, so nothing needs reconfiguring: all `claudeTracker.*` settings and command IDs, the statusline bridge and its data under `~/.claude/claude-code-tracker/`.
- Repository housekeeping, with no change in behaviour: GitHub Actions CI, Dependabot, issue templates, a security policy, README screenshots, an upgrade of the `@vscode/vsce` build tool to 4.x, and a `check-name` script for checking Marketplace names.

## 0.7.0 — 2026-10-17

- New **Appearance** settings for the dashboard: a base theme (`claudeTracker.theme`: follow VS Code, dark, light or high contrast), per-colour overrides (`claudeTracker.colors`: accent, time marker, background, cards, text, muted text, borders), and a chart palette (`claudeTracker.chartPalette`: default, colour-blind safe, cool, warm, vivid or custom, with `customChartColors`).
- The settings drawer previews changes live, reverts them if closed without saving, shows a contrast readout for text colours, and has **Reset appearance**. Switching theme drops overrides made for the previous one.
- Saving unreadable colours shows a plain-language contrast warning. Invalid names and colours are rejected with a message.
- Primary buttons pick black or white text to stay readable on any accent colour.
- The "Resets" legend no longer names the marker's colour, since it is configurable.
- Recommendation documented in the README: keep `theme` on `vscode`, use `colorBlindSafe` charts if colours are hard to tell apart, and keep text contrast at 4.5:1 or higher.

## 0.6.1 — 2026-10-16

- The purple time marker on the limit meters uses the same tooltip as the info icons, and it states the time remaining in the window (with the elapsed point when showing used).
- Each "Resets" line has a legend explaining the purple line, which changes with the display mode.

## 0.6.0 — 2026-10-14

- Choose how limits are shown with `claudeTracker.quotaDisplay` (`remaining` or `used`). The status bar, pills, meters, mini bars, pace text, tooltips and notifications all follow it, and a **Showing: Left/Used** button in the dashboard switches it in one click.
- Customise the three levels: `claudeTracker.normalColor`, `warningColor` and `criticalColor`, with `warningAtUsedPercent` and `criticalAtUsedPercent`. The dashboard settings add colour presets, a live range preview for each level, and **Reset colours**. They replace `belowFullColor`, which was removed.
- Meters, pills and the Limit Windows card use these colours (previously fixed). The normal colour also applies to the status-bar text.
- Invalid values are handled: thresholds outside 0–100 or critical below warning are rejected with a message when saved from the dashboard, and corrected when read from settings.json; non-hex colours are ignored.
- Tests now check that every setting the code reads is declared in the manifest (and vice versa), and exercise the extension host against a stubbed VS Code.

## 0.5.0 — 2026-10-14

- One combined status-bar entry, for example `5H: 64% / Rst: 19:00 · Weekly: 97% / Rst: 10/16, 03:00 · $12.34`, with the full table in the tooltip.
- Thresholds now count percent **used**: `claudeTracker.warningAtUsedPercent` (default 75) and `claudeTracker.criticalAtUsedPercent` (default 90). They replace the old "% left" settings, which were removed.
- `claudeTracker.statusBarHighlight`: `background` (default) fills the entry with the theme's warning or error background; `text` colours only the text.
- `claudeTracker.statusBarShowResets` toggles reset times in the status bar.
- The 5H and Weekly pills are back on the "Usage" title row, with a compact "↻ 2h 12m" reset label (full time on hover). The date ranges stay centred, and move to a second row when the panel is narrower than 1440px.
- Model × effort groups in "Tokens by Model & Reasoning" use a high-contrast palette.

## 0.4.0 — 2026-10-14

- Rate limits are polled every `claudeTracker.limitsPollMinutes` minutes (default 5) by running Claude Code's local `/usage` command. It makes no model call and uses no tokens, and it works from the VS Code chat panel. New command: **Claude Tracker: Refresh Rate Limits Now**.
- 5H and Weekly pills moved under the "Usage" title.
- "Tokens by Model & Reasoning" can select Model and Reasoning Effort together, for groups such as "Opus 5.5 · high".
- Panel and card titles use Title Case.
- Added `docs/publishing-to-marketplace.md`.

## 0.3.0 — 2026-10-14

- "Claude Code" terminal profile in the terminal + menu, plus a "Claude Tracker: Open Claude Code in Terminal" command. Uses `claudeTracker.claudePath`, then `claude` on PATH, then the CLI bundled with the Claude Code extension.
- Clearer bridge banner: rate limits only arrive from terminal sessions, not the VS Code chat panel.

## 0.2.0 — 2026-10-14

- New "Tokens by model & reasoning" card: stacked usage over time by model or by reasoning effort, with all-token, fresh-input, output and thinking views and a per-group table.
- New ranges: 1D (rolling 24 hours), 2W and 3W.

## 0.1.0 — 2026-10-14

- First release: status bar windows, panel dashboard, statusline bridge, CSV/JSON export, threshold notifications.
