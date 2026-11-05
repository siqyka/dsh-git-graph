# dsh-git-graph

> 🧭 **A ready-to-use git visualizer for the DSH ecosystem.** An embedded git tool for the DeepSeek Harness (DSH) Web GUI: GitHub-style commit graph, branch management, code diffs, and a VSCode-style uncommitted changes panel — all inside your AI session, no need to switch to another git client.

An embedded git repository graph visualizer for the DeepSeek Harness (DSH) Web GUI.

View, browse and manage git repositories right inside the harness conversation — commit history graph, branch filtering, commit details, file diffs and working-tree changes, all embedded in the interface without leaving the current session. See at a glance what changed, who changed it, and whether to commit.

**Who it's for**: developers doing AI coding / agent development with DeepSeek Harness; git users who want commit history, branches and working-tree changes in one view; developers and teams looking for a more visual git tool than the command line.

> 🔍 Search keywords: DSH plugin · DeepSeek Harness plugin · git visualization · git graph · commit history · branch management · code diff · VSCode-style changes panel · git productivity tool · AI coding assistant

> 🛠 This plugin is developed with AI assistance.

![Git 图谱](https://img.shields.io/badge/DSH-Plugin-58a6ff)

## 📸 Preview

<img src="assets/git-graph-demo.png" alt="Git Graph demo" width="720">

## ✨ Features

- **Commit history graph**: GitHub-style commit list with foldable per-branch groups and branch coloring (local and remote branches each get their own group)
- **Follows the current session (workspace auto-detection)**: automatically resolves the current session's working directory and shows its git repository; **switching the working copy switches the graph to that repo automatically (v0.20)** — no manual refresh needed when changing sessions or workspaces. The "last picked repo" memory is kept per workspace, so it neither bleeds across workspaces nor makes the graph ignore a switch. Non-git workspaces show an empty state with a 「🖥 Find git repos in the current session directory」 button that shallow-scans the workspace and its subdirectories
- **📂 Open folder (v0.11)**: not limited to the current session workspace — click "Open" in the top bar (or "Open folder" in the empty state) to browse the disk (drives → folders, with git markers), pick any folder (e.g. a repo B in another workspace) and view its version control; added repos persist, switch via the top dropdown any time, and they survive a page refresh
- **Branch filtering**: checked = visible, unchecked = fully hidden (empty selection shows an empty list)
- **Commit details**: commit message, changed files, per-file diffs, compare two commits (Ctrl+click), 📜 file history (every commit touching a file); the detail panel is **resizable** — drag the splitter, double-click it to reset, and the width is remembered
- **Uncommitted changes (VSCode-style, persistent at the top of the graph)**: grouped file lists (Staged / Changes / Untracked), status badges (A/M/D/R/U/?), per-file +/− line counts, click-to-expand per-file diff (syntax highlighted), renames `old → new`, untracked file contents; the ☑ groups toggle hides any group, and both the panel and each group fold on click; **per-row stage/unstage/restore, top-bar stage-all/commit, checkboxes for batch actions (stage/unstage/restore/ignore/commit selected)** (destructive actions ask for confirmation first); the commit dialog can **✨ AI-generate a commit message** (heuristic candidates from the diff, editable)
- **Right-click menu**: copy hash/message, view details, 🏷️ tag a commit (rename/delete tags too), 🌿 create a branch from this commit, 🌐 open the GitHub commit page, copy repo path, open in file manager
- **Remote/branch operations**: top-bar `⬇ Fetch` (git fetch) and `⬆ Push` (git push current branch, confirmed first); branch-group right-click — local branches: 🔄 switch / ⬆ push / 🗑️ delete (merged-only, HEAD protected), remote branches: ⬇ fetch / copy remote branch name
- **Remote branches always visible**: remote group headers render even when fully synced with a local branch, labelled 「已同步」(synced) or 「已包含」(contained)
- **Auto-update (degrades by mount type)**: on normal installs it silently checks the latest GitHub tag when the graph opens; when a newer version exists the top bar shows 「🔄 新版本 vX.Y」— one click downloads and swaps the plugin files (old files are backed up, failures roll back automatically), then a restart applies it. When the plugin is mounted from a git checkout (`link:`), the update button hides automatically and the UI suggests `git pull` instead — files owned by git are never overwritten
- **State memory**: branch filter, group toggles, fold states and theme. **Since v0.22 these are stored on disk** (`.state/prefs.json` next to the plugin), so they survive a DSH restart or port change — localStorage is origin-scoped and used to reset silently when the port moved (keys unified to `gg2-*` since v0.8; branch groups are expanded by default on first open)
- **Multi-repo switching**: a dropdown at the top of the graph page switches between repos
- **Large-repo support**: the first screen loads 50 commits; scrolling down pulls 100 more per step (only when you reach the bottom, never pre-fetching everything). Commit details, per-file diffs and file history are cached in memory, so re-opening one costs no request
- **Cache scope**: the cache lives only in the current page's memory (Maps) and is released when the plugin tab closes, the page reloads or the app restarts — nothing is written to localStorage, so no stale data can survive. It is also cleared explicitly on repo switch and after any git write operation
- **Low overhead (v0.19)**: every endpoint launches `git` only when it must — **the branch list and the 5s change probe read the ref files under `.git` directly (zero processes)**, the branch name comes from `.git/HEAD`, repo validity from the `.git` entry, commit details from a single `show --stat`, a single-file diff from one `show`, `numstat` is skipped on a clean tree, and the commit total is fetched asynchronously so it never delays the first paint. On machines where process creation is slow (real-time AV) a single `git` launch can cost hundreds of milliseconds, so this is what "reading history feels fast" comes down to: `branches` went from 871ms to **1–2ms**, the 5s poll from one process per tick to **zero**, and the first screen needs just one process
- **Keyboard shortcuts**: `Ctrl+F` search, `Ctrl+/` shortcut panel, `Ctrl+B` fold/unfold all branch groups, `↑↓`/`j`/`k` navigation, `Enter` details, `Esc` close
- **Auto refresh**: while the page is visible it polls every 5s with a lightweight `for-each-ref` signature and updates the stats bar and list when the working tree or new commits change
- **Theme system**: auto-follow / dark / light, plus **8 style presets** (same set as 拾光记) — 🌸 sakura (falling petals), 🌊 ocean (waves/bubbles/fish), 🌲 forest (trees/leaves/fireflies/butterflies), 🌙 night (stars/moon/meteors), 🍬 candy (rainbow/ribbons/lollipops), 💼 business (geometric shapes/glass blocks), ✨ starry (stars/moon/meteors/earth), 🤖 tech (circuits/gears/chips), each with its own animated background (ocean/tech/business/candy have higher element density)
- **Mount point**: the "Git 图谱" tab inside the session pane (next to the trajectory tab)

## 📦 Installation

### Option 1: one-line install via the official CLI (recommended)

```bash
# Install from GitHub
dsh plugin --profile web add github:siqyka/dsh-git-graph

# Or install from npm (scoped package name, see "Distribution" below)
dsh plugin --profile web add @<scope>/dsh-git-graph
```

Restart `dsh web` afterwards. The command registers the plugin as a profile bundle (`dsh.profile.bundles`) automatically and checks `peerDependencies["@deepseek-ai/dsh"]` against your running DSH — incompatible combinations are rejected with a reason.

### Option 2: local directory mount (developers / offline)

```bash
dsh plugin --profile web add link:<path to this repository>
```

`link:` mounts the repository directory directly — after editing code, a `dsh web` restart shows your changes (no file copying).

### Optional: fixed repo allowlist

**No configuration is required by default** — the graph auto-discovers git repositories in the current session workspace, and the "📂 Open" button lets you browse and add any folder's repo on the fly (picks are remembered). To pin an allowlist, add `config` to the plugin row in your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: git-graph
      name: dsh-git-graph
      config:
        repo: "C:/path/to/your/repo"   # or repos: [ ... ]
```

Open http://127.0.0.1:3080 and select the **Git 图谱** tab in any session.

> **Permissions & provenance**: the plugin runs read-only `git` commands (graph/diff/log)
> inside directories you authorize; write operations (stage/commit/push…) always ask for
> your confirmation in the graph page. **Self-update degrades by mount type**: when mounted
> from a git checkout (`link:`) the one-click update is disabled (so it never rewrites files
> your git owns) — upgrade with `git pull` in the plugin repository instead; other install
> shapes keep the GitHub one-click self-update (with backup and rollback). Compatibility
> declarations and isolated-test evidence live in [docs/compatibility.md](docs/compatibility.md);
> run `node scripts/check-compat.mjs` before releases to verify coverage of the official
> latest/next release window.

### Distribution

- **GitHub**: this repository carries the `dsh-plugin` topic; `dsh plugin add github:…` installs directly
- **npm**: `@<scope>/dsh-git-graph` (published under the scope from `npm whoami`; run `npm run publish:npm` for the pre-publish check chain)

### Compatibility range

Declared in `package.json`: both `engines.dsh` and `peerDependencies["@deepseek-ai/dsh"]` are `>=0.1.0-rc.6 <0.3.0`. Isolated tests (separate `DSH_HOME`, full add → dump-config → remove cycle) pass on **0.1.7-rc.2** (latest stable track) and **0.2.0-rc.1** (next preview track); evidence in [docs/compatibility.md](docs/compatibility.md).

## 🖱️ Usage

| Action | Description |
| --- | --- |
| "Git 图谱" tab in a session | Open the graph for the current session's workspace |
| 📂 Open / empty-state "Open folder" | Browse the disk and pick any git repo (e.g. folder B in another workspace); it is added and its graph is shown (v0.11) |
| Repo dropdown at the top | Switch repositories - the repo label to its left shows the full path |
| Branch group header | Click to fold / unfold that branch |
| ☑ Branch filter | Checked = visible, unchecked = fully hidden |
| "未提交改动" block at the top of the graph | Staged / Changes / Untracked overview (incl. untracked files); click a file row to expand its diff; per-row stage/unstage/restore; batch actions via checkboxes |
| Commit row | Click for details; Ctrl+click to compare with another commit |
| Splitter left of the detail panel | Drag horizontally to resize the panel; double-click to reset (width is remembered, min 260px) |
| Right-click a commit row | Copy / details / tag / create branch from commit / open GitHub commit page / copy repo path / open in file manager |
| "未提交改动" status line | Click to scroll to the top changes block |
| ↻ Refresh | Reload repository data |

## 🛠️ Development

```
git-graph/
├── index.js          # Server half: git API (graph/branches/workstatus/workfile/diff/...)
├── client.js         # Client half: "Git 图谱" session tab
├── web/index.html    # The graph page (standalone page inside an iframe)
├── package.json      # Plugin manifest (dsh.client + bundle patch + peerDependencies)
├── cordis.patch.yml  # Profile mount point
└── scripts/          # check-compat.mjs / publish.mjs / compat-isolated-test.ps1
```

Development workflow (single source of truth = this repository, mounted into the profile via `link:`):

```bash
# One-time mount (no need to repeat after code changes)
dsh plugin --profile web add link:<path to this repository>

# After editing
node --check index.js client.js   # syntax check (same for the web/index.html inline script)
# Restart dsh web to apply (index.js / client.js changes need a restart; web/index.html only needs a refresh)
```

Release flow: `npm run check:compat` (official window coverage) → `pwsh -File scripts/compat-isolated-test.ps1` (isolated tests on anchor versions) → bump version → `npm run publish:npm` (after scoping the name) → `git commit` → `git tag vX.Y` → push. See `AGENTS.md` for full development conventions.

## 📄 License

[MIT](./LICENSE)

## 🙏 Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/) — the plugin platform
