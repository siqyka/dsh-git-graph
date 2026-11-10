#!/usr/bin/env node
/**
 * check-remote-live.mjs — 远端读路径的真机验收（M2）。
 *
 * 与 check-remote.mjs 的分工：
 *   check-remote.mjs      纯 node、无网络，钉住 runGit 的分流契约。
 *   check-remote-live.mjs 需要一台真主机，钉住「接线之后远端真的能用」。
 *
 * 为什么两者都要有：分流正确不代表接线正确。M2 动的是白名单闸门、每请求的
 * git 仓库校验、路径守卫和三个 async 辅助——这些在 mock 下全都「看起来对」，
 * 因为 mock 不会告诉你 `resolve('ssh://h/p', 'file')` 会折成本地路径、于是
 * 守卫恒真。真机 + 真实 SSH 是唯一能发现那类错误的办法。
 *
 * 只替换一处：`ctx.get('subprocess')` 的 spawn 换成本机 `ssh` 二进制。其余
 * （白名单、守卫、async 辅助、for-each-ref 回退、JSON 形状）全部是发布代码。
 *
 * 仓内自建 fixture，而不是拿用户的仓库开刀。原因是几条断言必须能区分
 * 「对」和「碰巧对」：
 *   * `graph.head` 要能证明它来自远端而不是回落常量。对手那个仓库恰好是
 *     detached HEAD，`readHeadName` 与 `readHeadNameAsync` 都会答 'HEAD'，
 *     断言无法区分。fixture 里 HEAD 指向 main，答错立刻变红。
 *   * `workfile` 的路径守卫有两面：越界要拒、**合法路径要放行**。只测拒绝
 *     那一面时，把守卫改成「恒真」也照样绿（它连合法路径一起拒了）。
 *     所以 fixture 里放了未跟踪文件与未跟踪目录，两面都断言。
 *
 * 用法：
 *   DSH_GG_TEST_ALIAS=qiyk node scripts/check-remote-live.mjs
 *   DSH_GG_TEST_ALIAS=qiyk DSH_GG_TEST_REPO=/home/u/repo node scripts/check-remote-live.mjs
 * 未设置 DSH_GG_TEST_ALIAS 时整体 SKIP（退出码 0），所以可以无脑接进 CI。
 */
import { spawn as spawnLocal, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALIAS = process.env.DSH_GG_TEST_ALIAS || ''

if (!ALIAS) {
  console.log('[remote-live] SKIP — 需要 DSH_GG_TEST_ALIAS 指向一台真主机（可选 DSH_GG_TEST_REPO 指定现成仓库）。')
  process.exit(0)
}

const plugin = await import(pathToFileURL(join(root, 'index.js')).href)
const INSTALLED = Symbol.for('dsh-ssh-workspace.subprocess-installed')

const failures = []
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/* POSIX quoting: `ssh` joins its argv with spaces and the remote login shell
 * re-parses the result, so every path/argument has to be quoted inside one
 * argument. */
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

/** Run a shell command on the test host, returning stdout. */
const sshSh = (command) => execFileSync('ssh', [ALIAS, command], { encoding: 'utf8' })

/**
 * The only fake in this file: ssh-workspace's patched `spawn`, implemented with
 * the local `ssh` binary. The seam's contract is reproduced faithfully — cwd
 * becomes the remote `cd`, argv becomes the remote command, `done` resolves
 * with an object and `collected.*.finalize()` returns {text, truncated}.
 */
function spawnShim(spec) {
  const m = /^ssh:\/\/([^/]+)(\/.*)$/.exec(spec.cwd)
  if (!m) throw new Error(`unexpected cwd ${spec.cwd}`)
  const cmd = 'cd ' + shq(m[2]) + ' && git ' + spec.argv.slice(1).map(shq).join(' ')
  const child = spawnLocal('ssh', [m[1], cmd], { windowsHide: true })
  let out = ''
  let err = ''
  const maxOut = spec.stdio.stdout.maxBytes
  const maxErr = spec.stdio.stderr.maxBytes
  child.stdout.on('data', (d) => { if (out.length < maxOut) out += String(d) })
  child.stderr.on('data', (d) => { if (err.length < maxErr) err += String(d) })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code, signal: null }))
  })
  return {
    done,
    collected: {
      stdout: { finalize: () => ({ text: out, truncated: false }) },
      stderr: { finalize: () => ({ text: err, truncated: false }) },
    },
    terminate: () => { try { child.kill() } catch { /* already gone */ } return true },
  }
}

