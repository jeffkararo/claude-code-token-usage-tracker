# Usage Tracker for Claude Code

> Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.

A VS Code extension that shows how you use Claude Code. It puts your 5-hour and
weekly rate-limit windows in the status bar, and adds a panel dashboard with
API-equivalent spend, tokens, prompt caching, models, projects, sessions, tool
calls and when you work.

The look and layout are modelled on
[VSCode Codex Tracker](https://github.com/ITFinesse/VSCode-Codex-Tracker) by
ITFinesse, rebuilt for Claude Code's data sources. No code is shared with that
project.

![The dashboard: rate-limit meters with a time marker, API-equivalent spend, live sessions, cache and token charts](docs/images/dashboard.png)

*Screenshots use made-up sample data.*

## Features

- **Status bar:** `5H 63%` and `W 59%` (remaining or used) coloured by your
  thresholds, plus today's cost. The tooltip shows each window's reset time,
  burn rate and projected run-out time.
- **Limit meters with pace:** each window's bar has a marker for how much of the
  window's time is left. When usage moves ahead of that marker, you are burning
  faster than an even pace. Projections use the recent history of the
  bridge-reported percentage.
- **API-equivalent spend:** an estimate at Anthropic list prices, with each
  token class priced separately: input, output, cache reads, and cache writes
  at both the 5-minute and 1-hour TTLs. It also covers fast mode, Haiku 5.5
  long-context rates and web searches. Optionally, set your plan price to see
  how much API-equivalent value your subscription delivered this month.
- **Cache insight:** hit rate, dollars saved by caching, and live cache
  warm/cold state with a countdown to expiry.
- **Live sessions:** every running Claude Code session, with model, effort,
  context-window gauge, session cost, lines changed and cache state.
- **Tokens by model & reasoning:** a stacked chart over time, grouped by model
  or by the reasoning effort each turn ran at (low to max). It can show all
  tokens, fresh input, output or thinking tokens. A table lists each group's
  tokens, thinking share of output and cost.
- **Breakdowns:** spend and prompts over time, stacked token chart, model
  doughnut, projects, tool-call counts, and a weekday × hour heatmap.
- **Ranges:** Today (since midnight), 1D (rolling 24 hours), 7D, 2W, 3W, 30D,
  90D, 1Y and All.
- **Prompt history:** a searchable, sortable table with the tokens and cost
  attributed to each prompt, subagent work included. Click a row to open its
  transcript.
- **Sessions:** titles, prompts, calls, subagent cost, and a button that copies
  `claude --resume <id>`.
- **Export:** prompt history as CSV, or a usage summary without prompt text as
  JSON.
- **Threshold notifications** when a window crosses the warning or critical
  level.
- **Draggable, resizable cards**, with each card's visibility toggleable.
  Layouts are stored globally or per workspace.

## Data sources

| Data | Source | Setup |
| --- | --- | --- |
| Tokens, costs, prompts, projects, tools | `~/.claude/projects/**/*.jsonl` transcripts, read incrementally | None |
| Running sessions | `~/.claude/sessions/<pid>.json` | None |
| 5-hour and weekly limits | Claude Code's local `/usage` command, run every few minutes (`claudeTracker.limitsPollMinutes`, default 5) | None; it uses the Claude Code CLI or the copy bundled with the Claude Code extension |
| Live context window, prompt cache, gateway spend limit, and limits between polls | Claude Code's [statusline](https://code.claude.com/docs/en/statusline) JSON, saved by the bridge | **Connect the bridge** once |

### Limit polling

Every `claudeTracker.limitsPollMinutes` minutes (default 5, `0` turns it off),
the extension runs `claude -p /usage --output-format json --no-session-persistence`.
Claude Code answers `/usage` locally: there is no model call, it uses no tokens
and writes no transcript. The extension reads the "Current session" (5-hour)
and "Current week" lines. This works even if you only use the VS Code chat
panel. If a future Claude Code version ever sent `/usage` to the model,
the extension notices the cost, stops polling and tells you.
**Usage Tracker: Refresh Rate Limits Now** polls on demand, and so does the
dashboard's ⟳ button.

### The statusline bridge

Claude Code passes a JSON snapshot to the configured `statusLine` command after
each response. For Pro and Max subscribers this includes `rate_limits`. Run
**Usage Tracker: Connect Statusline Bridge** to:

1. copy `statusline-bridge.js` to `~/.claude/claude-code-tracker/`,
2. back up `~/.claude/settings.json` to `settings.json.claude-tracker.bak`,
3. set `statusLine` to `node "<that script>"`.

If you already had a status line, the bridge saves the data and then runs your
command with the same input, so your status line keeps working. **Disconnect**
restores the previous setting. The bridge needs Node.js on `PATH`, and it writes
only to `~/.claude/claude-code-tracker/`.

**The VS Code chat panel does not run statusline commands**, so it never
sends limits. Rate limits arrive only from Claude Code running in a terminal.
The extension adds a **Claude Code** entry to the terminal **+** menu (and the
command **Usage Tracker: Open Claude Code in Terminal**). That entry runs
`claudeTracker.claudePath`, otherwise `claude` on PATH, otherwise the CLI
bundled with the Claude Code extension. One prompt there refreshes the limits
for your whole account.

Rate limits only update while Claude Code is running and responding. A window
whose reset time has passed is shown as `N/A`, not with its old value. A value
older than 30 minutes is marked stale (`~`).

![Tokens by model and reasoning effort](docs/images/tokens-by-model-and-reasoning.png)

## Customising levels and colours

Three levels apply to the 5-hour and weekly windows, and the thresholds are always
expressed as percent **used**, whichever way you display limits:

| Level | When | Colour setting |
| --- | --- | --- |
| Normal | below `warningAtUsedPercent` (default 75) | `normalColor` |
| Warning | from `warningAtUsedPercent` up to `criticalAtUsedPercent` (default 90) | `warningColor` |
| Critical | `criticalAtUsedPercent` and above | `criticalColor` |

In the dashboard's ⚙ settings, **Thresholds & Colours** has the numbers, three colour
pickers, three presets (traffic light, colour-blind safe, high contrast) and a live
preview of each level's range in the display mode you picked, for example
"Warning 25–11%" when showing what is left. **Reset colours** returns all three to
their defaults. Colours must be hex (`#rgb` or `#rrggbb`); anything else is ignored.
If critical is set below warning, it is raised to match warning.

In the status bar, `claudeTracker.statusBarHighlight` chooses between filling the
entry with the theme's warning/error background (the only background colours VS Code
allows) and colouring the text with your three colours.

