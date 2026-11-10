#!/usr/bin/env node
/**
 * check-remote-ui.mjs — 远端（ssh://）客户端的离线验收：真实 Chrome + CDP，零依赖。
 *
 * 为什么需要它：`check-remote.mjs` 只在服务端契约层面断言，`check-remote-live.mjs`
 * 需要真主机；而 M4 改的全在 `web/app.js` / `web/app.css` / `web/index.html`，
 * 这些改动**只有在真浏览器里才会暴露错误**：
 *   - `style="..."` 属性会被 `style-src 'self'` 整条丢掉（元素上只是"没生效"，
 *     静态 grep 能查属性，查不出运行时被丢）；
 *   - `disabled` 的 `<button>` 不派发 mouse/click，菜单收起依赖 pointer 监听；
 *   - 徽标一出现就改了 `.hd-left` 的内容宽度，顶栏三区等宽网格是否被顶歪，
 *     只有量 `getBoundingClientRect()` 才知道。
 *
 * 做法：打开插件页面（真 CSP、真样式表、真 app.js），然后**只在页面里替换
 * `api()` 与 `resolveSessionWs()`**，用固定响应驱动 `load()`，再对 DOM 断言。
 * 被发布的代码一行没改，页面自身的启动路径也已经真实跑过一遍。
 *
 * 用法：
 *   node scripts/check-remote-ui.mjs            # 无 Chrome/无服务器时 SKIP，exit 0
 *   DSH_GG_BASE=http://127.0.0.1:2631 node scripts/check-remote-ui.mjs
 *   DSH_GG_CHROME=/path/to/chrome node scripts/check-remote-ui.mjs
 *   node scripts/check-remote-ui.mjs --json     # 机器可读
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const BASE = (process.env.DSH_GG_BASE || 'http://127.0.0.1:14419').replace(/\/+$/, '')
const PAGE = BASE + '/git-graph/index.html'
const JSON_OUT = process.argv.includes('--json')
const CHROME_CANDIDATES = [
  process.env.DSH_GG_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const results = []
function expect(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) })
  if (!JSON_OUT) console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail && !ok ? '\n         → ' + detail : ''))
}
function skip(reason) {
  if (JSON_OUT) console.log(JSON.stringify({ skipped: true, reason }))
  else console.log('SKIP: ' + reason)
  process.exit(0)
}

/* ---------- static checks that need no browser ---------- */
function staticChecks() {
  const html = readFileSync(join(root, 'web/index.html'), 'utf8')
  const css = readFileSync(join(root, 'web/app.css'), 'utf8')
  /* Every one of these is a CSP regression, not a style preference: the page is
   * served with `style-src 'self'` / `script-src 'self'`, so an inline style
   * attribute or inline <script> is dropped silently at runtime. */
  expect('index.html has no <style> block', !/<style[\s>]/i.test(html))
  expect('index.html has no inline <script>', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html))
  expect('index.html has no style= attribute', !/\sstyle\s*=/i.test(html))
  expect('app.js never sets a style attribute',
    !/setAttribute\(\s*["']style["']/.test(readFileSync(join(root, 'web/app.js'), 'utf8')))
  expect('remote badge element present', /id="remoteBadge"/.test(html))
  expect('badge starts hidden (.gg-none)', /class="rd-remote gg-none" id="remoteBadge"/.test(html))
  expect('app.css defines .rd-remote', /\.rd-remote\s*\{/.test(css))
  expect('app.css defines disabled empty-state button', /\.es-open\[disabled\]/.test(css))
  expect('app.css defines disabled batch button', /\.wd-batch button\[disabled\]/.test(css))
}

/* ---------- CDP plumbing ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launchChrome() {
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!exe) skip('没有可用的 Chrome/Edge（可用 DSH_GG_CHROME 指定）')
  const profile = mkdtempSync(join(tmpdir(), 'gg-ui-'))
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--disable-default-apps', '--mute-audio', '--no-sandbox',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
  ]
  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  let exitCode = null
  proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-4000) })
  proc.on('exit', (c) => { exitCode = c })

  /* port 0 makes Chrome choose one; it publishes the choice in DevToolsActivePort
   * (line 1 = port, line 2 = browser websocket path). Robust against a port
   * already being taken by another instance, which a fixed port is not. */
  const portFile = join(profile, 'DevToolsActivePort')
  let port = 0
  for (let i = 0; i < 120; i++) {
    if (exitCode !== null) skip('Chrome 启动即退出（' + exe + '）: ' + tail.split('\n').slice(-3).join(' '))
    if (existsSync(portFile)) {
      const digits = readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (/^\d+$/.test(digits)) { port = Number(digits); break }
    }
    await sleep(100)
  }
  if (!port) skip('等不到 DevTools 端口: ' + tail.split('\n').slice(-3).join(' '))
  return { proc, profile, port }
}

async function connectPage(port) {
  let target = null
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch { /* not up yet */ }
    if (!target) await sleep(100)
  }
  if (!target) throw new Error('找不到 page target')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const logEntries = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    } else if (m.method === 'Log.entryAdded') {
      logEntries.push(m.params.entry)
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {}
      /* Keep the description: `text` alone is just "Uncaught", which names
       * nothing. The stack is what turns a red assertion into a fix. */
      logEntries.push({
        level: 'error',
        text: d.text || 'exception',
        detail: (d.exception && (d.exception.description || d.exception.value)) || '',
        url: d.url || '',
        line: d.lineNumber,
      })
    }
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('websocket 连接失败')))
  })
  const send = (method, params = {}) => {
    const id = ++seq
    return new Promise((res, rej) => {
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /* Evaluates in the page's global scope, where the top-level `let`/`function`
   * bindings of a classic script live — so REPO, load(), applyRemoteUi() and
   * friends are reachable exactly as the page itself sees them. */
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''))
    }
    return r.result.value
  }
  const waitFor = async (expression, timeout = 15000) => {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      try { if (await evaluate(expression)) return true } catch { /* keep polling */ }
      await sleep(120)
    }
    return false
  }
  return { ws, send, evaluate, waitFor, logEntries }
}

