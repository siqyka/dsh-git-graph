# dsh-git-graph

**Ready-to-use git visualization inside DSH.** Commit history graph, branch management, diffs and working-tree changes, embedded in the DeepSeek Harness conversation pane — no switching to another git client while you work with AI.

[中文](./README.md) · [English](./README_EN.md) · ![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-58a6ff)

<img src="assets/git-graph-demo.png" alt="Git graph" width="760">

## Why it exists

- **Never leave the session**: the graph is a tab next to the trajectory tab. Switch workspaces and the graph follows to that repo automatically.
- **No waiting**: the first screen paints 50 commits and pulls more as you scroll. The branch list and the ref probe in the auto-refresh tick read ref files under `.git` directly — **no git process at all**. On machines where real-time AV makes each `git` launch cost hundreds of milliseconds, this is what "reading history feels fast" comes down to.
- **Not read-only**: stage, commit, restore, tag, switch branches, fetch and push from the page. Destructive actions always ask first.

## Install

```bash
# From GitHub
dsh plugin --profile web add github:siqyka/dsh-git-graph

# Or from npm
dsh plugin --profile web add @shiqyka/dsh-git-graph
```

**Restart `dsh web`** afterwards, open the address it prints, then pick the **Git 图谱** tab in any session (next to the trajectory tab).

**Developers / offline**: `dsh plugin --profile web add link:<path to this repo>` mounts the directory directly — edit code, restart `dsh web`, no file copying.

### Optional: fixed repo allowlist

**No configuration is required.** The graph discovers git repos in the current session workspace, and repos added through "Open folder" are remembered. To pin an allowlist, add `config` to the plugin row in your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: git-graph
      name: '@shiqyka/dsh-git-graph'
      config:
        repo: "C:/path/to/your/repo"   # or repos: [ ... ]
```

## Features

### 📜 Reading history

- **Commit graph**: GitHub-style list with local and remote branches grouped and colour-coded separately; group headers fold on click.
- **Lane graph**: in flat mode the left gutter draws real fork and merge curves using the same "reserved point" layout as VS Code Git Graph. Grouped mode draws none — group headers would break the lanes.
- **Commit details**: changed files, per-file diffs, full patch, and 📜 file history for any single file. The detail panel resizes by dragging, double-click resets, and the width is remembered.
- **Three filters**: branch (unchecked = fully hidden), date range (in-app calendar, either end may be empty), and search across message / author / hash / email. Empty results offer a "show all branches" or "clear filters" way out.
- **Keyboard navigation**: `↑` `↓` / `j` `k` step through commits and open each detail. The mouse and the arrows share **one cursor** — click row 6, press `↓`, land on row 7.

### 📝 Working tree

- **Uncommitted changes** sit permanently at the top of the graph: staged / changes / untracked groups, status badges `A/M/D/R/U/?` and per-file `+/−` counts.
- Click a row to expand its diff (syntax highlighted); renames show `new ← old` and untracked files show their contents. The ☑ groups menu hides any group.
- Per-row **stage / unstage / restore**; top-bar **stage all / commit**; checkboxes for batch **stage / unstage / restore / ignore / commit selected** (commits only the selected files, leaving the rest alone).
- The commit dialog offers **✨ AI-generate a commit message**: heuristic candidates from the diff stats, editable. No external AI call.
- Past 10 files the list scrolls internally, keeping the top-bar buttons and the batch bar pinned.

### 🌿 Branches

- **Top-bar icons**: open folder / fetch (`fetch --all --prune`) / push current branch / refresh.
- **Branch group right-click**: local branches switch / push / delete (`-d` refuses unmerged, HEAD protected); remote branches fetch / copy name. Remote group headers always render, labelled "synced" or "contained".
- **Commit row right-click**: copy hash / message, tag (rename, delete), create a branch from this commit, open the GitHub commit page, copy repo path, reveal in file manager.
- **Multiple repos**: "Open folder" browses the disk to add any repo, remembers it, and the top dropdown switches between them.

### 🎨 Living with it

- **Themes**: auto / dark / light plus 8 style presets (🌸 sakura · 🌊 ocean · 🌲 forest · 🌙 night · 🍬 candy · 💼 business · ✨ starry · 🤖 tech), each with its own animated background.
- **⚙ Settings** (gear, second-level page): view (grouped / flat), theme (a grid of colour chips), and a shortcut-panel entry. A small dot on the gear marks any non-default choice.
- **State memory**: filters, fold states, theme and date range persist to `.state/prefs.json` next to the plugin — surviving a port change or a `dsh web` restart (localStorage is origin-scoped and silently resets when the port moves).
- **Auto refresh**: while visible, a 5-second probe updates the stats and list; workspace changes are followed every 3 seconds.
- **Auto-update**: silently checks the latest GitHub tag and swaps the files in one click (backup first, automatic rollback on failure), applied on restart. When mounted via `link:` the button hides and suggests `git pull` instead — files owned by git are never rewritten.

## Usage

| Action | Description |
| --- | --- |
| "Git 图谱" tab in a session | Open the graph for the current session's workspace |
| Repo dropdown at the top | Switch repositories; the label to its left shows the full path |
| Branch group header | Click to fold / unfold that branch |
| "分支过滤" (top bar, centre) | Checked = visible, unchecked = fully hidden |
| "日期" (top bar, centre) | In-app calendar: click a day to set the start, another for the end, with the span tinted. The 从 / 到 chips are clickable and decide which end the calendar writes to. Presets for 7 / 30 / 90 days and a year, plus 今天 and year/month stepping. One end alone is a single-sided limit; a reversed range is swapped silently |
| Search box (top bar, centre) | Filter by message / author / hash / email |
| "未提交改动" block at the top of the graph | See "Working tree" above; clicking the change count in the status line scrolls back to it |
| Commit row | Click for details |
| Commit row right-click | Copy / tag / branch / open GitHub / open folder |
| 📜 in the commit details | File history for that path |
| Splitter left of the detail panel | Drag to resize; double-click to reset (min 260px) |
| Top-bar icons | Open folder / fetch / push / refresh |
| ⚙ Settings (far right) | View, theme, shortcuts |

**Shortcuts**: `Ctrl+F` search · `Ctrl+/` shortcut panel · `Ctrl+B` fold / unfold all branch groups · `↑` `↓` / `j` `k` step through commits · `Enter` reopen the current detail · `Esc` close panels.

## Development

```
dsh-git-graph/
├── index.js          # Server half: /git-graph prefix routes + git API
├── client.js         # Client half: registers the conversation.view tab
├── web/index.html    # Page shell (standalone page inside an iframe, markup only)
├── web/app.css       # Page styles (external stylesheet)
├── web/app.js        # Page logic (external script)
├── package.json      # Plugin manifest (dsh.client + dsh.bundle.patch + engines.dsh)
├── cordis.patch.yml  # Profile mount point
├── scripts/          # check-compat.mjs / publish.mjs / compat-isolated-test.ps1
└── docs/             # Compatibility and security-audit evidence
```

```bash
# One-time mount (no need to repeat after code changes)
dsh plugin --profile web add link:<path to this repository>

