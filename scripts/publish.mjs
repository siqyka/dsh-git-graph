#!/usr/bin/env node
/**
 * publish.mjs — npm 发布前检查链 + 发布（GitHub + npm 双通道中的 npm 半侧）。
 *
 * 用法：
 *   npm run publish:npm           # 全部检查通过后执行 npm publish
 *   node scripts/publish.mjs --check-only   # 只做检查，不发布
 *
 * 检查项（任一失败即中止）：
 *   1. 包名为 scoped（@<scope>/dsh-git-graph）—— npm 上 `dsh-git-graph`
 *      已被无关插件占用，必须以 scope 发布；未改名时输出改名清单。
 *   2. index.js / client.js 通过 node --check；web/index.html 内联脚本
 *      提取后通过 node --check。
 *   3. scripts/check-compat.mjs 通过（官方发行窗口被兼容范围覆盖）。
 *   4. npm pack --dry-run 校验发布内容（files 白名单）。
 *
 * 发布强制走官方 registry（本机 .npmrc 常配 npmmirror，不能发布）。
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
const checkOnly = process.argv.includes('--check-only')

function run(cmd, args, opts = {}) {
  /* Windows ships npm as npm.cmd, and Node refuses to spawn .cmd/.bat directly
   * (spawn EINVAL since the 2024 command-injection fix). That surfaced as
   * `npm pack --dry-run failed (exit null)` — a null status, not a real
   * failure — so the check chain never reached the publish step. Route npm
   * through the shell on Windows; every npm argument here is a plain flag. */
  const useShell = process.platform === 'win32' && /^npm(\.cmd)?$/i.test(cmd)
  const r = spawnSync(cmd, args, { cwd: root, stdio: opts.capture ? 'pipe' : 'inherit', shell: useShell, encoding: 'utf8' })
  if (r.status !== 0) {
    if (opts.capture) console.error(r.stdout, r.stderr)
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})${r.error ? `: ${r.error.message}` : ''}`)
  }
  return r
}

function fail(msg) {
  console.error(`\n[publish] BLOCKED: ${msg}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/* 1) 包名闸门：必须 scoped，且三处标识必须完全一致 */
if (!pkg.name.startsWith('@')) {
  fail([
    '包名未 scoped。npm 上 `dsh-git-graph` 已被无关插件（enoughpower/dsh-git-graph）占用，',
    '必须以 `@<你的npm用户名>/dsh-git-graph` 发布。发布前需同步改名（保持一致）：',
    '  a) package.json "name" → "@<scope>/dsh-git-graph"',
    '  b) client.js 第一行 window.__ModuleLoader__.load({ id: ... }) → 同名',
    '  c) cordis.patch.yml insert 行 name: → 同名',
    '  d) README.md / README_EN.md 安装命令中的包名',
    '先 npm login 后用 `npm whoami` 确认 scope，再重跑本脚本。',
  ].join('\n'))
}
{
  /* 三处必须逐字一致：客户端加载器用包名去找 `__ModuleLoader__.load` 注册的 id，
   * 组合层用行 name 做 require.resolve 再读 `dsh.client`。任一处不同 —— 安装不报错，
   * 但标签页静默消失。发布后才发现代价太高，所以在发布前逐字比对。 */
  const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
  const clientId = /__ModuleLoader__\.load\(\s*\{[\s\S]*?\bid:\s*["']([^"']+)["']/.exec(clientSrc)?.[1]
  const patchRow = /^[ \t]*name:[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/m.exec(
    readFileSync(join(root, 'cordis.patch.yml'), 'utf8'),
  )?.[1]
  const mismatched = [
    ['client.js 的 __ModuleLoader__.load id', clientId],
    ['cordis.patch.yml 的 insert 行 name', patchRow],
  ].filter(([, value]) => value !== pkg.name)
  if (mismatched.length) {
    fail([
      `package.json name = ${pkg.name}，以下位置不一致：`,
      ...mismatched.map(([where, value]) => `  ${where} = ${value ?? '(未找到)'}`),
      '这三处必须逐字相同，否则插件装上后标签页静默消失。',
    ].join('\n'))
  }
  console.log(`[publish] 包名一致：${pkg.name}（package.json / client.js id / patch 行 name）`)
}

/* 2) 语法检查 */
run(process.execPath, ['--check', 'index.js'])
run(process.execPath, ['--check', 'client.js'])
/* The page is three files now: index.html + app.css + app.js. Check the script
 * directly, and assert the HTML actually references both assets — a release
 * that forgets to ship them would publish a blank page. */
run(process.execPath, ['--check', join('web', 'app.js')])
{
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  if (!html.includes('href="app.css"')) fail('web/index.html 未引用 app.css')
  if (!html.includes('src="app.js"')) fail('web/index.html 未引用 app.js')
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  if (inline.length === 0) {
    console.log('[publish] 语法检查通过：index.js、client.js、web/app.js（页面无内联脚本）')
  } else {
    // Legacy layout: keep checking whatever inline blocks are still there.
    const tmp = mkdtempSync(join(tmpdir(), 'gg-publish-'))
    try {
      inline.forEach((m, i) => {
        const f = join(tmp, `inline-${i}.mjs`)
        writeFileSync(f, m[1])
        run(process.execPath, ['--check', f])
      })
      console.log(`[publish] 语法检查通过：index.js、client.js、web/app.js、内联脚本 ×${inline.length}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/* 3) 兼容窗口覆盖检查 */
run(process.execPath, ['scripts/check-compat.mjs'])

/* 4) 打包内容预览 */
console.log('\n[publish] npm pack --dry-run:')
run('npm', ['pack', '--dry-run'])

if (checkOnly) {
  console.log('\n[publish] --check-only：检查全部通过，未发布。')
  process.exit(0)
}

/* 发布（强制官方 registry；publishConfig 已带 access: public，双保险） */
console.log('\n[publish] 发布到官方 registry …')
run('npm', ['publish', '--registry', OFFICIAL_REGISTRY, '--access', 'public'])
console.log(`\n[publish] 完成：${pkg.name}@${pkg.version}`)
console.log('别忘了：git commit + git tag v' + pkg.version + ' + git push --tags')