/* ---------- canned server ---------- */
/* One script that installs the whole fixture inside the page. Kept as a single
 * evaluate() so the page cannot observe a half-installed stub. */
const INSTALL_FIXTURE = `(() => {
  const REMOTE = "ssh://qiyk/home/qiyk/mygit";
  const LOCAL = "F:/GitHub/dsh-git-graph";
  const commit = { hash: "1111111111111111111111111111111111111111", parents: [],
    author: "ethan", email: "ethan@example.com", date: "2026-11-01T10:00:00+08:00",
    subject: "stub commit", refs: ["HEAD -> main", "origin/main"] };
  const workstatus = { ok: true, branch: "main", staged: [],
    unstaged: [{ path: "a.txt", code: " M" }], untracked: [],
    counts: { staged: 0, unstaged: 1, untracked: 0 } };
  const branches = { ok: true, branches: [
    { refname: "refs/heads/main", kind: "local", name: "main", sha: commit.hash, head: true }] };

  /* The server explains a missing remote git root with "wsProbe". Every mode
   * that has no remote root carries one, because the copy is now driven by it:
   * "the bridge plugin is missing" and "this folder is not a repository" need
   * opposite advice, and telling the second user to re-check their plugin sends
   * them away from the directory they pointed at. */
  const NOT_A_REPO = "fatal: not a git repository (or any of the parent directories): .git";
  window.__fix = {
    /* "remote-empty"     bridge unavailable (plugin missing/disabled)
     * "remote-notrepo"   bridge fine, this folder is not a repository
     * "remote-unreach"   bridge fine, the host could not be reached
     * "remote-broken"    bridge fine, no root, but a local repo makes "repos"
     *                    non-empty — the same miss through the second branch */
    mode: "local",           // "local" | "remote" | "remote-empty" | "remote-notrepo"
                             //   | "remote-unreach" | "remote-broken" | "remote-localrepo"
    calls: [],
  };
  const resp = (op) => {
    const m = window.__fix.mode;
    if (op === "repos") {
      if (m === "remote-empty") return { ok: true, repos: [], current: null, ws: REMOTE,
        wsRoot: null, wsIsGit: false, wsRemote: true,
        wsProbe: { reason: "bridge-missing", bridge: false, git: false, detail: "" } };
      if (m === "remote-notrepo") return { ok: true, repos: [], current: null, ws: REMOTE,
        wsRoot: null, wsIsGit: false, wsRemote: true,
        wsProbe: { reason: "not-a-repo", bridge: true, git: true, detail: NOT_A_REPO } };
      if (m === "remote-unreach") return { ok: true, repos: [], current: null, ws: REMOTE,
        wsRoot: null, wsIsGit: false, wsRemote: true,
        wsProbe: { reason: "unreachable", bridge: true, git: true,
          detail: "ssh: Could not resolve hostname qiyk: Name or service not known" } };
      /* An unclassified miss with a WORKING bridge, plus the older host that
       * sends no wsProbe field at all. Both used to land on "install the
       * plugin", which is the exact wrong answer: bridge:true (or its absence,
       * which proves nothing) is not evidence of a missing plugin. */
      if (m === "remote-unknown") return { ok: true, repos: [], current: null, ws: REMOTE,
        wsRoot: null, wsIsGit: false, wsRemote: true,
        wsProbe: { reason: "unknown", bridge: true, git: true, detail: "" } };
      if (m === "remote-noprobe") return { ok: true, repos: [], current: null, ws: REMOTE,
        wsRoot: null, wsIsGit: false, wsRemote: true };
      if (m === "remote-broken") return { ok: true, repos: [LOCAL], current: LOCAL, ws: REMOTE,
        wsRoot: null, wsIsGit: false, wsRemote: true,
        wsProbe: { reason: "not-a-repo", bridge: true, git: true, detail: NOT_A_REPO } };
      /* A remote workspace that is also showing a LOCAL repository (one the
       * user added with "open folder" before switching workspaces). This is
       * the case the badge used to get wrong: the session is remote, the
       * repository on screen is not. */
      if (m === "remote-localrepo") return { ok: true, repos: [LOCAL], current: LOCAL, ws: REMOTE,
        wsRoot: null, wsIsGit: false, wsRemote: true };
      const remote = m !== "local";
      const repo = remote ? REMOTE : LOCAL;
      return { ok: true, repos: [repo], current: repo, ws: repo,
        wsRoot: repo, wsIsGit: true, wsRemote: remote };
    }
    if (op === "graph") return { ok: true, commits: [commit], total: 1, head: "main" };
    if (op === "branches") return branches;
    if (op === "workstatus") return workstatus;
    if (op === "prefs") return { ok: true, prefs: {} };
    if (op === "head") return { ok: true, sig: "sig-1" };
    if (op === "count") return { ok: true, total: 1 };
    if (op === "checkupdate") return { ok: true, current: "9.9.9", latest: "9.9.9", hasUpdate: false, managed: false };
    if (op === "remoteinfo") return { ok: true, web: null };
    if (op === "suggestmsg") return { ok: false, error: "unknown-op" };
    /* Anything else models the server's remote refusals, so a stray call through
     * a control that should have been disabled shows up as a visible error
     * instead of silently succeeding. */
    return { ok: false, error: "unsupported-remote", hint: "stub: " + op };
  };
  /* Rewind to the state of a page that has not run a load() yet. The page
   * booted against the real server, so its first applyRemoteUi() already
   * captured the real tooltips and disabled nothing. A cold start into a remote
   * workspace never gets that local pass — without this rewind, the run can only
   * ever test the "local first, then remote" order and a capture bug on the
   * blocked path stays invisible. */
  if (typeof ORIG_TITLES !== "undefined") ORIG_TITLES.clear();
  const rewind = {
    btnOpenDir: "打开文件夹：浏览磁盘，把任意 Git 仓库添加进来",
    btnOpenDirEmpty: "浏览磁盘，选择任意文件夹作为 Git 仓库显示",
    btnScanDir: "在当前对话目录及其子目录中查找 Git 仓库",
  };
  for (const [id, title] of Object.entries(rewind)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.title = title;
    el.disabled = false;
    el.removeAttribute("aria-disabled");
  }
  api = async (op) => { window.__fix.calls.push(op); return resp(op); };
  resolveSessionWs = async () => (window.__fix.mode === "local" ? LOCAL : REMOTE);
  return true;
})()`

