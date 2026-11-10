#!/usr/bin/env node
/**
 * check-remote.mjs — 回归检查：runGit 的远端分流（M1）。
 *
 * 为什么需要它：
 *   M1 只铺管道、不接线，所以没有任何 op handler 能把 runGit 带到远端分支上。
 *   如果只靠「本地功能还正常」来判断，那么远端分支哪怕是空的、抛错的、或者
 *   悄悄退回了本地 execFile，检查也全绿。这里用一个最小的 fake host 把它
 *   单独钉住。
 *
 * 被钉住的六条（全部来自 dsh-ssh-workspace 的真实契约，见 lib/patch-subprocess.js）：
 *   1. 本地路径完全没变：仍然走 execFile，远端通道 spawn 计数为 0。
 *   2. 远端 spec 形状正确：argv 严格等于 ['git', ...args]（**没有 -C**）、
 *      cwd 是那个 ssh:// 路径、graceMs 有限且 > 0、stdout.maxBytes 是 32MB。
 *   3. exitCode !== 0 → reject，message 用 stderr 文案而不是 "git exited"。
 *   4. finalize().truncated === true → reject，且不解析半截输出。
 *   5. done reject（断连）→ 只读 op 重试 1 次，写 op 重试 0 次。
 *   6. 未装 ssh-workspace → reject remote-workspace-unsupported，且 spawn 一次都没调。
 *
 * 纯 node、无网络、无宿主、无真机。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(root, 'index.js')).href)
const t = plugin.__test

const failures = []
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Marker symbol the real plugin installs on the patched service. */
const INSTALLED = Symbol.for('dsh-ssh-workspace.subprocess-installed')

/**
 * Minimal remote stand-in. Records every spec it is handed and answers with a
 * canned handle, so a check can assert on what runGit asked for, not just on
 * what it returned.
 */
function makeSpawner({ stdout = '', stderr = '', exitCode = 0, truncated = false, failWith = null, delayMs = 0 } = {}) {
  const specs = []
  const spawn = (spec) => {
    specs.push(spec)
    let settle
    const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
    void done.catch(() => {})
    setTimeout(() => {
      if (failWith) settle.reject(failWith)
      else settle.resolve({ exitCode, signal: null })
    }, delayMs)
    return {
      collected: {
        stdout: { finalize: () => ({ text: stdout, truncated }) },
        stderr: { finalize: () => ({ text: stderr, truncated: false }) },
      },
      done,
      terminate: () => true,
    }
  }
  return { specs, spawn }
}

/**
 * Minimal ctx. `apply()` installs a webServer route, so the fake needs enough
 * of `effect` / `webServer.register` to mount and to be torn down between
 * checks — leaving a route registered would make the next `apply()` collide.
 */
