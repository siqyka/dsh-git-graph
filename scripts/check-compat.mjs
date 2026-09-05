#!/usr/bin/env node
/**
 * check-compat.mjs — 检查本插件的 dshReleases 声明是否覆盖 DSH STORE 的
 * 「官方最新三个未弃用发行版」滚动窗口（与 DSH-Store registry/automation-policy.json
 * 的规则一致：latest dist-tag + 版本序中其前两个未弃用版本，排除 -next 独占）。
 *
 * 用法：
 *   node scripts/check-compat.mjs            # 人读输出；有缺口时 exit 1
 *   node scripts/check-compat.mjs --json     # 机器可读
 *
 * 每次发版 / 每个 DSH 新版本发布后运行一次；缺口出现时先补
 * package.json dsh.compatibility.dshReleases 逐版本精确声明，再提升插件 SemVer。
 * 注意：本脚本只检查声明的「覆盖」，不替代隔离 profile 的安装/启动/卸载/回滚证据
 * （见 docs/compatibility.md）。声明值只允许 compatible | incompatible | unknown。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const REGISTRY_DEFAULT = 'https://registry.npmjs.org/'
const PACKAGE = '@deepseek-ai%2Fdsh'
const WINDOW = 3

/** 简易 semver 比较（仅用于排序发行版，覆盖 x.y.z[-pre]）。 */
function cmpVer(a, b) {
  const pa = a.split('-'), pb = b.split('-')
  const na = pa[0].split('.').map(Number)
  const nb = pb[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) > (nb[i] || 0) ? 1 : -1
  }
  const ra = pa[1] || '', rb = pb[1] || ''
  if (ra === rb) return 0
  if (!ra) return 1
  if (!rb) return -1
  const ta = ra.split('.'), tb = rb.split('.')
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i] || '', y = tb[i] || ''
    if (x === y) continue
    const nx = parseInt(x, 10), ny = parseInt(y, 10)
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx > ny ? 1 : -1
    return x > y ? 1 : -1
  }
  return 0
}

async function fetchRegistry() {
  const base = (process.env.npm_config_registry || REGISTRY_DEFAULT).replace(/\/$/, '')
  const r = await fetch(`${base}/${PACKAGE}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`npm registry returned HTTP ${r.status}`)
  const meta = await r.json()
  const latest = meta['dist-tags'] && meta['dist-tags'].latest
  if (!latest) throw new Error('npm metadata has no dist-tags.latest')
  // 未弃用 + 非 -next 独占的版本，按版本序降序
  const rows = Object.entries(meta.versions || {})
    .filter(([v, d]) => !d.deprecated && !/-(next|canary|dev|insiders?)(\.|$)/i.test(v))
    .sort((x, y) => cmpVer(y[0], x[0]))
    .map(([v]) => v)
  if (!rows.includes(latest)) {
    // latest 被过滤（罕见：latest 指向被弃用/next 版本）——仍以 dist-tag 为准
    console.error(`[warn] dist-tags.latest (${latest}) not in the active version list`)
  }
  const anchor = rows.indexOf(latest)
  const start = anchor === -1 ? 0 : anchor
  const window = rows.slice(start, start + WINDOW)
  return { latest, window, all: rows }
}

async function main(manifest) {
  const dsh = manifest.dsh || {}
  const compatibility = dsh.compatibility || {}
  const releases = compatibility.dshReleases || {}
  const meta = await fetchRegistry()
  const detail = meta.window.map((v) => {
    const declared = releases[v]
    const ok = declared === 'compatible'
    return { version: v, declared: declared ?? 'unknown', status: ok ? 'ok' : declared === 'incompatible' ? 'incompatible' : 'missing' }
  })
  const missing = detail.filter((d) => d.status !== 'ok')
  const hint = missing
    .map((d) => `    "${d.version}": "compatible",`)
    .join('\n')
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      window: meta.window,
      latest: meta.latest,
      missing: missing.map((d) => d.version),
      declared: releases,
    }, null, 2))
  } else {
    console.log(`DSH 官方最新发行窗口（${meta.window.length} 个，latest=${meta.latest}）:`)
    for (const d of detail) {
      console.log(`  ${d.version.padEnd(16)} 声明=${String(d.declared).padEnd(11)} ${d.status === 'ok' ? '✓' : '✗ 需处理'}`)
    }
    if (missing.length) {
      console.log(`\n缺口（dsh.compatibility.dshReleases 需逐版本精确声明）:\n${hint}`)
      console.log('补声明并提升插件 SemVer 后推送；隔离实测证据见 docs/compatibility.md。')
    } else {
      console.log('\n三个窗口版本均有精确 compatible 声明 ✓')
    }
  }
  return missing.length === 0 ? 0 : 1
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
try {
  process.exitCode = await main(manifest)
} catch (err) {
  console.error(`check-compat failed: ${err.message}`)
  process.exitCode = 2
}