/* Drives a real load() and waits for the graph to be painted. */
const RUN_LOAD = `(async () => {
  window.__fix.calls.length = 0;
  /* "remote-localrepo" only reaches the graph when the local repo counts as a
   * user-added one (that is how a remote session ends up displaying a local
   * path at all); otherwise load() correctly falls through to the empty
   * screen and the case cannot be observed. */
  if (window.__fix.mode === "remote-localrepo") {
    ADDED_REPOS.length = 0;
    ADDED_REPOS.push("F:/GitHub/dsh-git-graph");
  } else {
    ADDED_REPOS.length = 0;
  }
  await load(window.__fix.mode === "local" ? "F:/GitHub/dsh-git-graph" : "ssh://qiyk/home/qiyk/mygit");
  await new Promise((r) => setTimeout(r, 60));
  return true;
})()`

/* The tooltip the markup ships with. Restoring to this exact string is what
 * distinguishes "captured the original" from "captured the remote override". */
const MARKUP_OPEN_DIR_TITLE = '打开文件夹：浏览磁盘，把任意 Git 仓库添加进来'
const MARKUP_SCAN_TITLE = '在当前对话目录及其子目录中查找 Git 仓库'

const SNAP = `(() => {
  const t = (id) => { const e = document.getElementById(id); return e ? e.textContent : null };
  const badge = document.getElementById("remoteBadge");
  const open = document.getElementById("btnOpenDir");
  const openEmpty = document.getElementById("btnOpenDirEmpty");
  const scan = document.getElementById("btnScanDir");
  /* Batch bar ignores WD_SELECT unless a row is checked, so seed one selection
   * and let the page build the bar at its normal width. */
  let ignoreBtn = null;
  if (typeof WD_SELECT !== "undefined" && COMMITS) {
    WD_SELECT.clear();
    WD_SELECT.add("unstaged\\u0000a.txt");
    updateBatchBar();
    ignoreBtn = [...document.querySelectorAll("#wdPanel .wd-batch button")]
      .find((b) => b.textContent === "忽略选中") || null;
  }
  let menuLabels = [];
  if (typeof COMMITS !== "undefined" && COMMITS && COMMITS.length) {
    openContextMenu(40, 40, COMMITS[0]);
    menuLabels = [...document.querySelectorAll("#ctxMenu .cm-item span:first-child")]
      .map((s) => s.textContent);
    hideContextMenu();
  }
  const filter = document.getElementById("btnFilter").getBoundingClientRect();
  /* The empty state is position:absolute; inset:0 with justify-content:center
   * and no scrolling, so content taller than the panel overflows BOTH ways and
   * the top of it lands outside the viewport with no way to scroll back. The
   * copy in these states is prose that differs in length by cause, so the long
   * one is exactly where this would first bite. Measure the children instead of
   * trusting the layout: a centred flex box reports no overflow of its own. */
  const es = document.getElementById("emptyState");
  const esKids = es ? [...es.children].filter((el) => !el.classList.contains("gg-none") &&
    getComputedStyle(el).display !== "none") : [];
  const esRect = es ? es.getBoundingClientRect() : null;
  let esTop = null, esBottom = null;
  if (esRect && esKids.length) {
    esTop = Math.round(Math.min(...esKids.map((el) => el.getBoundingClientRect().top)));
    esBottom = Math.round(Math.max(...esKids.map((el) => el.getBoundingClientRect().bottom)));
  }
  return JSON.stringify({
    repo: typeof REPO === "undefined" ? null : REPO,
    wsRemote: typeof WS_REMOTE === "undefined" ? null : WS_REMOTE,
    repoLabel: t("repoLabel"),
    badgeText: badge ? badge.textContent : null,
    badgeHidden: badge ? badge.classList.contains("gg-none") : null,
    badgeTitle: badge ? badge.title : null,
    openDisabled: open ? open.disabled : null,
    openTitle: open ? open.title : null,
    openEmptyDisabled: openEmpty ? openEmpty.disabled : null,
    openEmptyTitle: openEmpty ? openEmpty.title : null,
    openEmptyOpacity: openEmpty ? getComputedStyle(openEmpty).opacity : null,
    openEmptyHidden: openEmpty ? openEmpty.classList.contains("gg-none") : null,
    scanHidden: scan ? scan.classList.contains("gg-none") : null,
    scanTitle: scan ? scan.title : null,
    ignoreDisabled: ignoreBtn ? ignoreBtn.disabled : null,
    ignoreTitle: ignoreBtn ? ignoreBtn.title : null,
    ignoreOpacity: ignoreBtn ? getComputedStyle(ignoreBtn).opacity : null,
    menuLabels: menuLabels,
    status: t("statusLine"),
    esTitle: t("esTitle"),
    esSub: t("esSub"),
    esTop: esTop,
    esBottom: esBottom,
    esBoxTop: esRect ? Math.round(esRect.top) : null,
    esBoxBottom: esRect ? Math.round(esRect.bottom) : null,
    emptyVisible: !document.getElementById("emptyState").classList.contains("hidden"),
    loadingHidden: document.getElementById("loading").classList.contains("hidden"),
    filterCentre: Math.round((filter.left + filter.right) / 2 * 10) / 10,
    filterX: Math.round(filter.left * 10) / 10,
    scrollX: document.documentElement.scrollWidth,
    clientX: document.documentElement.clientWidth,
  });
})()`

