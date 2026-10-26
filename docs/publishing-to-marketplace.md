# Publishing to the VS Code Marketplace

This guide takes Claude Code Token Usage Tracker from a local `.vsix` file to a public
listing that anyone can install from the Extensions view. It assumes no prior
publishing experience. Facts about Marketplace rules were checked against
Microsoft's [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
page on 2026-10-17; re-check it before you publish, because these rules change.

There are two marketplaces:

| Marketplace | Used by | Tool |
| --- | --- | --- |
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/vscode) | VS Code | `vsce` (a dev dependency) |
| [Open VSX](https://open-vsx.org) | Cursor, Windsurf, VSCodium, Gitpod and other VS Code forks | `ovsx` |

Publishing to the first is enough for VS Code users. Publish to both if you want
users of VS Code forks to find it too.

## 0. Decide these before the first publish

Some choices cannot be undone afterwards:

| Choice | Why it is permanent |
| --- | --- |
| Extension **name** and **display name** | The Marketplace requires both to be unique, and after an extension is removed the name "is permanently reserved and cannot be reused". Unpublishing does not free it. |
| **Publisher ID** | It "cannot be changed once created", and it is part of every install ID (`<publisher>.<name>`). |
| Publisher **display name** | Any change revokes the verified-publisher badge once you have one. |
| Version numbers | A version can only be uploaded once. The first Marketplace version is **1.0.0** (section 2). |

So settle the name (section 1) and the publisher (section 4) first.

## 1. The name

"Claude" and "Claude Code" are Anthropic's names, and Anthropic's published rules limit how
others may use them. As read on 2026-10-17 (read the current pages again before you commit to
a name):

- The [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance) says you
  "can accurately say, in plain text, that your product has Claude Code preinstalled or that it
  runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your
  own product, feature, or company name, in your own logo, or in a way that suggests Anthropic
  built, endorses, or is partnered with your product." That passage is written for products that
  preinstall or run Claude Code, which is close to what this extension does: it runs the user's
  own `claude` command.
- The [Trademark Guidelines](https://www.anthropic.com/legal/trademark-guidelines) say the
  trademarks "include our names, logos, brand elements, and anything we use to identify our goods
  and services", that you "may only use our trademarks as specifically permitted by us", and that
  you "may not use our trademarks in a manner that implies Anthropic's sponsorship or endorsement,
  or a relationship or affiliation with Anthropic".

Read literally, the first passage rules "Claude Code" out of a product name. **The owner of this
project has decided to keep it in the display name ("Claude Code Token Usage Tracker") and accepts
that risk.** To reduce it:

- the Command Palette prefix, panel and messages say only **"Token Usage Tracker"**;
- the extension ID (`token-usage-tracker`), the publisher (`kararo-consulting`) and the company
  name do not contain Claude's names;
- no Anthropic logos or lookalike marks are used (the dashboard icon is a plain gauge);
- the README opens with *"Not affiliated with or endorsed by Anthropic. Claude and Claude Code are
  trademarks of Anthropic, PBC."*;
- if Anthropic ever objects, the display name can be changed in a new version (as far as is
  known), but the extension ID cannot, which is why the ID is neutral.

This is not legal advice. For certainty, ask Anthropic (the guidelines give
marketing@anthropic.com for permission requests) or a lawyer. Many existing Marketplace extensions
have "Claude" in their names; the Marketplace allows that, but it is not permission from Anthropic.

There are two names to get right:

- the **display name** shown in the Marketplace and the Extensions view, and
- the **command category**, the prefix in the Command Palette (`Token Usage Tracker: Show Panel`).
  It is the `category` of every command in `package.json`.

### Check what already exists

```powershell
npm.cmd run check-name -- "Name One" "Name Two"
npm.cmd run check-name -- --categories "Name One"     # also reads other extensions' command categories (slower)
```

The script (`scripts/check-marketplace-name.cjs`) is read-only. It searches the public
Marketplace and Open VSX and reports exact and near matches for each name. It cannot do
everything:

- The Marketplace has no search for command categories. `--categories` reads the manifests of
  the extensions the searches turn up (a few hundred), so it shows conflicts among
  those, not among all of the Marketplace's extensions.
- It does not check trademarks or other registries. Search the USPTO database and the web
  for a name before you commit to it.

### Results on 2026-10-17

- **Chosen: "Claude Code Token Usage Tracker".** No exact match on the Marketplace or Open VSX,
  and "Token Usage Tracker" is not a command category in any of the 80 manifests checked. Nearest
  neighbour: *Codaude: Claude Code & Codex Token Usage Tracker* (26 installs).
- **Taken, so not usable:** **Claude Code Usage Tracker** (`YahyaShareef.claude-code-usage-tracker`,
  about 14,900 installs), **Claude Code Token Tracker** (`claude-token-tracker.claude-code-token-tracker`,
  about 2,200 installs, plus a near twin), **Claude Code Usage Monitor** and **Claude Code Usage
  Dashboard**. Also taken or too close: **Headroom**, **Redline**, and **Pacer** (*Pacer for GitHub
  Copilot*).
- **Fallbacks without Claude's names**, free on both marketplaces on 2026-10-17 if the name ever has
  to change: **Quota Compass, Burn Gauge, Token Beacon, Fuel Gauge, Token Tally, Usage Compass,
  Rate Gauge, Quota Radar**.

### Changing the name before 1.0.0

Edit, in `package.json`: `name`, `displayName`, every command's `category`, the
`viewsContainers` and `views` titles, and `configuration.title`; then the README title and
`docs/`. Rename the GitHub repository (**Settings → General → Repository name**; GitHub
redirects the old URL) and update `repository`, `bugs` and `homepage`. Keep the
`claudeTracker.*` setting and command IDs unless you accept resetting everyone's saved settings.

## 2. Versioning

- **Versions below 1.0.0 are development builds** (they appear on GitHub as pre-releases).
  They are not published to the Marketplace.
- **The first Marketplace release is 1.0.0.** Set it when you are ready to publish:
  `npm.cmd version 1.0.0 --no-git-tag-version`, then add a `## 1.0.0` section to `CHANGELOG.md`.
- After that, use [semantic versioning](https://semver.org): patch for fixes, minor for features,
  major for breaking changes.
- The Marketplace supports only `major.minor.patch`, not semver pre-release tags such as
  `1.1.0-beta`. Microsoft recommends **even minor numbers for releases and odd minor numbers
  for pre-releases**, and pre-release and release versions must differ. For example:

  | Version | Channel |
  | --- | --- |
  | 1.0.0, 1.0.1 | release |
  | 1.1.0, 1.1.1 | pre-release (`vsce publish --pre-release`) |
  | 1.2.0 | release |

  Pre-release support needs `engines.vscode` of 1.63.0 or higher; this extension requires 1.95.

## 3. Prepare the extension

### 3.1 GitHub repository

The source lives at <https://github.com/jeffkararo/claude-code-token-usage-tracker>. The
`repository`, `bugs` and `homepage` fields in `package.json` point to it. Without them,
`vsce` cannot rewrite the README's relative links and image paths into working URLs.

### 3.2 The listing

The Marketplace page shows `README.md`, so that file is your storefront.

- **Screenshots:** `docs/images/` holds sample-data screenshots, referenced from the README
  with relative paths. `npm.cmd run screenshots` regenerates all of them from made-up data (it
  never touches `~/.claude`); run it at each release, because the settings shot prints the
  version. Because `repository` is a GitHub URL, `vsce` rewrites the paths to HTTPS
  URLs when it packages, **so the images must be pushed to GitHub's `main` branch before the
  listing is uploaded**, or they show as broken. The one shot the script cannot make is the
  status bar: it needs a real VS Code window. The Marketplace rejects plain `http` and SVG images (except badges
  from approved providers). If you move to a non-GitHub host, pass `--baseImagesUrl` and
  `--baseContentUrl` to `vsce`.
- **Icon:** `resources/icon.png` is 128×128 PNG, which meets the requirement. Run
  `npm.cmd run icon` to regenerate it.
- **Changelog:** keep `CHANGELOG.md` current. It shows on the listing's Changelog tab.
- **Keywords and categories** in `package.json` drive search. At most 30 keywords are allowed.
- Optional: add `"galleryBanner": { "color": "#1f1a24", "theme": "dark" }` and
  `"pricing": "Free"`.

### 3.3 Build and test the exact package

```powershell
cd P:\claude-code-tracker
npm.cmd run package          # lint, tests, then builds the .vsix
npx.cmd vsce ls              # lists the files that will ship
```

Install the `.vsix` with **Extensions: Install from VSIX…** and try it once more.
It is what users will get.

## 4. Create the publisher for Kararo Consulting LLC

A Marketplace **publisher** is a profile that owns extensions. Its owners are Microsoft
accounts; the Marketplace does not check that a publisher is a registered company.
Here is how to make it Kararo Consulting LLC's.

### 4.1 Pick the account that will own it

Use a Microsoft account that the LLC controls and that will outlive any one person's
personal login: for example a work account on the kararo.com Microsoft Entra tenant, or a
dedicated company Microsoft account. Avoid a personal Outlook or Hotmail account. You can
add more members later, so that ownership does not depend on one login.

### 4.2 Create the publisher

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with that account.
2. Choose **Create publisher** in the left pane.
3. Fill in:
   - **Name:** `Kararo Consulting LLC`. This is displayed on every listing, and the
     official page says it "can be your company or brand name". Spell it exactly as you want
     it permanently, because changing it later revokes a verified badge.
   - **ID:** permanent, shown in URLs and install IDs (lowercase letters, numbers and hyphens).
     The ID can differ from the name.
4. Optionally add a logo, website (<https://kararo.com>), and support and source links.
5. Click **Create**, then set the ID as `"publisher"` in `package.json`.

**Done:** the publisher **Kararo Consulting LLC** exists with ID **`kararo-consulting`**, and
`package.json` uses it, so the extension ID will be `kararo-consulting.<name>`.

### 4.3 Add members (optional)

On the publisher's page, open **Members** to add other Microsoft accounts as owners or
contributors, so the LLC is not tied to one person.

### 4.4 Verified publisher badge (later)

The blue check shows that you control a domain. The requirements, as documented:

- the publisher has had at least one extension on the Marketplace for **6 months or more**,
- the domain's registration is **at least 6 months old**,
- you can add a DNS TXT record to the domain, it is not a subdomain, it uses HTTPS and it
  returns HTTP 200 to a HEAD request.

Then: publisher **Details → Verified domain**, enter `kararo.com`, **Save**, **Verify**, add the
TXT record the dialog shows, and **Verify** again. Microsoft responds within about 5
business days. This verifies the domain, not the legal entity, so name the publisher
Kararo Consulting LLC and use the LLC's own domain.

## 5. Publish

### 5.1 First publish: upload the file in the browser

The simplest route needs no tokens at all:

1. Set the version (section 2: `1.0.0`) and run `npm.cmd run package`. This produces
   `token-usage-tracker-1.0.0.vsix` in the project folder.
2. Make sure the commit with the README and `docs/images/` is pushed to `main` on GitHub.
3. Go to <https://marketplace.visualstudio.com/manage> and sign in with the Microsoft account
   that owns the `kararo-consulting` publisher.
4. Select the publisher, then **New extension → Visual Studio Code** (the wording on the
   button has varied: **Add an extension** is the same thing), and choose the `.vsix`.
5. The Marketplace verifies the package (it checks the manifest, scans for malware and for
   secrets). Wait for the status to change from *Verifying* to a green tick, usually a few
   minutes. If it fails, the page shows the reason. Fix it and upload again; if the
   Marketplace refuses the same version a second time, bump to 1.0.1.
6. Open `https://marketplace.visualstudio.com/items?itemName=kararo-consulting.token-usage-tracker`
   and check: the icon, the banner, every screenshot, the Changelog tab and the links.
   Pages can lag by a few minutes.
7. Install it from the Extensions view (search for the extension ID) in a clean VS Code
   profile and try it once: status bar, panel, connect and disconnect the bridge.

### 5.2 From the command line

**Personal Access Tokens (PATs) are being retired.** Microsoft's page states that on
**1 December 2026** global Azure DevOps PATs are retired, and recommends Microsoft Entra
ID instead. So a PAT only helps until then.

- **Microsoft Entra ID (recommended):** `vsce publish --azure-credential`. For automation
  Microsoft documents a user-assigned managed identity with a federated credential,
  added to the publisher as a member with the **Contributor** role. Follow the
  [current guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
  which describes it for Azure Pipelines. For interactive use, `az login` first; confirm on
  that page that this is still the supported route.
- **PAT (until 1 December 2026):** create it at <https://dev.azure.com> under your profile →
  **Personal access tokens**, with **Organization: All accessible organizations** (a single
  organization gives 401/403 errors) and **Scopes: Custom defined → Show all scopes →
  Marketplace → Manage**. Then `npx.cmd vsce login <publisher-id>` and `npx.cmd vsce publish`.
  Never commit or paste the token; revoke it on the same page if it leaks.

## 6. Publish updates

Each upload needs a higher `version`. Update `CHANGELOG.md`, then either upload the new
`.vsix` as in 5.1, or from the command line:

```powershell
npx.cmd vsce publish patch    # 1.0.0 -> 1.0.1  (fixes)
npx.cmd vsce publish minor    # 1.0.0 -> 1.1.0  (features; remember the odd/even convention in section 2)
git push --follow-tags
```

`vsce publish` in a git repository also creates a version commit and tag. Users with
auto-update on, the default, get the new version within a few hours.

To test with a few people first, publish with `vsce publish --pre-release` using an odd
minor version (for example 1.1.0). Users opt in with **Switch to Pre-Release Version**.

## 7. Also publish to Open VSX (optional, recommended)

1. Sign in at <https://open-vsx.org> with GitHub, then link an Eclipse account and sign the
   Publisher Agreement when prompted.
2. In your Open VSX profile, go to **Access Tokens** and generate a token.
3. Create your namespace once, then publish the same `.vsix`:

   ```powershell
   npx.cmd ovsx create-namespace <your-publisher-id> -p <open-vsx-token>
   npx.cmd ovsx publish <name>-<version>.vsix -p <open-vsx-token>
   ```

Open VSX still uses its own access tokens; the PAT retirement above only affects the Visual
Studio Marketplace.

## 8. Automating releases

`.github/workflows/ci.yml` already lints, tests and builds the package on every push and pull
request. For automatic publishing on a version tag, the missing piece is authentication to
the Visual Studio Marketplace: use a Microsoft Entra identity (section 5.2) rather than a
PAT, store its details and the Open VSX token as repository secrets
(**Settings → Secrets and variables → Actions**), and add a workflow triggered by `v*` tags
that runs `npm ci`, `npm run verify`, `npx vsce package --no-dependencies` and then publishes
the file with `vsce publish --packagePath`. Microsoft's guide describes the Entra setup; the
GitHub Actions specifics are not covered there, so test it with a pre-release version first.

## 9. After publishing

- **Statistics:** the manage page shows installs, ratings and acquisition.
- **Q&A and reviews** appear on the listing; reply to them there.
- **Verified publisher:** see section 4.4.
- **Unpublishing:** `npx.cmd vsce unpublish <publisher>.<name>` removes the listing. Users
  who already installed it keep their copy, and the name stays reserved.

## Checklist

- [ ] Final **name**, display name and command category chosen and checked (section 1)
- [ ] Publisher created as **Kararo Consulting LLC**, ID decided, `publisher` set in
      `package.json` (section 4)
- [x] Version set to **1.0.0** with a changelog entry (section 2)
- [x] README has screenshots, the Anthropic notice, and working links
- [ ] Screenshots and README pushed to GitHub `main`
- [ ] A real status-bar screenshot added to the README (optional but recommended)
- [ ] `npm.cmd run package` passes and the `.vsix` was tried by hand
- [ ] Uploaded in the browser (5.1), or published with Entra (5.2)
- [ ] Optional: Open VSX (section 7), verified domain (4.4), release automation (section 8)