## Appearance

The dashboard's colours are configurable in the ⚙ settings under **Appearance**, or in
settings.json. Changes preview live while the drawer is open and revert if you close it
without saving.

| Setting | Default | What it controls |
| --- | --- | --- |
| `claudeTracker.theme` | `vscode` | Base colours: `vscode` follows your editor theme; `dark`, `light` and `highContrast` fix the background, cards, text and borders |
| `claudeTracker.colors` | `{}` | Overrides on top of the theme: `accent`, `marker` (the time-remaining line), `background`, `surface` (cards), `text`, `mutedText`, `border` |
| `claudeTracker.chartPalette` | `default` | Chart, bar, legend and heatmap colours: `default`, `colorBlindSafe`, `cool`, `warm`, `vivid` or `custom` |
| `claudeTracker.customChartColors` | `[]` | Up to ten hex colours, used when the palette is `custom` |

The normal, warning and critical colours (above) are separate and apply on any theme.
The VS Code status bar always follows your editor theme, apart from those three colours,
because extensions cannot restyle it any further.

**Recommendation.** Keep `theme` on `vscode`: your editor theme already has readable
text and backgrounds, and the dashboard then matches the rest of VS Code. Choose
`colorBlindSafe` for charts if orange, green and red are hard to tell apart, since its
colours (Okabe-Ito) stay distinguishable with the common forms of colour-vision
deficiency. Only override text and background together, and keep their contrast at
**4.5:1 or higher**; the drawer shows the ratio live and a warning appears when you save
something hard to read. Use `highContrast` if you need maximum separation.

