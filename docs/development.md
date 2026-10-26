# Development

```powershell
npm.cmd install
npm.cmd run compile     # copies Chart.js into media/ and builds out/
npm.cmd test            # node:test suites for pricing, parsing, aggregation, the bridge and the stub-host run
npm.cmd run verify      # lint + tests (what CI runs)
npm.cmd run package     # verify, then build a .vsix
npm.cmd run screenshots # regenerate docs/images from made-up sample data (needs Edge or Chrome)
```

Press `F5` to launch an Extension Development Host. Install a build with
**Extensions: Install from VSIX…**.

## Layout

| Path | Role |
| --- | --- |
| `src/transcripts.ts` | Incremental JSONL tailing, dedupe by message id, human-prompt detection |
| `src/pricing.ts` | Model price table and cost maths |
| `src/aggregate.ts` | Pure function from records to the dashboard model |
| `src/bridgeData.ts` / `src/bridgeInstall.ts` | Reads bridge snapshots / connects and disconnects the statusline |
| `src/usagePoller.ts` | Runs `claude -p /usage` to read the 5-hour and weekly limits |
| `src/statusBar.ts`, `src/dashboard.ts`, `src/extension.ts` | VS Code integration |
| `media/dashboard.js`, `media/dashboard.css` | Webview UI (Chart.js) |
| `resources/bridge/statusline-bridge.js` | The script Claude Code runs |
| `scripts/make-screenshots.cjs` | Builds a throwaway Claude config dir of sample data, runs the real extension against a stub `vscode`, and photographs the real webview in headless Edge or Chrome |

## Screenshots

`npm.cmd run screenshots` rewrites `docs/images/*.png`. It never reads or writes `~/.claude`: it seeds a temporary
directory, uses a fixed random seed, and deletes the directory afterwards. The dates in the images are the day you run
it. Re-run it after UI changes and at each release, because the settings shot prints the version number.

The status-bar screenshot is not generated: it has to come from a real VS Code window. Crop it tightly so it shows only
the status-bar entry.

## Releasing

See [publishing-to-marketplace.md](publishing-to-marketplace.md).
