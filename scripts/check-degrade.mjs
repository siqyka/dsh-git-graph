#!/usr/bin/env node
/**
 * check-degrade.mjs — 降级回归：没有 ssh-workspace 时，本地行为与基线版本一致。
 *
 * 为什么需要它：
 *   远端支持（v0.26.3）在 `runGit`、白名单、路径守卫、仓库校验上开了分叉。
 *   分叉写错时最容易发生的事故是**本地悄悄被改掉**：`-C` 被误删、白名单多认
 *   一类路径、路径守卫恒假、`repos` 少一个字段。这些都能让远端测试全绿而本地
 *   坏掉，而本地才是绝大多数用户的使用方式。
 *
 * 做法（不是「本地还能用」这种软判据）：
 *   把基线版本（默认 tag `v0.26.2`，可用 `--base` 或 `DSH_GG_DEGRADE_BASE`
 *   指定）的 `index.js` 从 git 里取出来，与当前 `index.js` **同时**挂到最小
 *   fake host 上，各自对**内容相同的一份仓库副本**跑同一套 op 序列，逐字段比对。
 *   字段顺序无关，路径与 sha 归一化。
 *
 *   fake host 刻意**不提供 `subprocess` 服务**——这正是「用户没装
 *   dsh-ssh-workspace」的真实状态，也是唯一需要保证不受影响的场景。
 *
 * 允许的差异只有已知新增字段（`wsRemote` / `wsProbe`），单独断言，其余键必须相同。
 *
 * 用法：
 *   node scripts/check-degrade.mjs                 # 默认基线 v0.26.2
 *   node scripts/check-degrade.mjs --base v0.26.1  # 指定其它基线
 *   基线 ref 不存在时 SKIP（不影响发布链）。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts })

/* ---- resolve the baseline version --------------------------------------- */
const argv = process.argv.slice(2)
const baseArg = (() => {
  const i = argv.indexOf('--base')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--base='))
  if (eq) return eq.slice('--base='.length)
  return process.env.DSH_GG_DEGRADE_BASE || ''
})()
const candidates = baseArg ? [baseArg] : ['v0.26.2', 'v0.26.1', 'v0.26.0']
const base = candidates.find((ref) => {
  try { git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { stdio: 'pipe' }); return true } catch { return false }
})
if (!base) {
  console.log(`[degrade] SKIP: 找不到基线版本（试过 ${candidates.join(', ')}）`)
  console.log('         用 --base <ref> 或 DSH_GG_DEGRADE_BASE=<ref> 指定一个旧版本。')
  process.exit(0)
}
console.log(`[degrade] 关闭 ssh-workspace 后，本地行为与基线 ${base} 对比`)

const oldSource = git(['show', `${base}:index.js`])