## Privacy

Everything is local. The extension reads Claude Code's own files and makes no
network requests. Prompt text never leaves the dashboard unless you export it.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `claudeTracker.claudeDir` | *(empty)* | Claude config dir; empty uses `CLAUDE_CONFIG_DIR`, then `~/.claude` |
| `claudeTracker.defaultRange` | `7d` | Range the dashboard opens with (`1d`, `24h`, `7d`, `14d`, `21d`, `30d`, `90d`, `365d`, `all`) |
| `claudeTracker.quotaDisplay` | `remaining` | Show limits as `remaining` or `used`: status bar, pills, meters, mini bars, pace wording and notifications all follow it (also a one-click "Showing: Left/Used" button in the dashboard) |
| `claudeTracker.warningAtUsedPercent` | `75` | % of a window used that turns it to warning (orange) |
| `claudeTracker.criticalAtUsedPercent` | `90` | % of a window used that turns it to critical (red) |
| `claudeTracker.statusBarHighlight` | `background` | `background` fills the entry with the theme's warning/error background (the only background colours VS Code allows); `text` colours the text instead |
| `claudeTracker.statusBarShowResets` | `true` | Show reset times in the status bar |
| `claudeTracker.theme` / `chartPalette` / `customChartColors` / `colors` | see [Appearance](#appearance) | Dashboard colours |
| `claudeTracker.normalColor` | *(empty)* | `#rrggbb` for a window below the warning threshold; empty uses the theme colour (status bar) and Claude orange (dashboard) |
| `claudeTracker.warningColor` | `#e8a23a` | Colour at or above the warning threshold (dashboard always; status bar when highlight is `text`) |
| `claudeTracker.criticalColor` | `#e5484d` | Colour at or above the critical threshold (same rules) |
| `claudeTracker.notifyOnThreshold` | `true` | Notify when a window crosses a threshold |
| `claudeTracker.showCostInStatusBar` | `true` | Include today's cost in the status-bar entry |
| `claudeTracker.planMonthlyPriceUsd` | `0` | Your plan price, for the value multiple |
| `claudeTracker.pricingOverrides` | `{}` | Per-model price overrides (USD per million tokens) |
| `claudeTracker.historyLimit` | `200` | Prompts sent to the table |
| `claudeTracker.layoutScope` | `global` | Store card layout globally or per workspace |
| `claudeTracker.limitsPollMinutes` | `5` | Minutes between `/usage` limit reads; `0` disables |
| `claudeTracker.claudePath` | *(empty)* | Claude Code CLI path; empty uses PATH, then the CLI bundled with the Claude Code extension |
| `claudeTracker.pollIntervalSeconds` | `60` | Fallback rescan interval (file events refresh sooner) |
| `claudeTracker.outputDebug` | `false` | Verbose output channel logging |

## Development

```powershell
npm.cmd install
npm.cmd run compile     # copies Chart.js into media/ and builds out/
npm.cmd test            # node:test suites for pricing, parsing, aggregation and the bridge
npm.cmd run verify      # lint + tests
npm.cmd run package     # verify, then build a .vsix
```

Press `F5` to launch an Extension Development Host. Install a build with
**Extensions: Install from VSIX…**.

| Path | Role |
| --- | --- |
| `src/transcripts.ts` | Incremental JSONL tailing, dedupe by message id, human-prompt detection |
| `src/pricing.ts` | Model price table and cost maths |
| `src/aggregate.ts` | Pure function from records to the dashboard model |
| `src/bridgeData.ts` / `src/bridgeInstall.ts` | Reads bridge snapshots / connects and disconnects the statusline |
| `src/statusBar.ts`, `src/dashboard.ts`, `src/extension.ts` | VS Code integration |
| `media/dashboard.js`, `media/dashboard.css` | Webview UI (Chart.js) |
| `resources/bridge/statusline-bridge.js` | The script Claude Code runs |

## Publishing

See [docs/publishing-to-marketplace.md](docs/publishing-to-marketplace.md).

## License

MIT.
