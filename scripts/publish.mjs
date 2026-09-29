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
  const r = spawnSync(cmd, args, { cwd: root, stdio: opts.capture ? 'pipe' : 'inherit', shell: false, encoding: 'utf8' })
  if (r.status !== 0) {
    if (opts.capture) console.error(r.stdout, r.stderr)
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`)
  }
  return r
}

function fail(msg) {
  console.error(`\n[publish] BLOCKED: ${msg}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/* 1) scoped 包名闸门 */
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

/* 2) 语法检查 */
run(process.execPath, ['--check', 'index.js'])
run(process.execPath, ['--check', 'client.js'])
{
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  if (scripts.length === 0) fail('web/index.html 中没有找到内联 <script>')
  const tmp = mkdtempSync(join(tmpdir(), 'gg-publish-'))
  try {
    scripts.forEach((m, i) => {
      const f = join(tmp, `inline-${i}.mjs`)
      writeFileSync(f, m[1])
      run(process.execPath, ['--check', f])
    })
    console.log(`[publish] 语法检查通过：index.js、client.js、内联脚本 ×${scripts.length}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
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
