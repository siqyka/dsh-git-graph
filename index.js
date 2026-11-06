// dsh-git-graph — server half
// Registers HTTP routes under /git-graph:
//   GET /git-graph/api?op=<op>&repo=<path>[&hash=<sha>]  -> JSON git data
//   GET /git-graph/index.html                           -> the visualizer page
// Commands are executed with execFile (no shell), fixed argument lists only.
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, 'web')

const MAX_GIT_BUFFER = 32 * 1024 * 1024
const MAX_DIFF_CHARS = 240000

/* Content-Security-Policy for the graph page and its two static assets.
 * The page used to be a single HTML file with everything inline, which forced
 * 'unsafe-inline' for both scripts and styles. Now that app.js and app.css are
 * separate files, 'self' suffices for each and the page needs no inline
 * allowances at all. Everything else stays locked down: no network origins
 * except this host, no frames, no plugins.
 * `img-src data: blob:` is still required — the UI builds small inline SVG/data
 * images, and the decorative background uses blob-free generated nodes. */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  'img-src data: blob:',
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'self'",
].join('; ')

/* ---- persisted UI preferences ------------------------------------------------
 * localStorage is scoped to the page's origin, and the DSH web port changes
 * between launches (e.g. 10426 -> 5828), which silently wiped every saved
 * preference — most visibly the branch filter, which then looked like it had
 * "reset itself". Storing the small, low-risk UI state on disk instead makes it
 * survive port changes and host restarts.
 *
 * Location: alongside the plugin (<plugin>/.state/prefs.json). That directory is
 * gitignored, so a dev checkout stays clean, and the file is per-install so two
 * DSH profiles do not fight over one file.
 * Scope: only UI preferences (branch filter, group visibility, fold state).
 * Never repository content, never credentials. */
const STATE_DIR = join(here, '.state')
const PREFS_FILE = join(STATE_DIR, 'prefs.json')
const PREFS_MAX_BYTES = 256 * 1024
const PREFS_ALLOWED_KEYS = new Set([
  'gg2-bfilter', 'gg2-wdshow', 'gg2-wdfolded', 'gg2-wdgroupfolded', 'gg2-brfolded', 'gg2-theme',
  'gg2-datefrom', 'gg2-dateto', 'gg2-flat', 'gg2-flat-reset',
])

function readPrefs() {
  try {
    const st = statSync(PREFS_FILE)
    if (st.size > PREFS_MAX_BYTES) return {}
    const raw = readFileSync(PREFS_FILE, 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

function writePrefs(patch) {
  const current = readPrefs()
  for (const [k, v] of Object.entries(patch || {})) {
    if (!PREFS_ALLOWED_KEYS.has(k)) continue          // allow-list: ignore anything else
    if (v === null || v === undefined) delete current[k]
    else current[k] = v
  }
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PREFS_FILE, JSON.stringify(current, null, 2), 'utf8')
  return current
}

export const name = 'git-graph'
export const inject = ['webServer']

function runGit(repo, args, maxBuffer = MAX_GIT_BUFFER, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const opts = { maxBuffer, windowsHide: true }
    if (timeoutMs > 0) opts.timeout = timeoutMs
    execFile('git', ['-C', repo, ...args], opts, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').toString().trim()
        reject(new Error(detail || 'git failed'))
        return
      }
      resolve(stdout.toString())
    })
  })
}

/* Fast local check for a git working tree: does `.git` exist (dir for a normal
 * clone, file for a linked worktree/submodule)? Equivalent to what
 * `git rev-parse --is-inside-work-tree` proves for the cases the repo list
 * cares about, but costs one statSync instead of a ~200ms process launch —
 * and this runs for every configured/known repo on each load. */
function hasGitEntry(repo) {
  try { return !!statSync(join(repo, '.git')) } catch { return false }
}

async function isGitRepo(repo) {
  try {
    const out = await runGit(repo, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/* Whether a string is a plain http(s) URL safe to hand to window.open().
 * Anything with another scheme (javascript:, data:, vbscript:, file:) — or a
 * string that is not a URL at all — is rejected. Scheme comparison is done on
 * the parsed URL, so "JAVASCRIPT:" and leading-whitespace variants are caught
 * the same way the browser would interpret them. */
function isSafeWebUrl(value) {
  try {
    const u = new URL(String(value))
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

/* Resolve the .git directory for a work tree (handles linked worktrees and
 * submodules, where .git is a file containing "gitdir: <path>"). */
function gitDirOf(repo) {
  let gitDir = join(repo, '.git')
  const st = statSync(gitDir)
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))
    if (!m) return null
    const p = m[1].trim()
    gitDir = p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : resolve(repo, p)
  }
  return gitDir
}

/* Read every local/remote/tag ref straight off disk — zero process spawns.
 * Equivalent to the `for-each-ref` this used to shell out to, which cost a full
 * git launch (~870ms inside the DSH host process on this machine) on every load.
 *
 * Merges the two places refs live:
 *   * <gitdir>/packed-refs  (packed, sorted; lines "<sha> <refname>", plus
 *     "^<sha>" peeled lines for annotated tags which are ignored here)
 *   * <gitdir>/refs/**.      (loose, overrides packed — a newer loose value wins)
 * Symbolic refs (e.g. refs/remotes/origin/HEAD -> refs/remotes/origin/master)
 * are dereferenced, matching what for-each-ref reports.
 * Returns null when the layout cannot be read, so callers can fall back to git. */
function readRefsFromDisk(repo, headName) {
  try {
    const gitDir = gitDirOf(repo)
    if (!gitDir) return null
    const refs = new Map() // refname -> sha
    // 1) packed-refs
    try {
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
      for (const line of packed.split('\n')) {
        if (!line || line[0] === '#' || line[0] === '^') continue
        const sp = line.indexOf(' ')
        if (sp <= 0) continue
        const sha = line.slice(0, sp).trim()
        const name = line.slice(sp + 1).trim()
        if (sha && name) refs.set(name, sha)
      }
    } catch { /* no packed-refs: all refs are loose */ }
    // 2) loose refs override packed values.
    // Symbolic refs are collected into `pending` and resolved in a SECOND pass,
    // because the target may itself be a loose ref that has not been read yet
    // (e.g. refs/remotes/origin/HEAD -> refs/remotes/origin/master, where the
    // packed value of origin/master is stale and the loose one wins). Resolving
    // them inline would silently report the stale packed sha.
    const pending = [] // [refname, targetRef]
    const walk = (dir, prefix) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = join(dir, e.name)
        const name = prefix + '/' + e.name
        if (e.isDirectory()) { walk(full, name); continue }
        let content
        try { content = readFileSync(full, 'utf8').trim() } catch { continue }
        if (content.startsWith('ref:')) {
          pending.push([name, content.slice(4).trim()])
          continue
        }
        if (/^[0-9a-f]{40,64}$/i.test(content)) refs.set(name, content)
      }
    }
    for (const base of ['refs/heads', 'refs/remotes', 'refs/tags']) {
      walk(join(gitDir, base), base)
    }
    // second pass: resolve symbolic refs (bounded, so a cycle cannot hang us)
    for (const [name, target] of pending) {
      let cur = target
      for (let hop = 0; hop < 10; hop++) {
        const direct = refs.get(cur)
        if (direct) { refs.set(name, direct); break }
        const next = pending.find((p) => p[0] === cur)
        if (!next) break
        cur = next[1]
      }
    }
    const branches = []
    for (const [refname, sha] of refs) {
      branches.push({
        refname,
        kind: refname.startsWith('refs/tags/') ? 'tag' : refname.startsWith('refs/remotes/') ? 'remote' : 'local',
        name: refname.replace(/^refs\/(heads|remotes|tags)\//, ''),
        sha,
        // the checked-out branch, same meaning as for-each-ref's %(HEAD)
        head: refname === 'refs/heads/' + headName,
      })
    }
    if (!branches.length) return null
    return branches
  } catch {
    return null
  }
}

/* Read the current branch name straight from .git/HEAD (no process spawn).
 * Equivalent to `git symbolic-ref -q --short HEAD`: a detached HEAD yields
 * "HEAD", and any failure falls back to "HEAD" as the old implementation did.
 * Handles linked worktrees / submodules, where .git is a file containing
 * "gitdir: <path>". */
function readHeadName(repo) {
  try {
    let gitDir = join(repo, '.git')
    let st = statSync(gitDir)
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))
      if (!m) return 'HEAD'
      const p = m[1].trim()
      gitDir = p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : resolve(repo, p)
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim()          // refs/heads/master
      const short = ref.replace(/^refs\/heads\//, '')
      return short || 'HEAD'
    }
    return 'HEAD'                                // detached
  } catch {
    return 'HEAD'
  }
}