/* ---- scratch space ------------------------------------------------------ */
const work = join(tmpdir(), `dsh-gg-degrade-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const oldDir = join(work, 'base')
mkdirSync(oldDir, { recursive: true })
writeFileSync(join(oldDir, 'index.js'), oldSource)
writeFileSync(join(oldDir, 'package.json'), '{"type":"module"}')
/* The preference store lives next to the module (`<module dir>/.state/prefs.json`).
 * The baseline copy sits in a scratch directory, so without this it would answer
 * `{}` while the current module answers from the developer's real store — a
 * guaranteed mismatch that says nothing about the code. Give both the same bytes. */
try {
  mkdirSync(join(oldDir, '.state'), { recursive: true })
  cpSync(join(root, '.state', 'prefs.json'), join(oldDir, '.state', 'prefs.json'))
} catch { /* no store yet on either side: both answer {} */ }

const failures = []
let okCount = 0
const check = (label, ok, detail) => {
  if (ok) { okCount++; console.log(`  ok   ${label}`) }
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

/* ---- fixture: one repository covering every state the ops care about ----- */
function buildFixture(dir) {
  const run = (args) => execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args,
  ], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  mkdirSync(dir, { recursive: true })
  run(['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2\nline3\n')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'b.js'), 'x\n')
  run(['add', '-A'])
  run(['commit', '-qm', 'first commit'])
  writeFileSync(join(dir, 'a.txt'), 'line1 changed\nline2\nline3\n')
  run(['commit', '-qam', 'second commit'])
  run(['tag', 'v1'])
  run(['checkout', '-qb', 'feature'])
  writeFileSync(join(dir, 'c.txt'), 'r\n')
  run(['add', 'c.txt'])
  run(['commit', '-qm', 'feature commit'])
  run(['checkout', '-q', 'main'])
  writeFileSync(join(dir, 'c.txt'), 'c on main\n')
  run(['add', 'c.txt'])
  run(['commit', '-qm', 'main picks up c'])
  /* A rename plus an MM state: the two shapes the porcelain/numstat parsers
   * treat specially, so a parsing regression cannot hide behind a clean tree. */
  run(['mv', 'c.txt', 'renamed.txt'])
  writeFileSync(join(dir, 'renamed.txt'), 'mm\n')
  run(['add', 'renamed.txt'])
  writeFileSync(join(dir, 'renamed.txt'), 'mm\nagain\n')
  writeFileSync(join(dir, 'sub', 'b.js'), 'x\nstaged\n')
  run(['add', 'sub/b.js'])
  writeFileSync(join(dir, 'u.txt'), 'untracked\n')
}

/* Two byte-identical copies: same objects, same shas, same dirty tree. Only the
 * directory differs, which is the one thing the responses must not depend on. */
const FIXTURE = join(work, 'fixture')
buildFixture(FIXTURE)
const OLD_REPO = join(work, 'old').replace(/\\/g, '/')
const NEW_REPO = join(work, 'new').replace(/\\/g, '/')
cpSync(FIXTURE, OLD_REPO, { recursive: true })
cpSync(FIXTURE, NEW_REPO, { recursive: true })

/* ---- fake host WITHOUT a subprocess service ----------------------------- */
function makeHost() {
  const disposers = []
  const host = {
    get: () => undefined,
    effect(execute) { const d = execute(); disposers.push(d); return d },
    webServer: {
      register(route) { host._handler = route.handler; return () => { host._handler = null } },
    },
    unload() { for (const d of disposers.splice(0).reverse()) d() },
  }
  return host
}

function callApi(handler, query, method = 'GET') {
  return new Promise((resolve) => {
    const settle = (status, body) => {
      let json = null
      try { json = JSON.parse(body) } catch { json = null }
      resolve({ status, json })
    }
    const res = {
      writeHead(code) { this._status = code },
      end(chunk) { settle(this._status ?? 200, String(chunk ?? '')) },
    }
    const req = { method, url: '/git-graph/api?' + query, headers: {} }
    Promise.resolve(handler(req, res)).catch((e) => settle(500, JSON.stringify({ crash: String(e && e.message) })))
  })
}

/* ---- canonical form ------------------------------------------------------
 * Sorted keys (field order is not part of the contract), the fixture path
 * collapsed (the two copies live in different directories), and two classes of
 * value that differ for reasons outside the code being compared:
 *   - 40-hex object ids: the write sequence commits, and a commit made a second
 *     later has a different sha in each copy
 *   - ISO timestamps (same reason: they are part of the commit object) */
function canon(value, repoPath) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
      return out
    }
    if (typeof v === 'string') {
      return v.split(repoPath).join('<REPO>')
        .replace(/\b[0-9a-f]{40}\b/g, '<H>')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g, '<DATE>')
    }
    return v
  }
  return JSON.stringify(walk(value))
}

const oldMod = await import(pathToFileURL(join(oldDir, 'index.js')).href + '?t=' + Date.now())
const newMod = await import(pathToFileURL(join(root, 'index.js')).href + '?t=' + Date.now())
const oldHost = makeHost()
const newHost = makeHost()
oldMod.apply(oldHost, { repo: OLD_REPO })
newMod.apply(newHost, { repo: NEW_REPO })

const enc = (s) => encodeURIComponent(s)

/* ---- 1) read ops -------------------------------------------------------- */
const readOps = [
  ['graph', 'op=graph&limit=50'],
  ['graph 翻页', 'op=graph&limit=3&skip=1'],
  ['graph date 序（平铺视图）', 'op=graph&order=date&limit=50'],
  ['count', 'op=count'],
  ['branches', 'op=branches'],
  ['head（5s 轮询）', 'op=head'],
  ['workstatus', 'op=workstatus'],
  ['workfile 未暂存', 'op=workfile&file=a.txt&staged=0'],
  ['workfile 重命名（带 old）', 'op=workfile&file=renamed.txt&staged=1&old=c.txt'],
  ['workfile 未跟踪', 'op=workfile&file=u.txt&staged=untracked'],
  ['workfile 目录', 'op=workfile&file=sub&staged=untracked'],
  ['workfile 越界路径', 'op=workfile&file=../../../etc/passwd&staged=untracked'],
  ['filelog', 'op=filelog&file=a.txt'],
  ['remoteinfo', 'op=remoteinfo'],
  ['suggestmsg', 'op=suggestmsg'],
  ['prefs', 'op=prefs'],
  ['listdir', 'op=listdir&path=<REPO>'],
  ['未知 op', 'op=doesnotexist'],
  ['无 repo 参数', 'op=graph'],
  ['写 op 用 GET（必须 405）', 'op=gitop&action=stage&file=a.txt'],
  ['不存在的目录', `op=listdir&path=${enc('Z:/nope-not-here')}`],
]

for (const [label, query] of readOps) {
  const oldQ = query.split('<REPO>').join(enc(OLD_REPO))
  const newQ = query.split('<REPO>').join(enc(NEW_REPO))
  const a = await callApi(oldHost._handler, oldQ)
  const b = await callApi(newHost._handler, newQ)
  check(`${label}: 状态码一致 (${a.status})`, a.status === b.status, `old=${a.status} new=${b.status}`)
  const ca = canon(a.json, OLD_REPO)
  const cb = canon(b.json, NEW_REPO)
  check(`${label}: JSON 逐字段一致`, ca === cb, ca === cb ? '' : `\n    old=${ca.slice(0, 400)}\n    new=${cb.slice(0, 400)}`)
}

/* ---- 2) repos: only the documented additions may differ ----------------- */
{
  const a = await callApi(oldHost._handler, `op=repos&ws=${enc(OLD_REPO)}`)
  const b = await callApi(newHost._handler, `op=repos&ws=${enc(NEW_REPO)}`)
  check('repos: 状态码一致 (200)', a.status === b.status)
  const strip = (o) => { const c = { ...o }; delete c.wsProbe; delete c.wsRemote; return c }
  check('repos: 除 wsRemote/wsProbe 外逐字段一致（repos/current/ws/wsRoot/wsIsGit）',
    canon(strip(a.json), OLD_REPO) === canon(strip(b.json), NEW_REPO),
    `\n    old=${canon(a.json, OLD_REPO)}\n    new=${canon(b.json, NEW_REPO)}`)
  const lost = Object.keys(a.json).filter((k) => !(k in b.json))
  check('repos: 没有丢字段', lost.length === 0, JSON.stringify(lost))
  if (base === 'v0.26.2') {
    /* Baseline predates the remote work, so this is the one place a NEW field is
     * allowed. Asserted rather than merely tolerated, and asserted as an exact
     * set — a third new field means the response shape changed silently. */
    const added = Object.keys(b.json).filter((k) => !(k in a.json)).sort()
    check('repos: 新增字段恰好是 wsProbe / wsRemote', JSON.stringify(added) === JSON.stringify(['wsProbe', 'wsRemote']), JSON.stringify(added))
    check('repos: 本地工作区 wsRemote=false', b.json.wsRemote === false, String(b.json.wsRemote))
    check('repos: 本地工作区 wsProbe=null（不探测、不起进程）', b.json.wsProbe === null, JSON.stringify(b.json.wsProbe))
  }
}

/* ---- 3) commit detail ops ------------------------------------------------- */
const graphOld = await callApi(oldHost._handler, 'op=graph&limit=5')
const hash = graphOld.json?.commits?.[0]?.hash
if (hash) {
  for (const q of [`op=show&hash=${hash}`, `op=diff&hash=${hash}`,
    `op=filediff&hash=${hash}&file=a.txt`, `op=filediff&hash=${hash}&file=nope.txt`]) {
    const a = await callApi(oldHost._handler, q)
    const b = await callApi(newHost._handler, q)
    const name = q.split('&')[0].slice(3)
    check(`${name}: 状态码一致 (${a.status})`, a.status === b.status)
    check(`${name}: JSON 逐字段一致`, canon(a.json, OLD_REPO) === canon(b.json, NEW_REPO),
      `\n    old=${canon(a.json, OLD_REPO).slice(0, 400)}\n    new=${canon(b.json, NEW_REPO).slice(0, 400)}`)
  }
} else {
  check('graph 返回了提交（后续 show/diff 的前置）', false, JSON.stringify(graphOld.json).slice(0, 200))
}

/* ---- 4) write ops: same sequence on both copies -------------------------
 * Error paths are included on purpose: a divergence in an error string or status
 * code is just as much a local regression as one in a success body. */
const writeSeq = [
  ['stage', 'op=gitop&action=stage&file=a.txt'],
  ['stage 缺 file', 'op=gitop&action=stage'],
  ['unstage', 'op=gitop&action=unstage&file=a.txt'],
  ['stage-all', 'op=gitop&action=stage-all'],
  ['unstage-all', 'op=gitop&action=unstage-all'],
  ['tag', 'op=gitop&action=tag&name=t-compare&hash=' + hash],
  ['tag 缺 name', 'op=gitop&action=tag&hash=' + hash],
  ['tag-rename', 'op=gitop&action=tag-rename&name=t-compare&newname=t-renamed&hash=' + hash],
  ['tag-delete', 'op=gitop&action=tag-delete&name=t-renamed'],
  ['branch', 'op=gitop&action=branch&name=b-compare&hash=' + hash],
  ['checkout', 'op=gitop&action=checkout&name=b-compare'],
  ['checkout 回 main', 'op=gitop&action=checkout&name=main'],
  ['delete-branch', 'op=gitop&action=delete-branch&name=b-compare'],
  ['discard 未跟踪（git 拒绝，两边一致）', 'op=gitop&action=discard&file=u.txt'],
  ['ignore（本地仍走 appendFileSync）', 'op=gitop&action=ignore&file=ignored.txt'],
  ['commit', 'op=gitop&action=commit&message=compare+commit&all=1'],
  ['commit 缺 message', 'op=gitop&action=commit'],
  ['未知 action', 'op=gitop&action=bogus'],
  ['越界路径', 'op=gitop&action=stage&file=../../../etc/passwd'],
]

for (const [label, query] of writeSeq) {
  const a = await callApi(oldHost._handler, query, 'POST')
  const b = await callApi(newHost._handler, query, 'POST')
  check(`gitop ${label}: 状态码一致 (${a.status})`, a.status === b.status, `old=${a.status} new=${b.status}`)
  check(`gitop ${label}: JSON 一致`, canon(a.json, OLD_REPO) === canon(b.json, NEW_REPO),
    `\n    old=${canon(a.json, OLD_REPO).slice(0, 300)}\n    new=${canon(b.json, NEW_REPO).slice(0, 300)}`)
}

/* ---- 5) state after the write sequence ---------------------------------- */
for (const [label, q] of [['workstatus', 'op=workstatus'], ['graph', 'op=graph&limit=20'],
  ['branches', 'op=branches'], ['head', 'op=head']]) {
  const a = await callApi(oldHost._handler, q)
  const b = await callApi(newHost._handler, q)
  check(`写操作序列后 ${label} 一致`, canon(a.json, OLD_REPO) === canon(b.json, NEW_REPO),
    `\n    old=${canon(a.json, OLD_REPO).slice(0, 400)}\n    new=${canon(b.json, NEW_REPO).slice(0, 400)}`)
}

/* ---- 6) the repositories themselves must agree -------------------------- */
{
  const at = (p, args) => execFileSync('git', args, { cwd: p, encoding: 'utf8' })
  const hist = (p) => at(p, ['log', '--all', '--format=%s'])
  check('两份副本最终提交主题序列一致', hist(OLD_REPO) === hist(NEW_REPO), `\n    old=${hist(OLD_REPO)}\n    new=${hist(NEW_REPO)}`)
  const refs = (p) => at(p, ['for-each-ref', '--format=%(refname)']).split('\n').sort().join('\n')
  check('两份副本最终 ref 名一致', refs(OLD_REPO) === refs(NEW_REPO), `\n    old=${refs(OLD_REPO)}\n    new=${refs(NEW_REPO)}`)
  const st = (p) => at(p, ['status', '--porcelain'])
  check('两份副本最终工作区状态一致', st(OLD_REPO) === st(NEW_REPO), `\n    old=${st(OLD_REPO)}\n    new=${st(NEW_REPO)}`)
  const gi = (p) => { try { return readFileSync(join(p, '.gitignore'), 'utf8') } catch { return '<none>' } }
  check('.gitignore 一致（ignore 的落盘结果）', gi(OLD_REPO) === gi(NEW_REPO), `old=${JSON.stringify(gi(OLD_REPO))} new=${JSON.stringify(gi(NEW_REPO))}`)
}

/* ---- 7) the remote surface must be inert and still fail closed ---------- */
{
  const SSHWS = 'ssh://qiyk/home/qiyk/mygit'
  /* `repos` registers the remote workspace root. Without it the ssh:// requests
   * below would die at `repo-not-allowed` and prove nothing about the refusals. */
  const r = await callApi(newHost._handler, `op=repos&ws=${enc(SSHWS)}`)
  check('无桥时 wsRemote = true', r.json?.wsRemote === true, String(r.json?.wsRemote))
  check('无桥时 wsProbe.reason = bridge-missing', r.json?.wsProbe?.reason === 'bridge-missing', JSON.stringify(r.json?.wsProbe))
  check('无桥时 wsIsGit = false（不谎报仓库存在）', r.json?.wsIsGit === false, String(r.json?.wsIsGit))
  check('无桥时 repos 不含 ssh:// 条目', !(r.json?.repos || []).some((x) => String(x).startsWith('ssh://')), JSON.stringify(r.json?.repos))

  for (const [label, q] of [
    ['reveal', `op=reveal&repo=${enc(SSHWS)}`],
    ['listdir', `op=listdir&path=${enc(SSHWS)}`],
    ['addrepo', `op=addrepo&path=${enc(SSHWS)}`],
    ['findrepos', `op=findrepos&ws=${enc(SSHWS)}`],
    ['graph', `op=graph&repo=${enc(SSHWS)}`],
    ['gitop', `op=gitop&action=stage&file=a.txt&repo=${enc(SSHWS)}`],
  ]) {
    const res = await callApi(newHost._handler, q, q.includes('op=gitop') ? 'POST' : 'GET')
    check(`无桥时 ${label}: 明确失败而不是崩溃`, res.status >= 400 && res.json?.ok === false,
      `status=${res.status} ${JSON.stringify(res.json).slice(0, 220)}`)
  }

  /* The whitelist is per workspace, not "any ssh:// path". A regression to
   * `if (isRemotePath(repo)) return true` turns this feature into a remote git
   * execution primitive, and these two are what catch it. */
  for (const [label, remote] of [
    ['工作区之外的 ssh:// 路径', 'ssh://qiyk/etc'],
    ['同一 alias 下的兄弟目录', 'ssh://qiyk/home/qiyk/other'],
  ]) {
    const res = await callApi(newHost._handler, `op=graph&repo=${enc(remote)}`)
    check(`无桥时 ${label}: 403 repo-not-allowed（白名单不放大）`,
      res.status === 403 && res.json?.error === 'repo-not-allowed', `status=${res.status} ${JSON.stringify(res.json).slice(0, 160)}`)
  }
}

oldHost.unload()
newHost.unload()
rmSync(work, { recursive: true, force: true })

console.log('')
if (failures.length) {
  console.log(`[degrade] FAIL：${failures.length} 条与基线不一致`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log(`[degrade] 通过：${okCount} 条断言，无 ssh-workspace 时本地行为与 ${base} 一致。`)