# After editing
node --check index.js client.js && node --check web/app.js
# index.js / client.js changes need a dsh web restart; the three web/ files only need a refresh
```

Release flow: `npm run check:compat` → `pwsh -File scripts/compat-isolated-test.ps1` (isolated tests on anchor versions) → bump version → `git commit` → `git tag vX.Y` → `git push --follow-tags` → `npm run publish:npm`. Full conventions live in [AGENTS.md](AGENTS.md).

## Compatibility & security

- **Compatibility range**: both `engines.dsh` and `peerDependencies["@deepseek-ai/dsh"]` are `>=0.1.0-rc.6 <0.3.0`. Isolated tests (separate `DSH_HOME`, full add → dump-config → remove cycle) pass on **0.1.7-rc.2** (latest) and **0.2.0-rc.1** (next); evidence in [docs/compatibility.md](docs/compatibility.md).
- **Read-only by default**: git is always invoked through `execFile` with fixed argument arrays, never a shell; file paths are `resolve`d and prefix-checked against traversal; long output is truncated.
- **Write operations must be POST** and are validated for same-origin Origin / Referer. The page ships a strict CSP (`script-src 'self'`, `style-src 'self'`, no inline allowance at all).
- **Permissions & provenance**: git runs only inside directories you authorize; network access is limited to self-update and `fetch`/`pull`/`push`; no lifecycle scripts, and DSH core is never touched.

## Distribution

- **GitHub**: this repository carries the `dsh-plugin` topic, so `dsh plugin add github:…` installs directly.
- **npm**: [`@shiqyka/dsh-git-graph`](https://www.npmjs.com/package/@shiqyka/dsh-git-graph).
  The scope is mandatory: the unscoped `dsh-git-graph` name belongs to a different project on npm.

## License

[MIT](./LICENSE)

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/) — the plugin platform
- [quansheng](https://github.com/1841220388zzzcccxxx-star) — original author of this project; every line of code and documentation before v0.22.0 is his work. This repository is a fork of his [dsh-git-graph](https://github.com/1841220388zzzcccxxx-star/dsh-git-graph)