/* ===================== self-update ===================== */
// Checks the GitHub repo for newer tags and can replace this plugin's files
// from a codeload zip. No API key needed: version lookup uses `git ls-remote
// --tags`, download uses https://codeload.github.com (zip, extracted by
// bsdtar which ships with Windows 10+ / macOS / most Linux distros).
const UPDATE_REPO = 'siqyka/dsh-git-graph'
const UPDATE_GH = `https://github.com/${UPDATE_REPO}`

function localVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
    return pkg.version || ''
  } catch { return '' }
}

/* Whether this plugin's own directory lives inside a git work tree (a
 * `link:`/dev checkout mount). Self-update must not overwrite files the user
 * owns through git, so in that mode checkupdate reports managed:'git' and the
 * UI hides the update button in favor of `git pull`. Cached after first call. */
let gitManagedPromise = null
function gitManaged() {
  if (!gitManagedPromise) {
    gitManagedPromise = new Promise((res) => {
      execFile('git', ['-C', here, 'rev-parse', '--is-inside-work-tree'], { windowsHide: true }, (err, stdout) => {
        res(!err && String(stdout).trim() === 'true')
      })
    })
  }
  return gitManagedPromise
}

/** Compare dotted versions: 1 if a>b, -1 if a<b, 0 if equal. */
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** Extra `git -c` args for network commands. Honors the user's global
 *  http(s).proxy / sslBackend / http.version config; if no proxy is set it
 *  auto-detects common local proxy ports (Clash/mihomo 7897, Clash 7890,
 *  v2ray 10809, socks 1080, etc.) and falls back to OpenSSL + HTTP/1.1
 *  (Windows schannel often fails against GitHub on CN networks). */
const PROXY_PORTS = [7897, 7890, 10809, 1080, 8888, 7891]
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(400)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
    sock.connect(port, '127.0.0.1')
  })
}

/** Resolve a usable proxy for GitHub: global git config wins, then a
 *  listening local proxy port. Returns '' when none found. */
async function resolveProxy() {
  const readGlobal = (k) => {
    try {
      const out = execFileSync('git', ['config', '--global', '--get', k], { encoding: 'utf8', windowsHide: true })
      return out.trim()
    } catch { return '' }
  }
  const fromConfig = readGlobal('http.proxy') || readGlobal('https.proxy')
  if (fromConfig) return fromConfig
  for (const port of PROXY_PORTS) {
    if (await portOpen(port)) return `http://127.0.0.1:${port}`
  }
  return ''
}

/** Extra `git -c` args for network commands: proxy (global config or
 *  auto-detected local port) + OpenSSL backend + HTTP/1.1 (Windows
 *  schannel often fails against GitHub on CN networks). */
async function gitNetArgs() {
  const extra = []
  const readGlobal = (k) => {
    try {
      const out = execFileSync('git', ['config', '--global', '--get', k], { encoding: 'utf8', windowsHide: true })
      return out.trim()
    } catch { return '' }
  }
  const proxy = await resolveProxy()
  if (proxy) extra.push('-c', 'http.proxy=' + proxy, '-c', 'https.proxy=' + proxy)
  const backend = readGlobal('http.sslBackend') || 'openssl'
  extra.push('-c', 'http.sslBackend=' + backend)
  const ver = readGlobal('http.version') || 'HTTP/1.1'
  extra.push('-c', 'http.version=' + ver)
  return extra
}

async function latestTag() {
  const out = await runGit(here, [...await gitNetArgs(), 'ls-remote', '--tags', UPDATE_GH], MAX_GIT_BUFFER, 60000)
  const tags = new Set()
  for (const line of String(out).split('\n')) {
    const m = line.match(/refs\/tags\/(v?\d+\.\d+(?:\.\d+)?)(\^\{\})?$/)
    if (m && !m[2]) tags.add(m[1])
  }
  if (!tags.size) return ''
  return [...tags].sort((a, b) => cmpVer(b, a))[0]
}

/** Download + extract + swap this plugin's files with the given tag.
 *  Uses `git clone --depth 1 --branch <tag>` so the download rides the same
 *  proxy / sslBackend / http.version config as every other git command. */
async function applyUpdate(tag) {
  if (!/^v?\d+\.\d+(?:\.\d+)?$/.test(tag)) throw new Error('bad-tag')
  const tmp = mkdtempSync(join(tmpdir(), 'ggupd-'))
  const srcDir = join(tmp, 'src')
  try {
    await runGit(here, [...await gitNetArgs(), 'clone', '--depth', '1', '--branch', tag, UPDATE_GH, srcDir], MAX_GIT_BUFFER, 180000)
    if (!statSync(join(srcDir, 'index.js'), { throwIfNoEntry: false })) throw new Error('missing-index')
    if (!statSync(join(srcDir, 'web', 'index.html'), { throwIfNoEntry: false })) throw new Error('missing-web')
    // The page pulls these two in; a release that ships index.html without them
    // would swap in a blank screen, so refuse before touching the install.
    if (!statSync(join(srcDir, 'web', 'app.css'), { throwIfNoEntry: false })) throw new Error('missing-web-css')
    if (!statSync(join(srcDir, 'web', 'app.js'), { throwIfNoEntry: false })) throw new Error('missing-web-js')

    // backup the current install, then swap (skip the cloned .git dir).
    // The backup lives next to the plugin dir (sibling), never inside it,
    // so it survives clearTree and is easy for users to find.
    const bak = join(dirname(here), basename(here) + '.bak-' + Date.now())
    try {
      copyTree(here, bak)
      clearTree(here)
      copyTree(srcDir, here, true)
    } catch (err) {
      // roll back to the backup
      try { clearTree(here); copyTree(bak, here) } catch { /* best effort */ }
      throw err
    }
    // keep only the newest backup
    pruneBackups()
  } finally {
    // Windows: cloned .git dirs may still be held by AV/antivirus scanners or
    // lingering file handles, so retry; and never let cleanup failure mask a
    // successful update (the swap above already happened).
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 })
    } catch {
      scheduleCleanup(tmp)
    }
  }
}

/** Best-effort late cleanup of a temp dir Windows refused to delete yet
 *  (handles usually release within a few seconds). Never throws. */