async function main() {
  staticChecks()

  /* The page must be reachable AND be the plugin's own page; otherwise every
   * DOM assertion below would be vacuously true against an error page. */
  let probeOk = false
  try {
    const r = await fetch(PAGE)
    const body = await r.text()
    probeOk = r.ok && /id="commitList"/.test(body)
  } catch { /* handled below */ }
  if (!probeOk) skip('取不到插件页面 ' + PAGE + '（dsh web 未运行？可用 DSH_GG_BASE 指定）')

  const { proc, profile, port } = await launchChrome()
  let page = null
  try {
    page = await connectPage(port)
    const { send, evaluate, waitFor } = page
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Log.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
    })
    await send('Page.navigate', { url: PAGE })
    const booted = await waitFor('document.readyState === "complete" && typeof load === "function" && typeof api === "function"')
    if (!booted) throw new Error('页面未完成启动（app.js 未加载？）')
    /* The page ran its own load() against the real server first. Wait for that
     * to settle so it cannot race the fixture below. */
    await waitFor('!document.getElementById("loading").contains(document.activeElement) || true')
    await sleep(1200)
    expect('app.js 在真 CSP 下完成启动', await evaluate('typeof applyRemoteUi === "function"'))
    expect('页面自身启动未触发 CSP 拒绝',
      await evaluate('(window.__cspSeen = 0, true)') && page.logEntries.filter((e) =>
        /Content Security Policy|Refused to apply inline style/i.test(e.text || '')).length === 0,
      page.logEntries.map((e) => e.text).join(' | '))

    await evaluate(INSTALL_FIXTURE)

    /* ---- phase 0: cold start straight into a remote repo -------------- */
    /* The fixture is installed after the page already did its own load, so this
     * is the first applyRemoteUi() call in the run. It must capture the real
     * tooltips even though it runs while blocked: a capture that only happens
     * on the restore path would record the remote text as the "original" and
     * leave it stuck there after switching to a local repo. */
    await evaluate(`window.__fix.mode = "remote"`)
    await evaluate(RUN_LOAD, true)
    const coldRemote = JSON.parse(await evaluate(SNAP))
    expect('冷启动即远端：打开文件夹已禁用',
      coldRemote.openDisabled === true, String(coldRemote.openDisabled))
    await evaluate(`window.__fix.mode = "local"`)
    await evaluate(RUN_LOAD, true)
    const coldBack = JSON.parse(await evaluate(SNAP))
    expect('冷启动即远端后切回本地：标题还原成 markup 原文（不是远端文案）',
      coldBack.openTitle === MARKUP_OPEN_DIR_TITLE,
      JSON.stringify({ got: coldBack.openTitle, want: MARKUP_OPEN_DIR_TITLE }))
    expect('冷启动即远端后切回本地：扫描按钮标题也还原',
      coldBack.scanTitle === MARKUP_SCAN_TITLE,
      JSON.stringify({ got: coldBack.scanTitle, want: MARKUP_SCAN_TITLE }))

    /* ---- phase 1: local baseline -------------------------------------- */
    await evaluate(`window.__fix.mode = "local"`)
    await evaluate(RUN_LOAD, true)
    const local = JSON.parse(await evaluate(SNAP))
    expect('本地：仓库路径正常显示', local.repoLabel === 'F:/GitHub/dsh-git-graph', local.repoLabel)
    expect('本地：无远端徽标', local.badgeHidden === true && local.badgeText === '', JSON.stringify(local))
    expect('本地：打开文件夹可用且恢复原标题',
      local.openDisabled === false && /打开文件夹/.test(local.openTitle), JSON.stringify(local))
    expect('本地：右键菜单保留「在文件管理器中打开」',
      local.menuLabels.includes('在文件管理器中打开'), JSON.stringify(local.menuLabels))
    expect('本地：忽略选中可用', local.ignoreDisabled === false, String(local.ignoreDisabled))
    expect('本地：状态栏无远端提示', !/远端/.test(local.status || ''), local.status)
    const localCentre = local.filterCentre

    /* ---- phase 2: remote repository ----------------------------------- */
    await evaluate(`window.__fix.mode = "remote"`)
    await evaluate(RUN_LOAD, true)
    const remote = JSON.parse(await evaluate(SNAP))
    expect('远端：仓库路径仍显示完整 ssh:// 地址',
      remote.repoLabel === 'ssh://qiyk/home/qiyk/mygit', remote.repoLabel)
    expect('远端：徽标可见且写「远程 · qiyk」',
      remote.badgeHidden === false && /远程 · qiyk/.test(remote.badgeText || ''), JSON.stringify(remote))
    expect('远端：徽标有解释性 title', /远端/.test(remote.badgeTitle || ''), remote.badgeTitle)
    expect('远端：打开文件夹按钮 disabled + 说明',
      remote.openDisabled === true && /远端工作区不支持浏览本机目录/.test(remote.openTitle || ''),
      JSON.stringify({ d: remote.openDisabled, t: remote.openTitle }))
    expect('远端：右键菜单不渲染「在文件管理器中打开」',
      !remote.menuLabels.includes('在文件管理器中打开'), JSON.stringify(remote.menuLabels))
    expect('远端：忽略选中 disabled + 说明 .gitignore',
      remote.ignoreDisabled === true && /\.gitignore/.test(remote.ignoreTitle || ''),
      JSON.stringify({ d: remote.ignoreDisabled, t: remote.ignoreTitle }))
    expect('远端：禁用的批量按钮有降透明度视觉',
      Number(remote.ignoreOpacity) > 0 && Number(remote.ignoreOpacity) < 1, remote.ignoreOpacity)
    expect('远端：扫描按钮标题说明不支持扫描本机磁盘',
      /本机磁盘/.test(remote.scanTitle || ''), remote.scanTitle)
    expect('远端：状态栏说明网络与凭据在远端',
      /远端/.test(remote.status || '') && /网络与凭据使用远端主机/.test(remote.status || ''), remote.status)
    expect('远端：徽标出现不推歪中间区（±1px）',
      Math.abs(remote.filterCentre - localCentre) <= 1,
      `local=${localCentre} remote=${remote.filterCentre}`)

    /* ---- phase 2b: remote session displaying a LOCAL repo ------------- */
    /* The chip sits next to the repository path, so it annotates that path.
     * When a remote session shows a local repo, the session-level guards stay
     * on (the folder picker still cannot browse the remote disk) while the
     * chip and the repository-level guards follow REPO and stay local. Marking
     * the local path "远程 · qiyk" was the reported bug. */
    await evaluate(`window.__fix.mode = "remote-localrepo"`)
    await evaluate(RUN_LOAD, true)
    const mixed = JSON.parse(await evaluate(SNAP))
    expect('远端会话 + 本地仓库：路径显示本地仓库',
      mixed.repoLabel === 'F:/GitHub/dsh-git-graph', mixed.repoLabel)
    expect('远端会话 + 本地仓库：徽标隐藏（徽标只跟屏幕上的仓库）',
      mixed.badgeHidden === true && mixed.badgeText === '',
      JSON.stringify({ h: mixed.badgeHidden, t: mixed.badgeText }))
    expect('远端会话 + 本地仓库：打开文件夹仍然禁用（会话级能力）',
      mixed.openDisabled === true, String(mixed.openDisabled))
    expect('远端会话 + 本地仓库：忽略选中可用（仓库级能力跟随 REPO）',
      mixed.ignoreDisabled === false, String(mixed.ignoreDisabled))
    expect('远端会话 + 本地仓库：右键菜单保留本机文件管理器项',
      mixed.menuLabels.includes('在文件管理器中打开'), JSON.stringify(mixed.menuLabels))

    /* ---- phase 3: back to a local repository (the important one) ------ */
    await evaluate(`window.__fix.mode = "local"`)
    await evaluate(RUN_LOAD, true)
    const back = JSON.parse(await evaluate(SNAP))
    expect('切回本地：徽标重新隐藏',
      back.badgeHidden === true && back.badgeText === '', JSON.stringify(back))
    expect('切回本地：打开文件夹恢复可用 + 原标题',
      back.openDisabled === false && back.openTitle === local.openTitle,
      JSON.stringify({ d: back.openDisabled, t: back.openTitle, was: local.openTitle }))
    expect('切回本地：右键菜单恢复该入口',
      back.menuLabels.includes('在文件管理器中打开'), JSON.stringify(back.menuLabels))
    expect('切回本地：忽略选中恢复可用且无残留 title',
      back.ignoreDisabled === false && back.ignoreTitle === local.ignoreTitle,
      JSON.stringify({ d: back.ignoreDisabled, t: back.ignoreTitle, was: local.ignoreTitle }))
    expect('切回本地：状态栏远端提示消失', !/远端/.test(back.status || ''), back.status)
    expect('切回本地：中间区位置复原（±1px）',
      Math.abs(back.filterCentre - localCentre) <= 1,
      `local=${localCentre} back=${back.filterCentre}`)

    /* ---- phase 4: remote workspace with no git root ------------------- */
    /* The three ways a remote root comes back empty used to render ONE
     * sentence, and that sentence always named @shiqyka/dsh-ssh-workspace. It
     * is only true for the first of them, and it is actively misleading for the
     * third: a folder that is not a repository is the most common cause, and
     * telling that user to re-check an installed plugin sends them away from
     * the directory they just pointed at. Each mode below asserts the copy
     * names its own cause, so a regression back to a single shared sentence
     * fails at least two of them. */

    /* 4a. bridge unavailable — the one case that really is an install problem */
    await evaluate(`window.__fix.mode = "remote-empty"`)
    await evaluate(RUN_LOAD, true)
    const empty = JSON.parse(await evaluate(SNAP))
    expect('空态/桥不可用：显示了空态而不是一直加载中',
      empty.emptyVisible === true && empty.loadingHidden === true,
      JSON.stringify({ e: empty.emptyVisible, l: empty.loadingHidden }))
    expect('空态/桥不可用：文案点名 dsh-ssh-workspace',
      /dsh-ssh-workspace/.test((empty.esTitle || '') + (empty.esSub || '')),
      JSON.stringify({ t: empty.esTitle, s: empty.esSub }))
    expect('空态/桥不可用：空态里的打开文件夹按钮也禁用',
      empty.openEmptyHidden === false && empty.openEmptyDisabled === true, JSON.stringify(empty))
    expect('空态/桥不可用：禁用按钮有可见的弱化样式',
      Number(empty.openEmptyOpacity) > 0 && Number(empty.openEmptyOpacity) < 1, empty.openEmptyOpacity)
    expect('空态/桥不可用：扫描本机磁盘按钮隐藏', empty.scanHidden === true, String(empty.scanHidden))
    expect('空态/桥不可用：不显示远端徽标（屏幕上没有仓库）',
      empty.badgeHidden === true && empty.badgeText === '',
      JSON.stringify({ h: empty.badgeHidden, t: empty.badgeText }))

    /* 4b. bridge fine, folder is not a repository — the case that was wrong */
    await evaluate(`window.__fix.mode = "remote-notrepo"`)
    await evaluate(RUN_LOAD, true)
    const notRepo = JSON.parse(await evaluate(SNAP))
    expect('空态/非仓库：文案说明目录不是仓库，而不是插件没装',
      /不是\s*Git\s*仓库/.test(notRepo.esTitle || '') &&
        !/dsh-ssh-workspace/.test((notRepo.esTitle || '') + (notRepo.esSub || '')),
      JSON.stringify({ t: notRepo.esTitle, s: notRepo.esSub }))
    expect('空态/非仓库：给出「仓库在子目录里」的出路',
      /子目录/.test(notRepo.esSub || ''), notRepo.esSub)
    expect('空态/非仓库：不重复引导安装插件',
      !/安装并启用/.test(notRepo.esSub || ''), notRepo.esSub)

    /* 4c. bridge fine, host unreachable — network/credentials, not a plugin */
    await evaluate(`window.__fix.mode = "remote-unreach"`)
    await evaluate(RUN_LOAD, true)
    const unreach = JSON.parse(await evaluate(SNAP))
    expect('空态/连不上：文案指向连接而不是插件安装',
      /无法连接/.test(unreach.esTitle || '') &&
        !/dsh-ssh-workspace/.test((unreach.esTitle || '') + (unreach.esSub || '')),
      JSON.stringify({ t: unreach.esTitle, s: unreach.esSub }))
    expect('空态/连不上：回显远端原始错误首行，便于对照',
      /Could not resolve hostname/.test(unreach.esSub || ''), unreach.esSub)

    /* 4c-bis. an unclassified miss and a host that sends no probe at all. Both
     * are "we do not know why", and both must stay silent about the plugin:
     * `bridge:true` proves the plugin is working, and a missing probe proves
     * nothing. This is the regression that matters most — every failure of the
     * classification used to fall back to the wrong sentence, so the fallback
     * itself is what has to be nailed down. */
    await evaluate(`window.__fix.mode = "remote-unknown"`)
    await evaluate(RUN_LOAD, true)
    const unknownMiss = JSON.parse(await evaluate(SNAP))
    expect('空态/未分类：不说插件没装（桥是好的）',
      !/dsh-ssh-workspace/.test((unknownMiss.esTitle || '') + (unknownMiss.esSub || '')),
      JSON.stringify({ t: unknownMiss.esTitle, s: unknownMiss.esSub }))
    expect('空态/未分类：仍给出可执行的下一步',
      /工作区|目录/.test(unknownMiss.esSub || ''), unknownMiss.esSub)

    await evaluate(`window.__fix.mode = "remote-noprobe"`)
    await evaluate(RUN_LOAD, true)
    const noProbe = JSON.parse(await evaluate(SNAP))
    expect('空态/老宿主无 wsProbe：兜底文案不猜「插件没装」',
      !/dsh-ssh-workspace/.test((noProbe.esTitle || '') + (noProbe.esSub || '')),
      JSON.stringify({ t: noProbe.esTitle, s: noProbe.esSub }))

    /* 4d. the same miss reached through `repos` being non-empty (a configured
     * or added local repo) — the second copy site must agree with the first. */
    await evaluate(`window.__fix.mode = "remote-broken"`)
    await evaluate(RUN_LOAD, true)
    const broken = JSON.parse(await evaluate(SNAP))
    expect('远端非 git（仓库列表非空）：文案与空态分支一致',
      broken.esTitle === notRepo.esTitle && broken.esSub === notRepo.esSub,
      JSON.stringify({ got: broken.esTitle, want: notRepo.esTitle }))
    expect('远端非 git（仓库列表非空）：不再归因于插件缺失',
      !/dsh-ssh-workspace/.test((broken.esTitle || '') + (broken.esSub || '')),
      JSON.stringify({ t: broken.esTitle, s: broken.esSub }))

    /* The longest sentence on any of these screens is the "not a repository"
     * one, and it gets longer in a narrow panel because `.es-sub` is capped at
     * 420px. `#emptyState` centres its children and cannot scroll, so an
     * overlong block loses its top off-screen with nothing to scroll back to.
     * Both the widest (desktop) and narrowest (520px) passes check it, at the
     * cause that produces the most text. */
    expect('空态/非仓库（宽屏）：正文没有溢出空态容器',
      notRepo.esTop >= notRepo.esBoxTop && notRepo.esBottom <= notRepo.esBoxBottom,
      JSON.stringify(notRepo).slice(0, 300))

    await evaluate(`window.__fix.mode = "remote-notrepo"`)
    await evaluate(RUN_LOAD, true)
    await send('Emulation.setDeviceMetricsOverride', {
      width: 520, height: 720, deviceScaleFactor: 1, mobile: false,
    })
    await sleep(300)
    const narrowEmpty = JSON.parse(await evaluate(SNAP))
    expect('空态/非仓库（520px）：长文案仍完整显示，顶部没有被裁掉',
      narrowEmpty.esTop >= narrowEmpty.esBoxTop && narrowEmpty.esBottom <= narrowEmpty.esBoxBottom,
      `kids=[${narrowEmpty.esTop},${narrowEmpty.esBottom}] box=[${narrowEmpty.esBoxTop},${narrowEmpty.esBoxBottom}]`)
    expect('空态/非仓库（520px）：不产生横向溢出',
      narrowEmpty.scrollX <= narrowEmpty.clientX + 1,
      `scrollW=${narrowEmpty.scrollX} clientW=${narrowEmpty.clientX}`)

    /* ---- phase 5: narrow viewport ------------------------------------- */
    await evaluate(`window.__fix.mode = "remote"`)
    await evaluate(RUN_LOAD, true)
    await send('Emulation.setDeviceMetricsOverride', {
      width: 520, height: 720, deviceScaleFactor: 1, mobile: false,
    })
    await sleep(300)
    const narrow = JSON.parse(await evaluate(SNAP))
    expect('窄屏：徽标出现不产生横向溢出',
      narrow.scrollX <= narrow.clientX + 1, `scrollW=${narrow.scrollX} clientW=${narrow.clientX}`)

    /* No CSP refusal anywhere in the run. */
    const csp = page.logEntries.filter((e) =>
      /Content Security Policy|Refused to (apply|load|execute)/i.test(e.text || ''))
    expect('整轮运行无 CSP 拒绝', csp.length === 0, csp.map((e) => e.text).join(' | '))

    /* The page must not have thrown while driving these states. */
    const thrown = page.logEntries.filter((e) => e.level === 'error' && !/401|Unauthorized/.test(e.text || ''))
    expect('整轮运行无未捕获异常', thrown.length === 0,
      thrown.map((e) => `${e.text} ${e.detail || ''} @${e.url || '?'}:${e.line}`).join(' | '))
  } finally {
    try { page?.ws.close() } catch { /* ignore */ }
    try { proc.kill() } catch { /* ignore */ }
    await sleep(700)
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }) } catch { /* windows may keep a lock */ }
  }

  const failed = results.filter((r) => !r.ok)
  if (JSON_OUT) {
    console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
  } else {
    console.log(`\n${results.length - failed.length} ok / ${failed.length} FAIL`)
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('check-remote-ui 崩溃: ' + (err && err.stack || err))
  process.exit(1)
})
