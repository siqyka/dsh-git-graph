#!/usr/bin/env node
/**
 * check-compat.mjs — 检查本插件声明的 DSH 兼容范围是否覆盖官方最新发行窗口。
 *
 * 兼容声明（官方字段，package.json）：
 *   engines.dsh                        — 声明性范围（回退读 dsh.engines.dsh）
 *   peerDependencies["@deepseek-ai/dsh"] — 强制范围（DSH ≥0.2.0 在组合与安装
 *     preflight 时按此拒绝不兼容插件，不满足会直接启动失败）
 *
 * 检查内容：npm registry 上官方 latest + 版本序中其前两个未弃用版本
 * （滚动窗口，排除 -next/-canary/-dev/-insiders 独占），外加 dist-tags.next
 * 预览线（官方 latest/next 双轨，如 0.1.7-rc.2 / 0.2.0-rc.1），逐个验证两个
 * 范围都覆盖；任一范围出现缺口即 exit 1。
 *
 * 用法：
 *   node scripts/check-compat.mjs            # 人读输出；有缺口时 exit 1
 *   node scripts/check-compat.mjs --json     # 机器可读
 *
 * 声明缺口出现时：收紧/修正范围并在两个锚点版本上跑
 * scripts/compat-isolated-test.ps1 隔离实测，证据记入 docs/compatibility.md。
 * 注：本脚本用简化的比较子句 semver（>= / > / < / <= / 精确版本，空格分隔，
 * prerelease 参与比较，等价 node-semver 的 includePrerelease）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const REGISTRY_DEFAULT = 'https://registry.npmjs.org/'
const PACKAGE = '@deepseek-ai%2Fdsh'
const WINDOW = 3

/** 简易 semver 比较（仅用于排序与比较子句，覆盖 x.y.z[-pre]）。 */
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

/** 简化 satisfies：比较子句以空格分隔，全部命中才算满足（含 prerelease）。 */
function satisfies(version, range) {
  const clauses = String(range).trim().split(/\s+/).filter(Boolean)
  return clauses.every((c) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(c)
    if (!m) throw new Error(`unsupported range clause: ${c}`)
    const cmp = cmpVer(version, m[2])
    switch (m[1] || '=') {
      case '>=': return cmp >= 0
      case '<=': return cmp <= 0
      case '>': return cmp > 0
      case '<': return cmp < 0
      default: return cmp === 0
    }
  })
}

async function fetchRegistry() {
  // 官方 registry 为准：镜像（npmmirror 等）同步滞后，会让"最新窗口"判断失真。
  // 显式传 --registry=<url> 或设置 DSH_COMPAT_REGISTRY 可覆盖。
  const override = process.argv.find((a) => a.startsWith('--registry='))
  const base = (override?.slice('--registry='.length) || process.env.DSH_COMPAT_REGISTRY || REGISTRY_DEFAULT).replace(/\/$/, '')
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
    console.error(`[warn] dist-tags.latest (${latest}) not in the active version list`)
  }
  const anchor = rows.indexOf(latest)
  const start = anchor === -1 ? 0 : anchor
  const window = rows.slice(start, start + WINDOW)
  // dist-tags.next 预览线（latest 与 next 是官方双轨）；不在窗口内则补进来
  const next = meta['dist-tags'] && meta['dist-tags'].next
  if (next && !window.includes(next)) window.push(next)
  return { latest, next, window }
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declaredEngines = manifest.engines?.dsh ?? manifest.dsh?.engines?.dsh
  const declaredPeer = manifest.peerDependencies?.['@deepseek-ai/dsh']
  if (!declaredEngines || !declaredPeer) {
    console.error('package.json 缺少 engines.dsh 或 peerDependencies["@deepseek-ai/dsh"] 声明')
    return 2
  }
  const meta = await fetchRegistry()
  const detail = meta.window.map((v) => ({
    version: v,
    engines: satisfies(v, declaredEngines),
    peer: satisfies(v, declaredPeer),
  }))
  const missing = detail.filter((d) => !d.engines || !d.peer)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      window: meta.window, latest: meta.latest, next: meta.next,
      engines: declaredEngines, peer: declaredPeer,
      gaps: missing.map((d) => d.version),
    }, null, 2))
  } else {
    console.log(`DSH 官方发行窗口（${meta.window.length} 个，latest=${meta.latest}${meta.next ? `，next=${meta.next}` : ''}）:`)
    for (const d of detail) {
      const ok = d.engines && d.peer
      console.log(`  ${d.version.padEnd(16)} engines.dsh=${d.engines ? '✓' : '✗'}  peer=${d.peer ? '✓' : '✗'}`)
      void ok
    }
    if (missing.length) {
      console.log(`\n缺口版本: ${missing.map((d) => d.version).join(', ')}`)
      console.log('修正 engines.dsh / peerDependencies 范围后，跑 scripts/compat-isolated-test.ps1 实测锚点版本。')
    } else {
      console.log(`\n窗口版本均被两个范围覆盖 ✓（engines.dsh=${declaredEngines} / peer=${declaredPeer}）`)
    }
  }
  return missing.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (err) {
  console.error(`check-compat failed: ${err.message}`)
  process.exitCode = 2
}