function scheduleCleanup(dir) {
  let tries = 0
  const attempt = () => {
    tries++
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      if (tries < 12) setTimeout(attempt, 1000)
    }
  }
  setTimeout(attempt, 1500)
}

function copyTree(src, dst, skipDotGit) {
  const cp = (s, d) => {
    const st = statSync(s, { throwIfNoEntry: false })
    if (!st) return
    if (st.isDirectory()) {
      if (skipDotGit && s.endsWith('.git')) return
      mkdirSync(d, { recursive: true })
      for (const name of readdirSync(s)) cp(join(s, name), join(d, name))
    } else if (st.isFile()) {
      copyFileSync(s, d)
    }
  }
  cp(src, dst)
}
function clearTree(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.bak-')) continue
    rmSync(join(dir, name), { recursive: true, force: true })
  }
}
function pruneBackups() {
  const parent = dirname(here)
  const base = basename(here)
  const prefix = base + '.bak-'
  const baks = readdirSync(parent).filter((n) => n.startsWith(prefix)).sort()
  for (const b of baks.slice(0, -1)) rmSync(join(parent, b), { recursive: true, force: true })
}

/** Walk upward from `start` until a directory containing `.git` is found. */
function findGitRoot(start) {
  let dir = String(start).replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  for (let i = 0; i < 24; i++) {
    try {
      const p = join(dir, '.git')
      const st = statSync(p)
      if (st.isDirectory() || st.isFile()) return dir
    } catch { /* keep walking */ }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Parse `git log --format=...%x1f...%d` lines into structured commit rows. */
function parseLog(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [hash, parents, author, email, date, subject, refs] = line.split('\x1f')
    rows.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date,
      subject,
      refs: parseRefs(refs),
    })
  }
  return rows
}

/** Parse git refs decoration like " (HEAD -> master, tag: v1, origin/dev)". */
function parseRefs(raw) {
  const refs = []
  if (!raw) return refs
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '').trim()
  if (!inner) return refs
  for (const part of inner.split(',')) {
    const item = part.trim()
    if (!item) continue
    if (item.startsWith('tag: ')) {
      refs.push({ kind: 'tag', name: item.slice(5).trim() })
    } else if (item.includes(' -> ')) {
      const [, target] = item.split(' -> ')
      refs.push({ kind: 'branch', name: target.trim(), head: item.startsWith('HEAD') })
    } else {
      refs.push({ kind: 'branch', name: item })
    }
  }
  return refs
}

/**
 * Parse `git status --porcelain=v1 -z` output. Returns [{x, y, path, oldPath?}].
 * In -z mode rename/copy entries emit two records: "XY <new path>" then "<old path>".
 */
function parsePorcelainZ(buf) {
  const records = []
  const parts = buf.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec || rec.length < 3) continue
    const x = rec[0]
    const y = rec[1]
    const path = rec.slice(3)
    if ((x === 'R' || x === 'C') && i + 1 < parts.length && parts[i + 1]) {
      records.push({ x, y, path, oldPath: parts[i + 1] })
      i++
      continue
    }
    records.push({ x, y, path })
  }
  return records
}

/**
 * Parse `git diff --numstat -z` output into a path -> {added, deleted} map.
 * Normal entries are "added\tdeleted\t<path>"; rename entries are
 * "added\tdeleted" + "\0" + "<old>" + "\0" + "<new>" (keyed by the new path);
 * binary entries use "-" for both counts.
 */
function parseNumstatZ(buf) {
  const map = new Map()
  const parts = buf.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const fields = rec.split('\t')
    if (fields.length < 2) continue
    const added = fields[0]
    const deleted = fields[1]
    let key
    if (fields.length >= 3) {
      key = fields[2]
    } else {
      // rename: "n\tn" then "<old>" then "<new>"
      const old = i + 1 < parts.length ? parts[i + 1] : ''
      const next = i + 2 < parts.length ? parts[i + 2] : ''
      key = next || old
      i += 2
    }
    if (key) map.set(key, { added, deleted })
  }
  return map
}