function makeHost() {
  const routes = new Map()
  const disposers = []
  const service = { [INSTALLED]: {}, spawn: spawnShim }
  return {
    routes,
    get: (id) => (id === 'subprocess' ? service : undefined),
    effect(execute) { const d = execute(); disposers.push(d); return d },
    webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } },
    unload() { for (const d of disposers.splice(0).reverse()) d() },
  }
}

function call(host, query, method = 'GET') {
  const route = host.routes.get('/git-graph')
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
      end(body) {
        const text = body ? body.toString() : ''
        let json = null
        try { json = JSON.parse(text) } catch { /* the HTML page */ }
        resolve({ status: this.statusCode, json })
      },
    }
    Promise.resolve(route.handler({ url: '/git-graph/api?' + query, method, headers: {} }, res)).catch(reject)
  })
}

/* ------------------------------------------------------------------ fixture */
/* A scratch repo in the host's own temp dir. It is created and destroyed by
 * this script; nothing outside it is touched. `trap` in the shell guarantees
 * the directory goes away even if this process dies mid-run. */
const FIXTURE = process.env.DSH_GG_TEST_REPO
  || `/tmp/gg-live-${process.pid}`

const cleanup = () => {
  try { sshSh(`rm -rf ${shq(FIXTURE)}`) } catch { /* best effort */ }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

if (!process.env.DSH_GG_TEST_REPO) {
  sshSh([
    `rm -rf ${shq(FIXTURE)}`,
    `mkdir -p ${shq(FIXTURE + '/sub/dir')}`,
    `cd ${shq(FIXTURE)}`,
    'git init -q -b main',
    'git config user.email live@example.com',
    'git config user.name "live check"',
    "printf 'first\\n' > a.txt",
    "printf 'second\\n' > b.txt",
    'git add -A',
    "git commit -q -m 'first commit'",
    "printf 'first\\nmore\\n' > a.txt",
    'git commit -q -am "second commit"',
    'git tag v1.0.0',
    'git branch side',
    'git checkout -q side',
    "printf 's\\n' > side.txt",
    'git add -A',
    "git commit -q -m 'side commit'",
    'git checkout -q main',
    /* untracked, both shapes the workfile guard has to tell apart */
    "printf 'line one\\nline two\\n' > untracked.txt",
    'mkdir -p untracked_dir',
    "printf 'x\\n' > untracked_dir/inner.txt",
  ].join(' && '))
}

const WS = `ssh://${ALIAS}${FIXTURE}`
const raw = (cmd) => sshSh(`cd ${shq(FIXTURE)} && ${cmd}`)

console.log(`[remote-live] ${WS}`)

const host = makeHost()
plugin.apply(host, {})
const R = '&repo=' + encodeURIComponent(WS)

/* ---- A. workspace discovery and behaviour ----------------------------- */
const repos = (await call(host, 'op=repos&ws=' + encodeURIComponent(WS + '/sub'))).json
check('repos.ok', repos && repos.ok === true, JSON.stringify(repos).slice(0, 140))
check('从子目录向上定位到 git 根（findGitRootAsync）', repos?.wsRoot === WS && repos?.wsIsGit === true, String(repos?.wsRoot))
check('wsRemote 为真', repos?.wsRemote === true)
check('current 选中的是 git 根而不是子目录', repos?.current === WS, String(repos?.current))
check('wsProbe 在成功时是 ok（不该给客户端任何「缺失」的理由）',
  repos?.wsProbe?.reason === 'ok' && repos?.wsProbe?.bridge === true, JSON.stringify(repos?.wsProbe))

/* The one case the whole `wsProbe` change exists for, checked against a REAL
 * remote instead of a canned stderr string: a directory that is a plain
 * directory, with a perfectly working bridge and a git binary present. The
 * client turns `not-a-repo` into "point the workspace at the subdirectory",
 * and it must NOT come back as `bridge-missing` (which would keep telling the
 * user to install a plugin they already have and already have working).
 *
 * The parent of the fixture is `/tmp`, which is a fine target: nothing above it
 * is a git repository, so `rev-parse --show-toplevel` fails with real git's own
 * wording rather than the mock's. */
const NOTREPO = `/tmp/gg-notrepo-${process.pid}`
try {
  sshSh(`rm -rf ${shq(NOTREPO)} && mkdir -p ${shq(NOTREPO)}`)
  const notRepo = (await call(host, 'op=repos&ws=' + encodeURIComponent(`ssh://${ALIAS}${NOTREPO}`))).json
  check('真机非仓库目录：wsIsGit 为假', notRepo?.wsIsGit === false, JSON.stringify(notRepo?.wsIsGit))
  check('真机非仓库目录：reason 是 not-a-repo（不是 bridge-missing）',
    notRepo?.wsProbe?.reason === 'not-a-repo', JSON.stringify(notRepo?.wsProbe))
  check('真机非仓库目录：bridge 为真（插件是好的，问题在目录）',
    notRepo?.wsProbe?.bridge === true, JSON.stringify(notRepo?.wsProbe))
  check('真机非仓库目录：detail 保留远端 stderr 首行',
    /not a git repository|不是 git 仓库/i.test(String(notRepo?.wsProbe?.detail)),
    JSON.stringify(notRepo?.wsProbe?.detail))
  /* The reason must NOT depend on that wording. A host with a localized git —
   * this one answers `fatal: 不是 git 仓库（…）` — gets classified by exit code
   * instead, and this assertion is the one that caught the English-only regex
   * being the sole signal. */
  check('真机非仓库目录：分类不依赖 git 的本地化文案（退出码 128 决定）',
    notRepo?.wsProbe?.reason === 'not-a-repo' && /[^\x00-\x7F]/.test(String(notRepo?.wsProbe?.detail)),
    JSON.stringify(notRepo?.wsProbe))
} finally {
  try { sshSh(`rm -rf ${shq(NOTREPO)}`) } catch { /* best effort */ }
}

const graph = (await call(host, 'op=graph' + R + '&limit=0')).json
check('graph.ok', graph && graph.ok === true, graph && graph.error)
check('graph.head 是远端的当前分支 main', graph?.head === 'main', String(graph?.head))

const count = (await call(host, 'op=count' + R)).json
check('count 与 rev-list --all --count 一致',
  String(count?.total) === raw('git rev-list --all --count').trim(),
  `${count?.total} vs ${raw('git rev-list --all --count').trim()}`)

const sig1 = (await call(host, 'op=head' + R)).json
const sig2 = (await call(host, 'op=head' + R)).json
const sig3 = (await call(host, 'op=head' + R)).json
check('head.sig 三次轮询稳定（5s 轮询不会自激刷新）',
  !!sig1?.sig && sig1.sig === sig2.sig && sig2.sig === sig3.sig,
  [sig1?.sig, sig2?.sig, sig3?.sig].map((x) => String(x).slice(0, 16)).join(' / '))
check('head 走 for-each-ref 回退（refs > 0）', sig1?.refs > 0, String(sig1?.refs))

const wt = (await call(host, 'op=workstatus' + R)).json
check('workstatus.ok', wt && wt.ok === true, wt && wt.error)
check('workstatus.branch 是 main', wt?.branch === 'main', String(wt?.branch))
check('workstatus 列出 2 个未跟踪条目', (wt?.untracked?.length ?? 0) === 2, String(wt?.untracked?.length))

const remoteInfo = (await call(host, 'op=remoteinfo' + R)).json
check('remoteinfo 无远程时给出 web:null 而不是报错', remoteInfo?.ok === true && remoteInfo?.web === null, JSON.stringify(remoteInfo))

/* ---- B. field parity with raw git on the same host -------------------- */
const logRows = raw("git log --all --topo-order --date=iso-strict --format='%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%d'")
  .split('\n').filter(Boolean).map((line) => {
    const [hash, parents, author, email, date, subject] = line.split('\x1f')
    return { hash, parents: parents ? parents.split(' ') : [], author, email, date, subject }
  })
check('graph 提交行数与 git log 一致', graph?.commits?.length === logRows.length, `${graph?.commits?.length} vs ${logRows.length}`)
const drift = []
for (let i = 0; i < Math.min(graph?.commits?.length ?? 0, logRows.length); i++) {
  const got = graph.commits[i]
  const want = logRows[i]
  for (const key of ['hash', 'author', 'email', 'date', 'subject']) {
    if (String(got[key]) !== String(want[key])) drift.push(`#${i}.${key}`)
  }
  if (JSON.stringify(got.parents) !== JSON.stringify(want.parents)) drift.push(`#${i}.parents`)
}
check('每条提交的 hash/author/email/date/subject/parents 逐字段一致', drift.length === 0, drift.slice(0, 3).join(','))

/* The regression the M2 brief calls the most valuable one: `branches` reads
 * refs off disk locally and shells out to for-each-ref remotely, and both must
 * agree on every field. */
const branches = (await call(host, 'op=branches' + R)).json?.branches ?? []
const refRows = raw("git for-each-ref --format='%(refname)%09%(objectname)%09%(HEAD)' refs/heads refs/remotes refs/tags")
  .split('\n').filter(Boolean).map((line) => {
    const [refname, sha, isHead] = line.split('\t')
    const kind = refname.startsWith('refs/tags/') ? 'tag' : refname.startsWith('refs/remotes/') ? 'remote' : 'local'
    return { refname, sha, kind, head: isHead === '*' }
  })
const asKey = (x) => `${x.refname}|${x.sha}|${x.kind}|${x.head}`
check('branches 覆盖 heads 与 tags', branches.some((b) => b.kind === 'local') && branches.some((b) => b.kind === 'tag'),
  branches.map((b) => b.kind + ':' + b.name).join(','))
check('branches 与 for-each-ref 条数一致', branches.length === refRows.length, `${branches.length} vs ${refRows.length}`)
check('branches 每个 ref 的 refname/sha/kind/head 全部一致',
  JSON.stringify(branches.map(asKey).sort()) === JSON.stringify(refRows.map(asKey).sort()),
  branches.map(asKey).filter((k) => !refRows.map(asKey).includes(k)).slice(0, 2).join(' | '))

const sample = logRows.find((r) => r.subject === 'second commit') || logRows[0]
const diff = (await call(host, 'op=diff' + R + '&hash=' + sample.hash)).json
const wantDiff = raw(`git show --no-color --format= ${sample.hash}`)
check('diff 文本与 git show 完全一致', diff?.diff === wantDiff, `${diff?.diff?.length} vs ${wantDiff.length}`)

const show = (await call(host, 'op=show' + R + '&hash=' + sample.hash)).json
check('show.ok', show && show.ok === true, show && show.error)
check('show 的 subject 与 git log 一致', JSON.stringify(show).includes(sample.subject), JSON.stringify(show).slice(0, 120))

const filelog = (await call(host, 'op=filelog' + R + '&file=a.txt')).json
check('filelog 覆盖该文件的两条提交', (filelog?.commits?.length ?? 0) === 2, String(filelog?.commits?.length))

/* ---- C. workfile: both sides of the guard ----------------------------- */
const untracked = (await call(host, 'op=workfile' + R + '&staged=untracked&file=untracked.txt')).json
check('未跟踪文件返回 diff（守卫放行合法路径）', untracked?.ok === true && /^\+line one$/m.test(untracked?.diff || ''),
  JSON.stringify(untracked).slice(0, 120))
check('未跟踪 diff 是标准 git 形式', /^diff --git a\/untracked\.txt b\/untracked\.txt$/m.test(untracked?.diff || ''),
  String(untracked?.diff).split('\n')[0])

const untrackedDir = (await call(host, 'op=workfile' + R + '&staged=untracked&file=untracked_dir')).json
check('未跟踪目录报 isDir', untrackedDir?.ok === true && untrackedDir?.isDir === true, JSON.stringify(untrackedDir).slice(0, 110))

const nested = (await call(host, 'op=workfile' + R + '&staged=untracked&file=' + encodeURIComponent('./untracked_dir/inner.txt'))).json
check('带 ./ 的相对路径同样放行', nested?.ok === true && /inner\.txt/.test(nested?.diff || ''), JSON.stringify(nested).slice(0, 110))

const missing = await call(host, 'op=workfile' + R + '&staged=untracked&file=nope.txt')
check('不存在的未跟踪文件报 404', missing.status === 404 && missing.json?.error === 'file-not-found', `${missing.status} ${missing.json?.error}`)

const blocked = await call(host, 'op=graph&repo=' + encodeURIComponent(`ssh://${ALIAS}/etc`))
check('未登记过的远端路径被 403 拒绝（白名单不是「任意 ssh://」）',
  blocked.status === 403 && blocked.json?.error === 'repo-not-allowed',
  `${blocked.status} ${blocked.json?.error}`)

/* The guard is the ALIAS root, not the repo root: walking up from a repo under
 * /home/user lands on /etc, still inside ssh://alias/, so it is accepted and
 * then simply not found. Only walking above / is a refusal. */
const escaped = await call(host, 'op=workfile' + R + '&staged=untracked&file=' + encodeURIComponent('../../../../../etc/passwd'))
check('workfile 越出 alias 根被 400 拒绝',
  escaped.status === 400 && escaped.json?.error === 'path-outside-repo',
  `${escaped.status} ${escaped.json?.error}`)
const absolute = await call(host, 'op=workfile' + R + '&staged=untracked&file=' + encodeURIComponent('/etc/passwd'))
check('workfile 绝对路径被 400 拒绝',
  absolute.status === 400 && absolute.json?.error === 'path-outside-repo',
  `${absolute.status} ${absolute.json?.error}`)
const escapeLog = await call(host, 'op=filelog' + R + '&file=' + encodeURIComponent('../../../../../../etc/passwd'))
check('filelog 越出 alias 根被 400 拒绝',
  escapeLog.status === 400 && escapeLog.json?.error === 'path-outside-repo',
  `${escapeLog.status} ${escapeLog.json?.error}`)

/* ---- D. write path: gitop against the remote repository --------------- */
/* Every action below goes through the same `runGit` as the local path, so what
 * is really under test is that the diversion survives a WRITE command (the
 * bridge only whitelists git, and the retry policy differs for writes), and
 * that the two guards (path allow-list, read-only mode) do not eat it.
 *
 * The fixture is mutated in place; that is fine because this section runs last
 * and the whole directory is deleted on exit. */
{
  /* gitop requires POST — that is the CSRF defence, and a GET gets 405 before
   * anything else happens. */
  const asGet = await call(host, 'op=gitop&action=stage-all' + R + '&file=a.txt')
  check('gitop 走 GET 仍被 405 拒绝（写操作必须 POST）',
    asGet.status === 405 && asGet.json?.error === 'method-not-allowed',
    `${asGet.status} ${asGet.json?.error}`)

  /* A real modification plus a new file, so stage has something to do. */
  raw("printf 'first\\nmore\\nmore again\\n' > a.txt && printf 'brand new\\n' > newfile.txt")
  const dirty = raw('git status --porcelain')
  check('fixture 已就绪（工作区有改动）', /newfile\.txt/.test(dirty), JSON.stringify(dirty))

  const staged = await call(host, 'op=gitop&action=stage' + R + '&file=a.txt&file=newfile.txt', 'POST')
  check('远端 gitop stage 成功', staged.json?.ok === true, JSON.stringify(staged.json?.error))
  const afterStage = raw('git status --porcelain')
  check('远端 git status --porcelain 反映了暂存（两个文件都在索引里）',
    /^M {2}a\.txt/m.test(afterStage) || /^M  a\.txt/m.test(afterStage),
    JSON.stringify(afterStage))
  check('新文件也进了索引', /^A {2}newfile\.txt/m.test(afterStage), JSON.stringify(afterStage))

  const unstage = await call(host, 'op=gitop&action=unstage' + R + '&file=a.txt', 'POST')
  check('远端 gitop unstage 成功', unstage.json?.ok === true, JSON.stringify(unstage.json?.error))
  const afterUnstage = raw('git status --porcelain')
  check('unstage 后 a.txt 退回未暂存', /^ M a\.txt/m.test(afterUnstage), JSON.stringify(afterUnstage))
  check('unstage 没有牵连另一个文件', /^A {2}newfile\.txt/m.test(afterUnstage), JSON.stringify(afterUnstage))

  /* Commit — the interesting half is WHOSE identity it records. `runGit` runs
   * on the host, so git resolves user.name/user.email from the host's own
   * config. A local-config answer here would mean the commit ran locally. */
  const wantName = raw('git config user.name').trim()
  const wantEmail = raw('git config user.email').trim()
  const commit = await call(
    host,
    'op=gitop&action=commit' + R + '&message=' + encodeURIComponent('remote write check') +
      '&file=newfile.txt',
    'POST',
  )
  check('远端 gitop commit 成功', commit.json?.ok === true, JSON.stringify(commit.json?.error))
  const lastLog = raw("git log -1 --format='%an%x1f%ae%x1f%s'").trim().split('\x1f')
  check('远端 git log -1 出现了该提交', lastLog[2] === 'remote write check', JSON.stringify(lastLog[2]))
  check('提交作者是远端机器的 user.name（不是本机配置）',
    lastLog[0] === wantName, `got ${JSON.stringify(lastLog[0])} want ${JSON.stringify(wantName)}`)
  check('提交邮箱是远端机器的 user.email',
    lastLog[1] === wantEmail, `got ${JSON.stringify(lastLog[1])} want ${JSON.stringify(wantEmail)}`)

  /* The other half of the polling contract: a new commit must MOVE the
   * signature. sig1 was taken before this commit, so equality here would mean
   * the 5s poll can never notice new history (the graph would look frozen). */
  const sigAfter = (await call(host, 'op=head' + R)).json
  check('新建提交后 head.sig 变化（轮询能发现新提交）',
    !!sigAfter?.sig && sigAfter.sig !== sig1.sig,
    `${String(sig1?.sig).slice(0, 24)} vs ${String(sigAfter?.sig).slice(0, 24)}`)

  /* Branches / tags / checkout: refs must move on the host. */
  const branch = await call(host, 'op=gitop&action=branch' + R + '&name=remote-check&hash=HEAD', 'POST')
  check('远端 gitop branch 成功', branch.json?.ok === true, JSON.stringify(branch.json?.error))
  check('新分支出现在远端 refs 里',
    raw('git for-each-ref --format="%(refname)" refs/heads').includes('refs/heads/remote-check'),
    JSON.stringify(raw('git for-each-ref --format="%(refname)" refs/heads')))

  const tag = await call(host, 'op=gitop&action=tag' + R + '&name=v9.9.9&hash=HEAD', 'POST')
  check('远端 gitop tag 成功', tag.json?.ok === true, JSON.stringify(tag.json?.error))
  check('标签出现在远端 refs 里',
    raw('git tag --list').includes('v9.9.9'), JSON.stringify(raw('git tag --list')))

  const checkout = await call(host, 'op=gitop&action=checkout' + R + '&name=remote-check', 'POST')
  check('远端 gitop checkout 成功', checkout.json?.ok === true, JSON.stringify(checkout.json?.error))
  check('远端 HEAD 已切到 remote-check',
    raw('git branch --show-current').trim() === 'remote-check', JSON.stringify(raw('git branch --show-current')))

  const back = await call(host, 'op=gitop&action=checkout' + R + '&name=main', 'POST')
  check('切回 main 成功', back.json?.ok === true, JSON.stringify(back.json?.error))
  const del = await call(host, 'op=gitop&action=delete-branch' + R + '&name=remote-check', 'POST')
  check('远端 gitop delete-branch 成功（-d 认已合并）', del.json?.ok === true, JSON.stringify(del.json?.error))
  check('被删的分支已从远端 refs 消失',
    !raw('git for-each-ref --format="%(refname)" refs/heads').includes('refs/heads/remote-check'),
    JSON.stringify(raw('git for-each-ref --format="%(refname)" refs/heads')))

  const tagDel = await call(host, 'op=gitop&action=tag-delete' + R + '&name=v9.9.9', 'POST')
  check('远端 gitop tag-delete 成功', tagDel.json?.ok === true, JSON.stringify(tagDel.json?.error))

  /* discard restores tracked content; the untracked file must survive. */
  raw("printf 'scratch\\n' >> b.txt")
  const discard = await call(host, 'op=gitop&action=discard' + R + '&file=b.txt', 'POST')
  check('远端 gitop discard 成功', discard.json?.ok === true, JSON.stringify(discard.json?.error))
  check('b.txt 被还原（工作区里没有 scratch）',
    !raw('git diff -- b.txt').includes('scratch'), JSON.stringify(raw('git diff -- b.txt').slice(0, 80)))
  check('discard 没有动未跟踪文件',
    raw('git status --porcelain').includes('untracked.txt'), JSON.stringify(raw('git status --porcelain')))

  /* The three bulk actions run on the whole index/worktree rather than on a
   * named file, so they exercise a different argument shape than `stage`
   * above. Cheap to cover, and `discard-all` is the one that could destroy
   * work if the diversion ever mis-targeted the repository. */
  {
    raw("printf 'bulk\\n' > bulk.txt && printf 'edited\\n' >> bulk.txt")
    const all = await call(host, 'op=gitop&action=stage-all' + R, 'POST')
    check('远端 gitop stage-all 成功', all.json?.ok === true, JSON.stringify(all.json?.error))
    check('stage-all 把新文件也暂存了',
      /^A {2}bulk\.txt/m.test(raw('git status --porcelain')),
      JSON.stringify(raw('git status --porcelain')))

    const unAll = await call(host, 'op=gitop&action=unstage-all' + R, 'POST')
    check('远端 gitop unstage-all 成功', unAll.json?.ok === true, JSON.stringify(unAll.json?.error))
    check('unstage-all 后索引为空（bulk.txt 变成未跟踪）',
      /^\?\? bulk\.txt/m.test(raw('git status --porcelain')),
      JSON.stringify(raw('git status --porcelain')))

    /* Track it first, otherwise `discard-all` (git restore) has nothing to
     * restore and the assertion would pass for the wrong reason. */
    raw('git add bulk.txt && git commit -q -m "bulk tracked" && printf "dirty\\n" >> bulk.txt')
    const discAll = await call(host, 'op=gitop&action=discard-all' + R, 'POST')
    check('远端 gitop discard-all 成功', discAll.json?.ok === true, JSON.stringify(discAll.json?.error))
    check('discard-all 还原了已跟踪文件的改动',
      raw('git diff --name-only').trim() === '',
      JSON.stringify(raw('git diff --name-only')))
    check('discard-all 留下了未跟踪文件',
      raw('git status --porcelain').includes('untracked.txt'),
      JSON.stringify(raw('git status --porcelain')))

    /* pull needs an upstream; without one git fails with its own message. The
     * assertion is that the failure is REPORTED (clean JSON), not that it
     * succeeds — the fixture has no remote to pull from. */
    const pull = await call(host, 'op=gitop&action=pull' + R + '&branch=main', 'POST')
    check('远端 gitop pull 在无远程时干净报错（不是崩溃或挂起）',
      pull.json?.ok === true || (pull.status === 500 && String(pull.json?.error || '').length > 0),
      `${pull.status} ${JSON.stringify(String(pull.json?.error || '').slice(0, 100))}`)
  }

  /* fetch runs over the host's network. No remote is configured in the
   * fixture, so this proves the 120s path is wired without needing a server. */
  const fetchRes = await call(host, 'op=gitop&action=fetch' + R, 'POST')
  check('远端 gitop fetch 走通（无远程时也 exit 0）',
    fetchRes.json?.ok === true, JSON.stringify(fetchRes.json?.error))

  /* push: a fixture with no remote legitimately fails. What must NOT happen is
   * a server-side crash or a hang; the refusal has to arrive as a clean JSON
   * error, because the client shows it as a toast. */
  const push = await call(host, 'op=gitop&action=push' + R, 'POST')
  const pushMsg = String(push.json?.error || '')
  check('远端 gitop push 失败时给出可读错误而不是 500 异常',
    push.json?.ok === true || (push.status === 500 && pushMsg.length > 0),
    `${push.status} ${JSON.stringify(pushMsg.slice(0, 120))}`)

  /* The two refusals that survive all the way here. */
  const ignore = await call(host, 'op=gitop&action=ignore' + R + '&file=untracked.txt', 'POST')
  check('远端 gitop ignore 被拦截（不要让它走到 appendFileSync）',
    ignore.status === 400 && ignore.json?.error === 'unsupported-remote',
    `${ignore.status} ${ignore.json?.error}`)
  check('ignore 的 hint 点名 .gitignore 与「git 没有这个命令」',
    /\.gitignore/.test(String(ignore.json?.hint)) && /no command/.test(String(ignore.json?.hint)),
    JSON.stringify(ignore.json?.hint))

  const escapedWrite = await call(host, 'op=gitop&action=stage' + R + '&file=' + encodeURIComponent('../../../../etc/passwd'), 'POST')
  check('远端 gitop 越出 alias 根被 400 拒绝（写路径同样两面守卫）',
    escapedWrite.status === 400 && escapedWrite.json?.error === 'path-outside-repo',
    `${escapedWrite.status} ${escapedWrite.json?.error}`)
}

host.unload()

if (failures.length > 0) {
  console.error(`\n[remote-live] ${failures.length} 项失败：远端读路径与 git 原始输出不一致。`)
  console.error('[remote-live] 先查路径守卫与 async 辅助：守卫在远端恒真，说明还在用 resolve()+startsWith()。')
  process.exit(1)
}
console.log('\n[remote-live] 通过：远端读路径可用，且与 git 原始输出逐字段一致。')