function makeHost(service, extras = {}) {
  const disposers = []
  let handler = null
  return {
    get: (id) => (id === 'subprocess' ? service : extras[id]),
    effect(execute) {
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    webServer: {
      register(route) {
        handler = route.handler
        return () => { handler = null }
      },
    },
    handler: () => handler,
    unload() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

async function withHost(service, fn) {
  const host = makeHost(service)
  plugin.apply(host, {})
  try { return await fn() } finally { host.unload() }
}

/** Like {@link withHost}, but also hands the mounted host to the callback so it
 *  can drive the HTTP handler directly. */
async function withApiHost(service, extras, fn) {
  const host = makeHost(service, extras)
  plugin.apply(host, {})
  try { return await fn(host) } finally { host.unload() }
}

/**
 * Drive the real route handler with a fake request/response pair.
 *
 * Going through the handler rather than calling helpers is deliberate: the
 * refusals live inside and before `switch (op)`, and their HTTP status is part
 * of the contract. A helper-level test would stay green if the handler started
 * answering something else — or if the refusal moved *after* the local
 * implementation had already run.
 */
function callApi(handler, query, { method = 'GET' } = {}) {
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
    Promise.resolve(handler(req, res)).catch(() => settle(500, ''))
  })
}

console.log('[remote] runGit 的远端分流')

const REMOTE = 'ssh://qiyk/home/qiyk/mygit'

/* ---- 1) local paths must be untouched ---------------------------------- */
{
  const spawner = makeSpawner()
  const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
  await withHost(service, async () => {
    /* `here` is this repo — a real local git call, but `--version` is the one
     * invocation guaranteed to work in any checkout and to produce no state. */
    const out = await t.runGit(root, ['--version'])
    check('本地路径仍走 execFile（git --version 返回文本）', /^git version /.test(out.trim()), JSON.stringify(out.slice(0, 40)))
    check('本地路径不碰远端通道（spawn 计数 0）', spawner.specs.length === 0, `specs=${spawner.specs.length}`)
  })
}

/* ---- 2) remote spec shape --------------------------------------------- */
{
  const spawner = makeSpawner({ stdout: 'abc123\n' })
  const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
  await withHost(service, async () => {
    /* Caught rather than awaited bare: when the diversion is removed this is
     * the check that notices, and a rejection here should be reported as a
     * failed assertion instead of crashing the process mid-suite. */
    let out
    try { out = await t.runGit(REMOTE, ['log', '-1', '--format=%H']) } catch (e) { out = e }
    check('远端调用没有退回本地 execFile', !(out instanceof Error), String(out && out.message))
    const spec = spawner.specs[0]
    check('远端调用只 spawn 一次', spawner.specs.length === 1, `specs=${spawner.specs.length}`)
    check('argv 严格等于 [git, log, -1, --format=%H]（不含 -C）',
      JSON.stringify(spec?.argv) === JSON.stringify(['git', 'log', '-1', '--format=%H']),
      JSON.stringify(spec?.argv))
    check('cwd 就是那个 ssh:// 路径', spec?.cwd === REMOTE, spec?.cwd)
    check('graceMs 有限且 > 0', Number.isFinite(spec?.graceMs) && spec.graceMs > 0, String(spec?.graceMs))
    check('stdout.maxBytes = 32MB', spec?.stdio?.stdout?.maxBytes === 32 * 1024 * 1024, String(spec?.stdio?.stdout?.maxBytes))
    check('stderr.maxBytes ≤ 1MB', spec?.stdio?.stderr?.maxBytes <= 1024 * 1024, String(spec?.stdio?.stderr?.maxBytes))
    check('stdout 原样交给调用方', out === 'abc123\n', JSON.stringify(out))
  })
}

/* ---- 3) non-zero exit rejects with the stderr text --------------------- */
{
  const spawner = makeSpawner({ stderr: 'fatal: not a git repository\n', exitCode: 128 })
  const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
  await withHost(service, async () => {
    let err
    try { await t.runGit(REMOTE, ['rev-parse', '--git-dir']) } catch (e) { err = e }
    check('exitCode !== 0 → reject', err instanceof Error)
    check('reject 文案取自 stderr', err?.message === 'fatal: not a git repository', JSON.stringify(err?.message))
  })
}

/* ---- 4) truncated output is rejected, never parsed -------------------- */
{
  const spawner = makeSpawner({ stdout: 'half a log', truncated: true })
  const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
  await withHost(service, async () => {
    let err
    try { await t.runGit(REMOTE, ['log']) } catch (e) { err = e }
    check('finalize().truncated → reject', err instanceof Error)
    check('截断文案点名上限', /exceeded 33554432 bytes/.test(String(err?.message)), String(err?.message))
  })
}

/* ---- 5) connection drop: retry reads, never write --------------------- */
{
  const drop = () => Object.assign(
    new Error('ssh-workspace: the SSH connection dropped before the process reported an exit status'),
    { retryable: false },
  )
  {
    const spawner = makeSpawner({ stdout: 'ok\n', failWith: drop() })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withHost(service, async () => {
      let err
      try { await t.runGit(REMOTE, ['log', '-1']) } catch (e) { err = e }
      check('断连的只读 op 重试一次（spawn 计数 2）', spawner.specs.length === 2, `specs=${spawner.specs.length}`)
      check('断连的只读 op 仍以断连错误 reject', /SSH connection dropped/.test(String(err?.message)), String(err?.message))
    })
  }
  {
    const spawner = makeSpawner({ failWith: drop() })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withHost(service, async () => {
      let err
      try { await t.runGit(REMOTE, ['commit', '-m', 'x']) } catch (e) { err = e }
      check('断连的写 op 不重试（spawn 计数 1）', spawner.specs.length === 1, `specs=${spawner.specs.length}`)
      check('断连的写 op 原样上抛', /SSH connection dropped/.test(String(err?.message)), String(err?.message))
    })
  }
}

/* ---- 6) no ssh-workspace: typed refusal, no spawn --------------------- */
{
  const spawner = makeSpawner()
  /* A service that exists but was never patched — the realistic shape when
   * another plugin owns `subprocess` and ssh-workspace is not installed. */
  const service = { spawn: spawner.spawn }
  await withHost(service, async () => {
    let err
    try { await t.runGit(REMOTE, ['log']) } catch (e) { err = e }
    check('未装 ssh-workspace → remote-workspace-unsupported', err?.message === 'remote-workspace-unsupported', String(err?.message))
    check('未装 ssh-workspace → spawn 一次都没调', spawner.specs.length === 0, `specs=${spawner.specs.length}`)
  })
}

/* ---- 7) lexical helpers (pure functions) ----------------------------- */
{
  check('remoteJoin 消掉 . 与 ..', t.remoteJoin('/a/b/c', '../d/./e') === '/a/b/d/e', t.remoteJoin('/a/b/c', '../d/./e'))
  check('remoteJoin 越出根返回 null', t.remoteJoin('/', '../x') === null, String(t.remoteJoin('/', '../x')))
  check('resolveRemoteFile 拼回 ssh://', t.resolveRemoteFile(REMOTE, './src/a.js') === REMOTE + '/src/a.js', t.resolveRemoteFile(REMOTE, './src/a.js'))
  check('resolveRemoteFile 拒绝绝对路径', t.resolveRemoteFile(REMOTE, '/etc/passwd') === null, String(t.resolveRemoteFile(REMOTE, '/etc/passwd')))
  /* The guard is the alias root, not the repository: `../..` from a repo deep
   * in the home directory is still inside `ssh://qiyk/`, and the local
   * `startsWith()` check would accept it too. Only walking above `/` fails. */
  check('resolveRemoteFile 允许在 alias 内上溯', t.resolveRemoteFile(REMOTE, '../sibling/x') === 'ssh://qiyk/home/qiyk/sibling/x', String(t.resolveRemoteFile(REMOTE, '../sibling/x')))
  check('resolveRemoteFile 拒绝越出 alias 根', t.resolveRemoteFile(REMOTE, '../../../../../etc/passwd') === null, String(t.resolveRemoteFile(REMOTE, '../../../../../etc/passwd')))
  check('parseRemotePath 拆出 alias 与绝对路径',
    JSON.stringify(t.parseRemotePath(REMOTE)) === JSON.stringify({ alias: 'qiyk', remotePath: '/home/qiyk/mygit' }),
    JSON.stringify(t.parseRemotePath(REMOTE)))
  check('parseRemotePath 拒绝本地路径', t.parseRemotePath('C:/repo') === null, String(t.parseRemotePath('C:/repo')))
  check('isRemotePath 只认 ssh://', t.isRemotePath(REMOTE) && !t.isRemotePath('C:/repo') && !t.isRemotePath(null))
}


/* ---- 8) remote-only refusals (M3) ------------------------------------- */
/* These five ops were written against THIS machine's filesystem. On a remote
 * repository they cannot be answered at all, so they refuse with a reason
 * instead of running a local implementation against a path that does not
 * exist here. The refusals are driven through the real route handler because
 * the interesting half is *when* they fire: `gitop ignore` must be refused
 * BEFORE the action dispatch, or it reaches `appendFileSync` first. */
{
  const spawner = makeSpawner({ stdout: '' })
  const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
  await withApiHost(service, {}, async (host) => {
    /* `repos` first: it is what records the workspace for the folder-picker
     * ops below (they carry no `ws` of their own). */
    const q = `op=repos&ws=${encodeURIComponent(REMOTE)}`
    await callApi(host.handler(), q)

    /* `addrepo` is a write op, so the POST requirement answers first (405).
     * That ordering is the security design, not a gap: a refusal is a refusal,
     * and a browser cannot forge a POST cross-site to reach either one. */
    const OP_METHOD = { listdir: 'GET', addrepo: 'POST', findrepos: 'GET' }
    /* No `path` at all is the "start from the drives" form of listdir — the
     * one case where the request itself carries no remote signal, so only
     * `lastWs` can refuse it. Without this, a guard that keyed solely off the
     * path parameter would look correct. */
    {
      const bare = await callApi(host.handler(), 'op=listdir')
      check('远端会话下 listdir 不带 path 也被拒（靠 lastWs 而非请求参数）',
        bare.json?.error === 'unsupported-remote', JSON.stringify(bare.json?.error))
    }
    for (const op of ['listdir', 'addrepo', 'findrepos']) {
      const { status, json } = await callApi(
        host.handler(),
        `op=${op}&path=${encodeURIComponent(REMOTE)}`,
        { method: OP_METHOD[op] },
      )
      check(`${op} 在远端会话下报 unsupported-remote`, json?.error === 'unsupported-remote', JSON.stringify(json?.error))
      check(`${op} 的 hint 说明原因而不是只说「不支持」`, typeof json?.hint === 'string' && json.hint.length > 20, JSON.stringify(json?.hint))
      check(`${op} 回 400`, status === 400, String(status))
    }

    /* `reveal` reaches the repo gate (it needs a repo), so the allow-set has to
     * accept this one. The workspace registration above covers that. */
    const reveal = await callApi(host.handler(), `op=reveal&repo=${encodeURIComponent(REMOTE)}`)
    check('reveal 在远端仓库下报 unsupported-remote', reveal.json?.error === 'unsupported-remote', JSON.stringify(reveal.json?.error))
    check('reveal 没有落到本机文件管理器', reveal.status === 400, String(reveal.status))
  })
}
{
  /* `gitop ignore` — refused before dispatch. The assertion that matters is
   * that no `appendFileSync` ran: the spy below replaces it on the module
   * namespace module object, which is where `index.js` resolves it from. */
  const spawner = makeSpawner({ stdout: '' })
  const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
  await withApiHost(service, {}, async (host) => {
    await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
    /* Baseline AFTER the repos call: that one legitimately runs a git for the
     * remote workspace, and counting it would make this assertion about the
     * wrong process. */
    const spawnsBefore = spawner.specs.length
    const { status, json } = await callApi(
      host.handler(),
      `op=gitop&action=ignore&repo=${encodeURIComponent(REMOTE)}&file=notes.txt`,
      { method: 'POST' },
    )
    check('gitop ignore 在远端仓库下报 unsupported-remote', json?.error === 'unsupported-remote', JSON.stringify(json?.error))
    check('gitop ignore 的 hint 点名 .gitignore 与 git 没有这个命令',
      /\.gitignore/.test(String(json?.hint)) && /no command/.test(String(json?.hint)), JSON.stringify(json?.hint))
    check('gitop ignore 回 400', status === 400, String(status))
    /* A local path would have reached the dispatch; the refusal must not have
     * any git process behind it either. */
    check('gitop ignore 被拦时没有为它起任何 git', spawner.specs.length === spawnsBefore, `specs=${spawner.specs.length} (baseline ${spawnsBefore})`)
  })
}


/* ---- 9) the same five ops on a LOCAL repo are untouched --------------- */
/* The refusals key off `isRemotePath`, so the risk is a guard that fires on
 * every path. Each assertion below is the local twin of one above: it must NOT
 * come back as `unsupported-remote`. */
{
  const spawner = makeSpawner({ stdout: '' })
  const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
  /* `config.repo` is how a local repo gets into the allow-list (the remote
   * block above used the `repos` op instead, which only registers remote ones). */
  const host = makeHost(service)
  plugin.apply(host, { repo: root })
  try {
    const h = host.handler()
    const listing = await callApi(h, `op=listdir&path=${encodeURIComponent(root)}`)
    check('本地 listdir 照旧列出目录（不是 unsupported-remote）',
      listing.json?.ok === true && listing.json?.error !== 'unsupported-remote', JSON.stringify(listing.json?.error))

    const scan = await callApi(h, `op=findrepos&ws=${encodeURIComponent(root)}`)
    check('本地 findrepos 照旧扫描（不是 unsupported-remote）',
      scan.json?.ok === true && scan.json?.error !== 'unsupported-remote', JSON.stringify(scan.json?.error))

    const added = await callApi(h, `op=addrepo&path=${encodeURIComponent(root)}`, { method: 'POST' })
    check('本地 addrepo 照旧登记（不是 unsupported-remote）',
      added.json?.error !== 'unsupported-remote', JSON.stringify(added.json?.error))

    /* `ignore` WITHOUT files reaches the dispatch and throws `missing-file`
     * before the `appendFileSync`. That is the whole point of the ordering:
     * a local ignore still gets its normal error, not a remote refusal, and
     * this check does not touch the real .gitignore. */
    const ignored = await callApi(h, `op=gitop&action=ignore&repo=${encodeURIComponent(root)}`, { method: 'POST' })
    check('本地 gitop ignore 照旧走到分派（报 missing-file 而不是 unsupported-remote）',
      ignored.json?.error === 'missing-file', JSON.stringify(ignored.json?.error))

    /* `reveal` is NOT exercised against a local repo: it would open this
     * machine's file manager during a test run. A path outside the allow-list
     * proves the remote guard did not fire (403 repo-not-allowed, which is the
     * local gate answering) without launching anything. */
    const revealed = await callApi(h, `op=reveal&repo=${encodeURIComponent(root + '/definitely-not-a-repo')}`)
    check('本地 reveal 的远端拦截不触发（由白名单先拒，403 repo-not-allowed）',
      revealed.json?.error === 'repo-not-allowed', JSON.stringify(revealed.json?.error))
  } finally { host.unload() }
}

/* ---- 10) `wsProbe` names the real cause of a missing remote root ------ */
/* The empty screen used to render every remote miss as "install
 * @shiqyka/dsh-ssh-workspace". That advice is right for exactly one cause and
 * actively misleading for the most common one — a workspace pointed at a folder
 * that simply is not a repository (or is the parent of one; remote discovery
 * only walks upward). The client now picks its copy from `wsProbe`, so the
 * classification itself has to be pinned: if `probeRemoteGitRoot` ever folds
 * these back into a single `unknown`, every client assertion would still pass
 * against the fallback sentence and the bug would be back. */
{
  /* 10a. bridge missing: answered WITHOUT spawning anything. The negative is
   * the point — an unpatched `spawn` would run git locally against an `ssh://`
   * cwd, so "we can report the cause" must never cost a process here. */
  {
    const plain = makeSpawner({ stdout: '' })
    await withApiHost({ spawn: plain.spawn }, {}, async (host) => {
      const { json } = await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      check('wsProbe/桥缺失：reason 是 bridge-missing 且 bridge:false',
        json?.wsProbe?.reason === 'bridge-missing' && json?.wsProbe?.bridge === false,
        JSON.stringify(json?.wsProbe))
      check('wsProbe/桥缺失：wsIsGit 仍为 false（语义没变）',
        json?.wsIsGit === false && json?.wsRoot === null, JSON.stringify({ g: json?.wsIsGit, r: json?.wsRoot }))
      check('wsProbe/桥缺失：没有为它起任何 git 进程',
        plain.specs.length === 0, `specs=${plain.specs.length}`)
    })
  }

  /* 10b. bridge fine, git says "not a repository" — the case that was wrong.
   * `bridge:true` is what tells the client NOT to mention the plugin. */
  {
    const spawner = makeSpawner({
      exitCode: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withApiHost(service, {}, async (host) => {
      const { json } = await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      check('wsProbe/非仓库：reason 是 not-a-repo',
        json?.wsProbe?.reason === 'not-a-repo', JSON.stringify(json?.wsProbe))
      check('wsProbe/非仓库：bridge 与 git 都为 true（区别于点名插件的那种）',
        json?.wsProbe?.bridge === true && json?.wsProbe?.git === true, JSON.stringify(json?.wsProbe))
      check('wsProbe/非仓库：回传远端 stderr 首行供对照',
        /not a git repository/.test(String(json?.wsProbe?.detail)), JSON.stringify(json?.wsProbe?.detail))
    })
  }

  /* 10c. git absent on the host — a package-manager problem, not a plugin one.
   * The phrase comes from ssh-workspace's own INSTALL_HINTS. */
  {
    const spawner = makeSpawner({
      exitCode: 127,
      stderr: 'ssh-workspace: git is not installed on this remote host — install git there to track workspace changes',
    })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withApiHost(service, {}, async (host) => {
      const { json } = await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      check('wsProbe/远端无 git：reason 是 git-missing 且 git:false',
        json?.wsProbe?.reason === 'git-missing' && json?.wsProbe?.git === false,
        JSON.stringify(json?.wsProbe))
    })
  }

  /* 10d. connection failures — network/credentials, and the copy must say so
   * instead of blaming an installed, working plugin. */
  {
    const spawner = makeSpawner({
      exitCode: 255,
      stderr: 'ssh: Could not resolve hostname qiyk: Name or service not known',
    })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withApiHost(service, {}, async (host) => {
      const { json } = await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      check('wsProbe/连不上：reason 是 unreachable',
        json?.wsProbe?.reason === 'unreachable', JSON.stringify(json?.wsProbe))
    })
  }

  /* 10e. the happy path still reports `ok` and a root — the probe must not
   * have changed what a working workspace answers. */
  {
    const spawner = makeSpawner({ stdout: '/home/qiyk/mygit\n' })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withApiHost(service, {}, async (host) => {
      const { json } = await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      check('wsProbe/成功：reason 是 ok 且 wsRoot 拼回 ssh://',
        json?.wsProbe?.reason === 'ok' && json?.wsRoot === REMOTE,
        JSON.stringify({ p: json?.wsProbe, r: json?.wsRoot }))
      check('wsProbe/成功：wsIsGit 为 true', json?.wsIsGit === true, JSON.stringify(json?.wsIsGit))
    })
  }

  /* 10f. a local workspace never carries a probe: there is nothing ambiguous
   * about "this local folder is not a repository", and a probe would cost a
   * process to restate it. `null` is the client's signal to use plain copy. */
  {
    const spawner = makeSpawner({ stdout: '' })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    const host = makeHost(service, {})
    plugin.apply(host, { repo: root })
    try {
      const { json } = await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(root + '/scripts')}`)
      check('wsProbe/本地：不受影响，wsProbe 为 null',
        json?.wsProbe === null, JSON.stringify(json?.wsProbe))
      check('wsProbe/本地：没有为探针起任何 git',
        spawner.specs.length === 0, `specs=${spawner.specs.length}`)
    } finally { host.unload() }
  }
}

/* ---- 11) remote writes honour the session's read-only mode ------------ */
/* `lib/patch-subprocess.js` in ssh-workspace never imports `mode-gate.js`, so a
 * git command through the bridge runs as the remote login user whatever the
 * session mode says. The gate below is this plugin's own answer, and it FAILS
 * OPEN: no policy service means an unconfined deployment, not a view-only one. */
{
  const READ_ONLY_HINT = 'read-only-session'
  const makePolicy = (mode) => ({
    resolve: () => ({ mode }),
  })
  const makeSessions = () => ({ list: () => [{ header: { cwd: REMOTE } }] })

  const stage = (host) => callApi(
    host.handler(),
    `op=gitop&action=stage&repo=${encodeURIComponent(REMOTE)}`,
    { method: 'POST' },
  )

  for (const mode of ['read-only']) {
    const spawner = makeSpawner({ stdout: '' })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    const extras = { sandboxPolicy: makePolicy(mode), sessions: makeSessions() }
    await withApiHost(service, extras, async (host) => {
      await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      const { status, json } = await stage(host)
      check(`${mode} 会话下远端 gitop 被拒（read-only-session）`,
        json?.error === READ_ONLY_HINT, JSON.stringify(json?.error))
      check(`${mode} 会话下远端 gitop 回 403`, status === 403, String(status))
      check(`${mode} 的 hint 指向切换会话模式`,
        /workspace-write or danger-full-access/.test(String(json?.hint)), JSON.stringify(json?.hint))
    })
  }

  /* A remote write WITH a file is the only shape that exercises `okPath`:
   * without the fork, `resolve()` builds a local-looking path that can never
   * start with the ssh:// base, so every remote file is rejected as
   * path-outside-repo. The empty-file case below would never notice. */
  {
    const spawner = makeSpawner({ stdout: '' })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withApiHost(service, {}, async (host) => {
      await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      const stageFile = await callApi(
        host.handler(),
        `op=gitop&action=stage&repo=${encodeURIComponent(REMOTE)}&file=notes.txt`,
        { method: 'POST' },
      )
      check('远端 gitop 带 file 时路径守卫放行（不然任何远端文件都被 path-outside-repo 拒）',
        stageFile.json?.ok === true, JSON.stringify(stageFile.json?.error))
    })
  }
  for (const mode of ['workspace-write', 'danger-full-access']) {
    const spawner = makeSpawner({ stdout: '' })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    const extras = { sandboxPolicy: makePolicy(mode), sessions: makeSessions() }
    await withApiHost(service, extras, async (host) => {
      await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      const { json } = await stage(host)
      /* Reaching `missing-file` proves the write gate let it through: the
       * refusal would have replaced that error entirely. */
      check(`${mode} 会话下远端 gitop 放行（走到分派，报 missing-file）`,
        json?.error === 'missing-file', JSON.stringify(json?.error))
    })
  }

  /* No policy service at all: fail open. A deployment without one is
   * unconfined, and refusing would send the user to a switch that cannot help. */
  {
    const spawner = makeSpawner({ stdout: '' })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    await withApiHost(service, {}, async (host) => {
      await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(REMOTE)}`)
      const { json } = await stage(host)
      check('无 sandboxPolicy 服务时远端写放行（fail-open，不是默认冻结）',
        json?.error === 'missing-file', JSON.stringify(json?.error))
    })
  }

  /* The gate is remote-only: the same read-only policy must leave a LOCAL
   * write exactly as it was (the local path was never gated, and adding a
   * local refusal here would be a behaviour change nobody asked for). */
  {
    const spawner = makeSpawner({ stdout: '' })
    const service = { [INSTALLED]: { engine: null }, spawn: spawner.spawn }
    /* `sessions` answers for the LOCAL workspace too, so a gate that forgot
     * `isRemotePath(repo)` would resolve `read-only` here and refuse — which is
     * exactly what this check has to catch. With a remote-only `sessions` list
     * the mode stays undefined and both behaviours look identical. */
    const localSessions = { list: () => [{ header: { cwd: root } }] }
    const host = makeHost(service, { sandboxPolicy: makePolicy('read-only'), sessions: localSessions })
    plugin.apply(host, { repo: root })
    try {
      /* Records `lastWs` for this host; the mode lookup is keyed on it. */
      await callApi(host.handler(), `op=repos&ws=${encodeURIComponent(root)}`)
      const { json } = await callApi(
        host.handler(),
        `op=gitop&action=stage&repo=${encodeURIComponent(root)}`,
        { method: 'POST' },
      )
      check('read-only 策略下本地 gitop 行为不变（不被远端门禁拦住）',
        json?.error === 'missing-file', JSON.stringify(json?.error))
    } finally { host.unload() }
  }
}

if (failures.length > 0) {
  console.error(`\n[remote] ${failures.length} 项失败：远端分流不符合 ssh-workspace 的契约。`)
  console.error('[remote] 先读 dsh-ssh-workspace/lib/patch-subprocess.js 的 spawn 校验与 done 形状。')
  process.exit(1)
}
console.log('\n[remote] 通过：本地路径不变，远端 spec 与结果处理符合契约。')