export function apply(ctx, config = {}) {
  const configured = []
  if (config.repo) configured.push(String(config.repo))
  if (Array.isArray(config.repos)) configured.push(...config.repos.map(String))
  const normalize = (p) => String(p).replace(/[\\/]+$/, '')
  const allowed = [...new Set(configured.map(normalize))].filter(Boolean)
  // Workspace-discovered repos (from the repos op) are accepted for reads too.
  // `recentKeys` holds case-folded keys so Windows paths differing only in case
  // still match (e.g. "C:/Work" vs "c:/work").
  const recentRepos = new Set()
  const recentKeys = new Set()
  const normKey = (p) => {
    const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const repoAllowed = (p) => {
    const k = normKey(p)
    if (allowed.some((a) => normKey(a) === k)) return true
    return recentKeys.has(k)
  }
  const addRecent = (p) => { recentRepos.add(p); recentKeys.add(normKey(p)) }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/git-graph',
    handler: async (req, res) => {
      /* Baseline hardening headers on every response (JSON and HTML).
       * nosniff stops a mislabeled response being sniffed as script; the page
       * renders inside the plugin iframe, so no-store also keeps a cached
       * snapshot of repo data from lingering in the browser cache. */
      const BASE_HEADERS = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      }
      const sendJson = (obj, status = 200) => {
        const body = JSON.stringify(obj)
        res.writeHead(status, {
          ...BASE_HEADERS,
          'content-type': 'application/json; charset=utf-8',
        })
        res.end(body)
      }
      try {
        const url = new URL(req.url, 'http://localhost')
        const pathname = url.pathname

        if (pathname === '/git-graph/' || pathname === '/git-graph/index.html') {
          res.writeHead(200, {
            ...BASE_HEADERS,
            'content-type': 'text/html; charset=utf-8',
            // The page is same-origin with the host GUI and only talks to this
            // API. The stylesheet and the app script are separate files served
            // from here, so 'self' covers both and 'unsafe-inline' is no longer
            // needed for either — it was only required back when the whole app
            // was one inline <script>.
            'content-security-policy': PAGE_CSP,
          })
          res.end(readFileSync(join(webRoot, 'index.html')))
          return
        }

        /* Static assets for the page: app.css and app.js. An explicit
         * allow-list rather than a directory server — `web/` holds only these
         * three files today, and an allow-list cannot be tricked into serving
         * something else that ends up in there later. The CSP header goes on
         * these responses too: for a normal subresource the document's policy
         * governs, but a direct navigation to either URL makes it the top-level
         * document, and then the header is the only thing constraining it. */
        if (pathname === '/git-graph/app.css' || pathname === '/git-graph/app.js') {
          const isCss = pathname.endsWith('.css')
          res.writeHead(200, {
            ...BASE_HEADERS,
            'content-type': isCss ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'content-security-policy': PAGE_CSP,
          })
          res.end(readFileSync(join(webRoot, isCss ? 'app.css' : 'app.js')))
          return
        }

        if (pathname !== '/git-graph/api') {
          sendJson({ ok: false, error: 'not-found' }, 404)
          return
        }

        /* ---- CSRF guard ---------------------------------------------------
         * Without this, any web page could destroy work by pointing an <img> at
         * `/git-graph/api?op=gitop&action=discard&...`: the browser attaches the
         * request, and GET-only handlers ran it. Three independent checks:
         *   1. writes must be POST (an <img>/<a> can never send POST)
         *   2. Origin, when present, must match this host
         *   3. Referer, when present, must match this host
         * Requests without Origin/Referer are allowed for reads so that
         * non-browser callers (curl, tests, the plugin's own startup) keep
         * working; writes additionally require POST, which browsers cannot
         * forge cross-site without a CORS preflight. */
        const WRITE_OPS = new Set(['gitop', 'autoupdate', 'addrepo', 'prefswrite'])
        const reqOp = url.searchParams.get('op') || 'graph'
        const isWrite = WRITE_OPS.has(reqOp)
        const selfHost = String(req.headers.host || '')
        const sameHost = (value) => {
          if (!value) return null                    // absent: caller decides
          try {
            const u = new URL(value, 'http://' + selfHost)
            return u.host === selfHost
          } catch { return false }
        }
        const originOk = sameHost(req.headers.origin)
        const refererOk = sameHost(req.headers.referer)
        if (originOk === false || refererOk === false) {
          sendJson({ ok: false, error: 'cross-origin-blocked' }, 403)
          return
        }
        if (isWrite && req.method !== 'POST') {
          sendJson({ ok: false, error: 'method-not-allowed', hint: 'write operations require POST' }, 405)
          return
        }

        const op = url.searchParams.get('op') || 'graph'

        if (op === 'prefs' || op === 'prefswrite') {
          // UI preference store (see readPrefs/writePrefs). Repo-independent.
          if (op === 'prefs') {
            sendJson({ ok: true, prefs: readPrefs() })
            return
          }
          // prefswrite: `set` is a JSON object of allow-listed keys to persist.
          const raw = url.searchParams.get('set') || ''
          if (!raw) {
            sendJson({ ok: false, error: 'missing-set' }, 400)
            return
          }
          let patch
          try {
            patch = JSON.parse(raw)
          } catch {
            sendJson({ ok: false, error: 'bad-json' }, 400)
            return
          }
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            sendJson({ ok: false, error: 'bad-shape' }, 400)
            return
          }
          try {
            const prefs = writePrefs(patch)
            sendJson({ ok: true, prefs })
          } catch (err) {
            sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
          }
          return
        }
        if (op === 'repos') {
          // The current session's workspace (ws) is preferred when a git work
          // tree is found at or above it; configured repos follow as fallbacks.
          // `add` re-registers repos the user picked via the folder picker
          // (they are persisted on the client and re-sent on every load,
          // because the in-memory allow-set resets when dsh restarts).
          for (const a of url.searchParams.getAll('add')) {
            const root = findGitRoot(a)
            if (root) addRecent(root)
          }
          // Drop configured paths that are not working git trees, so a stale
          // example config never poisons the repo list (not-a-git-repo).
          // This uses the statSync check: a process launch per configured repo
          // made the endpoint cost ~200ms each for no extra certainty.
          const configuredOk = []
          for (const r of allowed) {
            if (hasGitEntry(r)) configuredOk.push(r)
          }
          // Same for user-added repos: a folder removed from disk must not stay
          // in the switcher forever (it would become the remembered current one).
          // Light existence check (.git entry) + case-folded dedup (recentKeys).
          const recentOk = []
          for (const r of recentRepos) {
            if (hasGitEntry(r) && !recentOk.some((x) => normKey(x) === normKey(r))) recentOk.push(r)
          }
          const ws = normalize(url.searchParams.get('ws') || '')
          let wsRoot = null
          let wsIsGit = false
          if (ws) {
            const root = findGitRoot(ws)
            if (root) {
              wsRoot = root
              wsIsGit = true
            }
          }
          const repos = []
          if (wsRoot) repos.push(wsRoot)
          for (const r of configuredOk) if (!repos.some((x) => normKey(x) === normKey(r))) repos.push(r)
          for (const r of recentOk) if (!repos.some((x) => normKey(x) === normKey(r))) repos.push(r)
          for (const r of repos) addRecent(r)
          let current = null
          if (wsIsGit) current = wsRoot
          else current = repos[0] ?? null // first configured/user repo (ws non-git or absent)
          sendJson({ ok: true, repos, current, ws, wsRoot, wsIsGit })
          return
        }

        if (op === 'findrepos') {
          // One-click discovery for the empty-state button「在当前对话目录下查找 Git 仓库」:
          // find the git root at/above the workspace; when there is none, shallow-scan
          // subdirectories (depth <= 2, skipping heavy/hidden entries) for git work
          // trees. Read-only: statSync/readdirSync only, no shell. Bounded work:
          // MAX_DIRS enumerated, MAX_RESULTS returned.
          const ws = normalize(url.searchParams.get('ws') || '')
          let wsStat = null
          try { wsStat = statSync(ws) } catch { /* absent */ }
          if (!ws || !wsStat || !wsStat.isDirectory()) {
            sendJson({ ok: false, error: 'bad-ws' }, 400)
            return
          }
          const MAX_DIRS = 300
          const MAX_RESULTS = 20
          const out = []
          const seen = new Set()
          const pushRoot = (dir) => {
            let root = null
            try { root = findGitRoot(dir) } catch { /* ignore */ }
            if (!root) return
            const k = normKey(root)
            if (seen.has(k)) return
            seen.add(k)
            out.push(root)
          }
          const depthOf = (p) => {
            const a = String(ws).replace(/\\/g, '/').split('/')
            const b = String(p).replace(/\\/g, '/').split('/')
            let i = 0
            while (i < a.length && i < b.length && a[i] === b[i]) i++
            return b.length - i
          }
          pushRoot(ws)
          if (out.length === 0) {
            // Shallow scan: enumerate ws and its subdirectories; check every
            // enumerated dir plus one more level for git roots.
            const queue = [ws]
            let dirs = 0
            while (queue.length > 0 && dirs < MAX_DIRS && out.length < MAX_RESULTS) {
              const dir = queue.shift()
              let entries = []
              try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
              for (const e of entries) {
                if (!e.isDirectory()) continue
                const name = e.name
                if (name === '.git' || name === 'node_modules' || name.startsWith('.') ||
                    name === '$RECYCLE.BIN' || name === 'System Volume Information') continue
                const full = join(dir, name)
                if (++dirs > MAX_DIRS) break
                pushRoot(full)
                if (out.length >= MAX_RESULTS) break
                if (depthOf(full) < 2) queue.push(full)
              }
            }
          }
          sendJson({ ok: true, ws, repos: out })
          return
        }

        if (op === 'listdir') {
          // Directory browser for the "打开文件夹" picker. Read-only; lists only
          // subdirectories (never files) with a per-entry git marker ("git"
          // = the folder contains a .git entry, so it is a repo or a submodule).
          const hasDotGit = (dir) => {
            try { return !!statSync(join(dir, '.git')) } catch { return false }
          }
          const listSubdirs = (dir) => {
            let entries = []
            try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return { dirs: [], truncated: false, readable: false } }
            const names = entries
              .filter((e) => e.isDirectory() && e.name !== '.git')
              .map((e) => e.name)
              .sort((a, b) => a.localeCompare(b))
            const limit = 500
            const dirs = names.slice(0, limit).map((name) => {
              const full = join(dir, name)
              return { name, path: full.replace(/\\/g, '/'), git: hasDotGit(full) }
            })
            return { dirs, truncated: names.length > limit, readable: true }
          }
          let p = String(url.searchParams.get('path') || '').trim().replace(/\\/g, '/')
          if (!p) {
            if (process.platform === 'win32') {
              // No path yet: list the drive letters the picker can start from.
              const drives = []
              for (let c = 65; c <= 90; c++) {
                const d = String.fromCharCode(c) + ':/'
                try { if (statSync(d).isDirectory()) drives.push(d) } catch { /* drive absent */ }
              }
              sendJson({ ok: true, path: '', parent: null, drives, dirs: [], root: null, truncated: false, readable: true })
              return
            }
            p = '/'
          }
          if (/^[A-Za-z]:$/.test(p)) p += '/' // bare drive letter ("C:") -> "C:/"
          let abs
          try { abs = resolve(p) } catch { sendJson({ ok: false, error: 'bad-path', path: p }, 400); return }
          let st
          try { st = statSync(abs) } catch { sendJson({ ok: false, error: 'not-found', path: p }, 404); return }
          if (!st.isDirectory()) { sendJson({ ok: false, error: 'not-a-directory', path: p }, 400); return }
          const norm = abs.replace(/\\/g, '/')
          const par = dirname(norm)
          const { dirs, truncated, readable } = listSubdirs(abs)
          let root = null
          try { root = findGitRoot(abs) } catch { /* ignore */ }
          sendJson({ ok: true, path: norm, parent: par === norm ? null : par, dirs, root, truncated, readable })
          return
        }

        if (op === 'addrepo') {
          // Register a folder (or any folder inside one) as an openable repo:
          // finds the enclosing git work tree, like the workspace discovery,
          // then verifies it really is a working tree (a bare .git dir alone
          // is not enough — it could be empty/corrupted).
          const p = String(url.searchParams.get('path') || '').trim()
          if (!p) { sendJson({ ok: false, error: 'missing-path' }, 400); return }
          let abs
          try { abs = resolve(p) } catch { sendJson({ ok: false, error: 'bad-path', path: p }, 400); return }
          let st
          try { st = statSync(abs) } catch { sendJson({ ok: false, error: 'not-found', path: p }, 404); return }
          if (!st.isDirectory()) { sendJson({ ok: false, error: 'not-a-directory', path: p }, 400); return }
          const root = findGitRoot(abs)
          if (!root || !(await isGitRepo(root))) { sendJson({ ok: false, error: 'not-a-git-repo', path: p }, 400); return }
          addRecent(root)
          sendJson({ ok: true, repo: root })
          return
        }

        if (op === 'checkupdate') {
          // Compare the installed version against the latest GitHub tag.
          // Read-only; the client decides whether to offer an update.
          // Even when the network fails we still return the installed
          // version so the UI can always display it. Handled before the repo
          // gate (it needs no repository); when the plugin is mounted from a
          // git checkout the update is always suppressed.
          const current = localVersion()
          const managed = (await gitManaged()) ? 'git' : undefined
          try {
            const latest = await latestTag()
            const hasUpdate = !managed && latest ? cmpVer(latest, current) > 0 : false
            sendJson({ ok: true, current, latest: managed ? '' : latest, hasUpdate, managed })
          } catch (err) {
            sendJson({ ok: true, current, latest: '', hasUpdate: false, network: false, managed, error: String((err && err.message) || err) })
          }
          return
        }

        if (op === 'autoupdate') {
          // Download the given tag from GitHub and swap this plugin's files.
          // The caller must confirm first; a restart of dsh web is required
          // afterwards (the running process keeps the old code in memory).
          // Also repo-independent: handled before the repo gate.
          if (await gitManaged()) {
            sendJson({ ok: false, error: 'git-managed' }, 409)
            return
          }
          const tag = url.searchParams.get('tag')
          if (!tag) {
            sendJson({ ok: false, error: 'missing-tag' }, 400)
            return
          }
          try {
            await applyUpdate(tag)
            sendJson({ ok: true, restart: true })
          } catch (err) {
            sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
          }
          return
        }

        let repo = url.searchParams.get('repo') || allowed[0]
        const repoNorm = normalize(repo || '')
        if (!repoNorm || !repoAllowed(repoNorm)) {
          // Do not echo the allow-list: it would hand any unauthenticated caller
          // a map of absolute paths on this machine. The count is enough for the
          // UI to tell "no repos" apart from "wrong repo".
          sendJson({ ok: false, error: 'repo-not-allowed', count: allowed.length + recentRepos.size }, 403)
          return
        }
        repo = repoNorm

        // Sanity: reject paths that are not existing git work trees.
        // This runs on EVERY api call, so it must not launch a process: a
        // `git rev-parse` here cost ~217ms per request on a machine where
        // process creation is slow — it doubled the cost of every endpoint
        // (show went from one spawn to two, filediff from two to three).
        // A `.git` entry check answers the same question for the cases that
        // matter here, because the path already passed the allow-list check.
        if (!hasGitEntry(repo)) {
          sendJson({ ok: false, error: 'not-a-git-repo', repo }, 400)
          return
        }

        switch (op) {
          case 'graph': {
            // Spawn count matters a lot here: on Windows each `git` launch costs
            // ~200ms (AV real-time scanning serializes process creation), so the
            // old head + rev-list --count + log triple cost ~670ms. Both extra
            // commands are now folded into the log call:
            //   * head   -> `log -1` on HEAD via %D is unreliable; instead we read
            //               .git/HEAD from disk (sync, ~0ms) and resolve the ref
            //   * total  -> log is unbounded when no limit is given; with a limit
            //               we still need the count, so it is skipped when the
            //               caller asks for everything (limit === 0).
            const limit = Math.max(0, Math.min(parseInt(url.searchParams.get('limit') || '0', 10) || 0, 2000))
            const skip = Math.max(0, parseInt(url.searchParams.get('skip') || '0', 10) || 0)
            // total the client already knows from an earlier page (0 = unknown)
            const knownTotal = Math.max(0, parseInt(url.searchParams.get('total') || '0', 10) || 0)
            // Ordering. `topo` (default) keeps each branch's commits together,
            // which is what the grouped view wants. `date` interleaves branches
            // strictly by commit date — the flat view asks for this so the
            // timeline reads chronologically, at the cost of a branch's commits
            // being split across the list.
            const order = url.searchParams.get('order') === 'date' ? '--date-order' : '--topo-order'
            const args = ['log', '--all', order, '--date=iso-strict',
              '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%d']
            if (skip > 0) args.push('--skip=' + skip)
            if (limit > 0) args.push('-n', String(limit))
            // A limited page needs the true total for the "load more" button;
            // the unlimited call already returns every commit (total = length).
            const [headName, log] = await Promise.all([
              readHeadName(repo),
              runGit(repo, args),
            ])
            const commits = parseLog(log)
            // The true total is only needed to label "已显示 50 / 241", so it
            // must not delay the first paint. The client can opt out with
            // `count=0` and fetch it separately via op=count; everything else
            // (paging, which already knows the total) is unaffected.
            const wantCount = url.searchParams.get('count') !== '0'
            let total
            if (skip === 0 && (limit === 0 || commits.length < limit)) {
              // full history, or it fit inside the first page
              total = commits.length
            } else if (knownTotal > 0) {
              total = knownTotal
            } else if (!wantCount) {
              total = 0                                   // caller will ask via op=count
            } else {
              // first page of a longer history: ask git once
              total = parseInt((await runGit(repo, ['rev-list', '--all', '--count']).catch(() => '0')).trim(), 10) || 0
            }
            sendJson({
              ok: true,
              repo,
              head: headName,
              total,
              commits,
            })
            break
          }
          case 'count': {
            // Total number of commits reachable from any ref, used to label
            // "已显示 50 / 241". Split out of `graph` so the first page does not
            // wait for it (they are two independent spawns otherwise).
            const total = parseInt((await runGit(repo, ['rev-list', '--all', '--count']).catch(() => '0')).trim(), 10) || 0
            sendJson({ ok: true, repo, total })
            break
          }
          case 'head': {
            // Change-detection probe for the 5s auto-refresh tick.
            // Now zero spawns: the ref tips are read off disk (same source as
            // `branches`). This runs every 5 seconds for as long as the plugin
            // is open, so a git launch here used to cost ~870ms of a background
            // process 12 times a minute.
            const disk = readRefsFromDisk(repo, readHeadName(repo))
            if (disk) {
              const lines = disk
                .filter((b) => b.kind === 'local' || b.kind === 'remote')
                .map((b) => `${b.sha} ${b.refname}`)
                .sort()
              sendJson({ ok: true, repo, refs: lines.length, sig: lines.join('|') })
              break
            }
            // fallback: exotic ref layout
            const out = await runGit(repo, [
              'for-each-ref', '--format=%(objectname) %(refname)',
              'refs/heads', 'refs/remotes',
            ]).catch(() => '')
            const lines = out.split('\n').map((s) => s.trim()).filter(Boolean)
            // deterministic order so the signature is stable between polls
            lines.sort()
            sendJson({
              ok: true,
              repo,
              refs: lines.length,
              sig: lines.join('|'),
            })
            break
          }
          case 'branches': {
            // Read refs straight off disk (0 spawns). Falls back to
            // `for-each-ref` only if the on-disk layout is unreadable, so an
            // exotic setup still works at the old cost.
            const fromDisk = readRefsFromDisk(repo, readHeadName(repo))
            if (fromDisk) { sendJson({ ok: true, branches: fromDisk }); break }
            // for-each-ref supports %09 (tab) but not %x1f (that is a log/pretty-format feature).
            const out = await runGit(repo, [
              'for-each-ref',
              '--format=%(refname)%09%(objectname)%09%(HEAD)',
              'refs/heads', 'refs/remotes', 'refs/tags',
            ])
            const branches = []
            for (const line of out.split('\n')) {
              if (!line) continue
              const [refname, sha, isHead] = line.split('\t')
              branches.push({
                refname,
                kind: refname.startsWith('refs/tags/') ? 'tag' : refname.startsWith('refs/remotes/') ? 'remote' : 'local',
                name: refname.replace(/^refs\/(heads|remotes|tags)\//, ''),
                sha,
                head: isHead === '*',
              })
            }
            sendJson({ ok: true, branches })
            break
          }
          case 'workstatus': {
            // VSCode-style working-tree overview: structured file lists grouped by
            // staged / unstaged / untracked, with per-file +/- counts (numstat).
            // The branch name comes from `status --branch` (first "## <branch>"
            // record) instead of a separate rev-parse call — one less spawn, and
            // this endpoint is polled every 5s by the client.
            const statusOut = await runGit(repo, ['status', '--branch', '--porcelain=v1', '-z']).catch(() => '')
            // The first -z record of `status --branch` is the "## <branch>"
            // header, NUL-terminated like any other record. Parse it out first
            // and hand the remainder to parsePorcelainZ (which would otherwise
            // see "#master..." as a file path and emit a bogus staged entry).
            // "## master...origin/master [ahead 1]" / "## HEAD (no branch)"
            const nulAt = statusOut.indexOf('\0')
            const hasBranchHead = statusOut.startsWith('## ') && nulAt > 0
            const branchLine = hasBranchHead ? statusOut.slice(3, nulAt) : ''
            const filesOut = hasBranchHead ? statusOut.slice(nulAt + 1) : statusOut
            const branch = branchLine
              ? (branchLine.startsWith('No commits yet on ') ? branchLine.slice('No commits yet on '.length)
                : branchLine.startsWith('Initial commit on ') ? branchLine.slice('Initial commit on '.length)
                : branchLine.split('...')[0].split(' ')[0]) || 'HEAD'
              : (await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || 'HEAD'
            const statusRecords = parsePorcelainZ(filesOut)
            // Only ask for numstat when there is something to count. On a clean
            // tree (the common polling case) both diffs would spawn a git process
            // each and return nothing, so they are skipped: clean = 1 spawn.
            const needStaged = statusRecords.some((r) => r.x !== ' ' && r.x !== '?' && r.x !== '!')
            const needUnstaged = statusRecords.some((r) => r.y !== ' ' && r.y !== '?' && r.y !== '!')
            const stagedNum = needStaged ? await runGit(repo, ['diff', '--cached', '--numstat', '-z']).catch(() => '') : ''
            const unstagedNum = needUnstaged ? await runGit(repo, ['diff', '--numstat', '-z']).catch(() => '') : ''
            const stagedCounts = parseNumstatZ(stagedNum)
            const unstagedCounts = parseNumstatZ(unstagedNum)
            const staged = []
            const unstaged = []
            const untracked = []
            for (const r of statusRecords) {
              const num = (m) => {
                const n = m.get(r.path)
                return n ? { added: n.added === '-' ? null : parseInt(n.added, 10) || 0, deleted: n.deleted === '-' ? null : parseInt(n.deleted, 10) || 0, binary: n.added === '-' } : { added: 0, deleted: 0, binary: false }
              }
              const conflict = (r.x === 'U' || r.x === 'A' || r.x === 'D') && (r.y === 'U' || r.y === 'A' || r.y === 'D')
              if (r.x === '?' && r.y === '?') {
                untracked.push({ path: r.path })
                continue
              }
              if (conflict) {
                unstaged.push({ path: r.path, oldPath: r.oldPath || '', code: 'U', ...num(unstagedCounts) })
                continue
              }
              if (r.x !== ' ' && r.x !== '?') {
                staged.push({ path: r.path, oldPath: r.oldPath || '', code: r.x, ...num(stagedCounts) })
              }
              if (r.y !== ' ' && r.y !== '?') {
                unstaged.push({ path: r.path, oldPath: r.oldPath || '', code: r.y, ...num(unstagedCounts) })
              }
            }
            sendJson({
              ok: true,
              repo,
              branch,
              staged,
              unstaged,
              untracked,
              counts: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length },
            })
            break
          }
          case 'workfile': {
            // Per-file diff (or content for untracked files) of the working tree.
            const file = url.searchParams.get('file')
            const staged = url.searchParams.get('staged') || '0' // '0' | '1' | 'untracked'
            if (!file) {
              sendJson({ ok: false, error: 'missing-file' }, 400)
              return
            }
            const full = resolve(repo, file).replace(/\\/g, '/')
            const base = repo.replace(/\\/g, '/')
            if (full !== base && !full.startsWith(base + '/')) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            if (staged === 'untracked') {
              let st
              try { st = statSync(full) } catch {
                sendJson({ ok: false, error: 'file-not-found', file }, 404)
                return
              }
              if (!st.isFile()) {
                sendJson({ ok: true, isDir: true, content: '' })
                return
              }
              let content = ''
              try { content = readFileSync(full, 'utf8') } catch (err) {
                sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
                return
              }
              if (content.includes('\0')) {
                sendJson({ ok: true, binary: true, content: '' })
                return
              }
              const truncated = content.length > MAX_DIFF_CHARS
              sendJson({ ok: true, content: truncated ? content.slice(0, MAX_DIFF_CHARS) : content, truncated })
              return
            }
            const paths = [file]
            const old = url.searchParams.get('old')
            if (old) paths.push(old)
            const args = (staged === '1'
              ? ['diff', '--cached', '--no-color', '--', ...paths]
              : ['diff', '--no-color', '--', ...paths])
            const out = await runGit(repo, args).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }
          case 'filelog': {
            // Commit history of one file (--follow tracks renames).
            const file = url.searchParams.get('file')
            if (!file) {
              sendJson({ ok: false, error: 'missing-file' }, 400)
              return
            }
            const full = resolve(repo, file).replace(/\\/g, '/')
            const base = repo.replace(/\\/g, '/')
            if (full !== base && !full.startsWith(base + '/')) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            const log = await runGit(repo, [
              'log', '--follow', '--topo-order', '--date=iso-strict',
              '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%d', '--', file,
            ]).catch(() => '')
            sendJson({ ok: true, file, commits: parseLog(log) })
            break
          }
          case 'reveal': {
            // Open the repo folder in the OS file manager (harmless convenience).
            const opener = process.platform === 'win32' ? 'explorer'
              : process.platform === 'darwin' ? 'open'
              : 'xdg-open'
            await runGit(repo, ['rev-parse', '--show-toplevel']).then((root) => {
              return new Promise((resolvePromise) => {
                // GUI file managers may exit non-zero even on success; ignore the code.
                execFile(opener, [root.trim()], { windowsHide: true }, () => resolvePromise())
              })
            })
            sendJson({ ok: true })
            break
          }
          case 'remoteinfo': {
            // Resolve the origin remote to a web base URL (e.g. https://github.com/u/r)
            // so the client can build "/commit/<hash>" links. Returns {web, remote} or
            // {web: null} when no usable remote exists.
            const urlOut = await runGit(repo, ['remote', 'get-url', 'origin']).catch(() => '')
            const raw = urlOut.trim()
            if (!raw) {
              sendJson({ ok: true, web: null, remote: '' })
              break
            }
            let web = raw
            if (/^git@(.+):(.+)$/.test(raw)) {
              // scp-like: git@host:path.git -> https://host/path
              web = raw.replace(/^git@([^:]+):(.*)$/, 'https://$1/$2')
            } else if (/^ssh:\/\//.test(raw)) {
              web = raw.replace(/^ssh:\/\/([^@]+@)?/, 'https://')
            }
            // Drop the .git suffix and any trailing slash.
            web = web.replace(/\.git\/?$/, '').replace(/\/+$/, '')
            // The client feeds this straight into window.open(). A remote such as
            // `javascript:alert(1)//` would otherwise become executable script in
            // the plugin's origin, so only real web URLs may pass. Anything else
            // yields web:null and the UI simply hides the "open GitHub" action.
            if (!isSafeWebUrl(web)) {
              sendJson({ ok: true, web: null, remote: raw, rejected: 'unsafe-url' })
              break
            }
            sendJson({ ok: true, web, remote: raw })
            break
          }
          case 'suggestmsg': {
            // Heuristic commit-message suggestion from the working-tree diff.
            // No external AI call: builds conventional-commit style candidates
            // from file names + add/del counts.
            const stagedNum = await runGit(repo, ['diff', '--cached', '--numstat', '-z']).catch(() => '')
            const unstagedNum = await runGit(repo, ['diff', '--numstat', '-z']).catch(() => '')
            const statusOut = await runGit(repo, ['status', '--porcelain=v1', '-z']).catch(() => '')
            const stagedCounts = parseNumstatZ(stagedNum)
            const unstagedCounts = parseNumstatZ(unstagedNum)
            const untracked = []
            const staged = []
            const unstaged = []
            for (const r of parsePorcelainZ(statusOut)) {
              if (r.x === '?' && r.y === '?') { untracked.push(r.path); continue }
              if (r.x !== ' ' && r.x !== '?') staged.push(r.path)
              if (r.y !== ' ' && r.y !== '?') unstaged.push(r.path)
            }
            const name = (p) => p.split('/').pop()
            const files = [...staged, ...unstaged, ...untracked]
            let ins = 0; let del = 0
            for (const m of [stagedCounts, unstagedCounts]) {
              for (const v of m.values()) {
                ins += v.added === '-' ? 0 : parseInt(v.added, 10) || 0
                del += v.deleted === '-' ? 0 : parseInt(v.deleted, 10) || 0
              }
            }
            const candidates = []
            const uniq = [...new Set(files)]
            if (untracked.length && !staged.length && !unstaged.length) {
              candidates.push(`feat: 新增 ${untracked.map(name).slice(0, 3).join('、')}${untracked.length > 3 ? ' 等' : ''}（${untracked.length} 个文件）`)
            } else if (del >= ins && del > 0) {
              candidates.push(`fix: 移除/精简 ${uniq.map(name).slice(0, 3).join('、')}${uniq.length > 3 ? ' 等' : ''}`)
            } else if (uniq.length) {
              candidates.push(`feat: 更新 ${uniq.map(name).slice(0, 3).join('、')}${uniq.length > 3 ? ' 等' : ''}`)
            }
            if (uniq.length) {
              const names = uniq.map(name).slice(0, 5).join('、')
              candidates.push(`chore: 调整 ${names}${uniq.length > 5 ? ` 等 ${uniq.length} 个文件` : ''}（+${ins} -${del}）`)
            }
            if (!uniq.length) candidates.push('chore: 清理/整理')
            sendJson({
              ok: true,
              summary: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length, insertions: ins, deletions: del },
              files: uniq,
              candidates: candidates.slice(0, 3),
            })
            break
          }
          case 'gitop': {
            // Working-tree write operations (stage/unstage/discard/commit).
            // All file paths are validated to stay inside the repo; the client
            // confirms destructive actions before calling.
            const action = url.searchParams.get('action')
            const files = url.searchParams.getAll('file').filter(Boolean)
            const base = repo.replace(/\\/g, '/')
            const okPath = (p) => {
              const full = resolve(repo, p).replace(/\\/g, '/')
              return full === base || full.startsWith(base + '/')
            }
            if (files.some((p) => !okPath(p))) {
              sendJson({ ok: false, error: 'path-outside-repo' }, 400)
              return
            }
            try {
              switch (action) {
                case 'stage':
                  if (!files.length) throw new Error('missing-file')
                  await runGit(repo, ['add', '--', ...files])
                  break
                case 'stage-all':
                  await runGit(repo, ['add', '-A'])
                  break
                case 'unstage':
                  if (!files.length) throw new Error('missing-file')
                  await runGit(repo, ['restore', '--staged', '--', ...files])
                  break
                case 'unstage-all':
                  // mixed reset: unstage everything, keep working tree
                  await runGit(repo, ['reset'])
                  break
                case 'discard':
                  // Restore file(s) to HEAD: staged + worktree changes are lost.
                  if (!files.length) throw new Error('missing-file')
                  await runGit(repo, ['restore', '--staged', '--worktree', '--', ...files])
                  break
                case 'discard-all':
                  // Restore every tracked file to HEAD (untracked files untouched).
                  await runGit(repo, ['restore', '--staged', '--worktree', '.'])
                  break
                case 'commit': {
                  const message = url.searchParams.get('message')
                  if (!message || !message.trim()) throw new Error('missing-message')
                  if (files.length) {
                    // selective commit: stage exactly these files and limit the
                    // commit to them (paths are staged so `-- files` works).
                    await runGit(repo, ['add', '--', ...files])
                    await runGit(repo, ['commit', '-m', message.trim(), '--', ...files])
                  } else {
                    if (url.searchParams.get('all') === '1') {
                      await runGit(repo, ['add', '-A'])
                    }
                    await runGit(repo, ['commit', '-m', message.trim()])
                  }
                  break
                }
                case 'ignore': {
                  // Add files to .gitignore; tracked files are untracked first
                  // (git rm --cached keeps them on disk).
                  if (!files.length) throw new Error('missing-file')
                  const tracked = []
                  for (const f of files) {
                    const out = await runGit(repo, ['ls-files', '--error-unmatch', '--', f]).catch(() => '')
                    if (out.trim()) tracked.push(f)
                  }
                  if (tracked.length) {
                    await runGit(repo, ['rm', '--cached', '--', ...tracked])
                  }
                  const gi = join(repo, '.gitignore')
                  let lines = ''
                  try { lines = readFileSync(gi, 'utf8') } catch { /* no .gitignore yet */ }
                  const has = (p) => lines.split(/\r?\n/).some((l) => l.trim() === p)
                  const adds = []
                  for (const f of files) {
                    const norm = f.replace(/\\/g, '/')
                    if (!has(norm)) adds.push(norm)
                  }
                  if (adds.length) {
                    const prefix = lines.length && !lines.endsWith('\n') ? '\n' : ''
                    appendFileSync(gi, prefix + adds.join('\n') + '\n')
                  }
                  break
                }
                case 'tag': {
                  // Lightweight tag on a commit (harmless; no editor, no push).
                  const name = url.searchParams.get('name')
                  const hash = url.searchParams.get('hash')
                  if (!name || !name.trim()) throw new Error('missing-tag-name')
                  if (!hash) throw new Error('missing-hash')
                  await runGit(repo, ['tag', name.trim(), hash])
                  break
                }
                case 'tag-delete': {
                  // Delete a local tag (does not touch remotes).
                  const name = url.searchParams.get('name')
                  if (!name || !name.trim()) throw new Error('missing-tag-name')
                  await runGit(repo, ['tag', '-d', name.trim()])
                  break
                }
                case 'tag-rename': {
                  // Rename a local tag: create the new name at the same commit,
                  // then drop the old one (create-first keeps the tag if delete fails).
                  const name = url.searchParams.get('name')
                  const newname = url.searchParams.get('newname')
                  const hash = url.searchParams.get('hash')
                  if (!name || !name.trim()) throw new Error('missing-tag-name')
                  if (!newname || !newname.trim()) throw new Error('missing-new-tag-name')
                  if (!hash) throw new Error('missing-hash')
                  await runGit(repo, ['tag', newname.trim(), hash])
                  await runGit(repo, ['tag', '-d', name.trim()])
                  break
                }
                case 'branch': {
                  // Create a new lightweight branch at the given commit.
                  const name = url.searchParams.get('name')
                  const hash = url.searchParams.get('hash')
                  if (!name || !name.trim()) throw new Error('missing-branch-name')
                  if (!hash) throw new Error('missing-hash')
                  // Reject names that would escape refs/heads (no slashes-injection guard needed:
                  // git itself validates ref names, but keep a sane limit).
                  await runGit(repo, ['branch', name.trim(), hash])
                  break
                }
                case 'fetch': {
                  // Pull remote refs into refs/remotes (no merge). Works with the
                  // configured origin, or any remote if none named.
                  await runGit(repo, ['fetch', '--all', '--prune'], MAX_GIT_BUFFER, 120000)
                  break
                }
                case 'pull': {
                  // Pull + merge the current branch from origin (may conflict; the
                  // client warns before calling). Returns the pull summary.
                  const branch = url.searchParams.get('branch')
                  const out = await runGit(repo, ['pull', 'origin', branch || ''], MAX_GIT_BUFFER, 120000)
                  sendJson({ ok: true, summary: String(out).trim() })
                  return
                }
                case 'push': {
                  // Push the current branch to origin. May require credentials;
                  // non-fast-forward and auth errors come back as git stderr.
                  const branch = url.searchParams.get('branch')
                  const out = await runGit(repo, ['push', 'origin', branch || 'HEAD'], MAX_GIT_BUFFER, 120000)
                  sendJson({ ok: true, summary: String(out).trim() })
                  return
                }
                case 'checkout': {
                  // Switch to a local branch (dirty worktree errors come from git).
                  const name = url.searchParams.get('name')
                  if (!name || !name.trim()) throw new Error('missing-branch-name')
                  await runGit(repo, ['checkout', name.trim()])
                  break
                }
                case 'delete-branch': {
                  // Delete a local branch (-d: refuses unmerged branches).
                  const name = url.searchParams.get('name')
                  if (!name || !name.trim()) throw new Error('missing-branch-name')
                  await runGit(repo, ['branch', '-d', name.trim()])
                  break
                }
                default:
                  sendJson({ ok: false, error: 'unknown-action' }, 400)
                  return
              }
              sendJson({ ok: true })
            } catch (err) {
              sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
            }
            break
          }
          case 'show': {
            const hash = url.searchParams.get('hash')
            if (!hash) {
              sendJson({ ok: false, error: 'missing-hash' }, 400)
              return
            }
            // One spawn instead of two: `show --stat` emits the commit header and
            // the file stat together. The header uses \x1f field separators and is
            // terminated by a marker line that cannot appear in commit metadata,
            // so the stat section can be split off reliably even for root commits
            // (whose %P is empty and therefore contains an empty \x1f field).
            const MARK = '\x1e--STAT--\x1e'
            const out = await runGit(repo, [
              'show', '--stat', '--no-color',
              `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%n${MARK}`,
              hash,
            ]).catch(() => '')
            const sep = out.indexOf(MARK)
            const metaOut = sep === -1 ? out : out.slice(0, sep)
            const statOut = sep === -1 ? '' : out.slice(sep + MARK.length)
            const parts = metaOut.split('\x1f')
            const sha = parts[0] || hash
            const parents = (parts[1] || '').trim()
            const author = parts[2] || ''
            const email = parts[3] || ''
            const date = parts[4] || ''
            const subject = parts[5] || ''
            const body = parts.slice(6).join('\x1f').replace(/\s+$/, '')
            const stat = statOut.replace(/^\s*\n/, '').replace(/\s+$/, '')
            sendJson({ ok: true, hash: sha, parents: parents ? parents.split(' ') : [], author, email, date, subject, body, stat })
            break
          }
          case 'diff': {
            const hash = url.searchParams.get('hash')
            if (!hash) {
              sendJson({ ok: false, error: 'missing-hash' }, 400)
              return
            }
            // Full patch of one commit (git diff against its first parent; root commits diff against empty tree).
            const out = await runGit(repo, ['show', '--no-color', '--format=', hash]).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }
          case 'filediff': {
            const hash = url.searchParams.get('hash')
            const file = url.searchParams.get('file')
            if (!hash || !file) {
              sendJson({ ok: false, error: 'missing-hash-or-file' }, 400)
              return
            }
            // Diff of a single file inside one commit.
            // One spawn instead of two: `git show <hash> -- <path>` already
            // diffs against the first parent, and for a root commit it diffs
            // against the empty tree — exactly the behaviour the old
            // log-to-get-parents + diff/show pair reproduced by hand.
            const out = await runGit(repo, ['show', '--no-color', '--format=', hash, '--', file]).catch(() => '')
            const truncated = out.length > MAX_DIFF_CHARS
            sendJson({ ok: true, file, diff: truncated ? out.slice(0, MAX_DIFF_CHARS) : out, truncated })
            break
          }
          default:
            sendJson({ ok: false, error: 'unknown-op' }, 400)
        }
      } catch (err) {
        try {
          sendJson({ ok: false, error: String((err && err.message) || err) }, 500)
        } catch {
          /* response already committed */
        }
      }
    },
  }), 'git-graph: /git-graph route')
}
