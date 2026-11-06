#!/usr/bin/env node
/**
 * check-lifecycle.mjs — 回归检查：apply() 安装的路由必须能被卸载。
 *
 * 为什么需要它（v0.26.2 的真实故障）：
 *   apply() 原先直接调用 `ctx.webServer.register(...)` 而没有把返回的
 *   disposer 交给框架。宿主卸载插件时（plugin-manager 的热重载、配置更新、
 *   HMR、禁用再启用）fiber 没有可执行的清理，/git-graph 前缀路由留在
 *   webServer 的路由表里；下一次挂载再注册同一路径，webServer 的
 *   `duplicate prefix route` 守卫直接抛错，插件再也装不回来。
 *
 * 判据（两条都必须成立）：
 *   1. 挂载后路由存在；
 *   2. 卸载后路由消失，且可以被再次挂载。
 *
 * 这里用一个最小的 fake ctx，只实现 apply() 实际用到的两个成员
 * （ctx.effect / ctx.webServer.register），不依赖宿主，可在裸检出上跑。
 * 注意：这个 fake 刻意不复刻 webServer 的重复守卫——检查的是「插件有没有
 * 交出清理函数」，不是「宿主守卫生效没生效」。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(root, 'index.js')).href)

const failures = []
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Minimal host surface: enough for apply() to install and to be torn down. */
function makeHost() {
  const routes = new Map()
  const disposers = []
  return {
    routes,
    effect(execute) {
      const disposer = execute()
      if (typeof disposer !== 'function') {
        throw new TypeError('ctx.effect() body returned no disposer — the route would leak')
      }
      disposers.push(disposer)
      return disposer
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"` )
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    unload() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

console.log('[lifecycle] apply() 装的路由必须可卸载')

const host = makeHost()
plugin.apply(host, {})
check('挂载后 /git-graph 路由存在', host.routes.has('/git-graph'), [...host.routes.keys()].join(',') || '(empty)')

host.unload()
check('卸载后 /git-graph 路由已移除', host.routes.size === 0, [...host.routes.keys()].join(',') || '(empty)')

let remountError
try {
  plugin.apply(host, {})
} catch (error) {
  remountError = error
}
check('卸载后可以再次挂载（不会 duplicate prefix route）', remountError === undefined, remountError && remountError.message)
check('再次挂载后路由存在且唯一', host.routes.size === 1 && host.routes.has('/git-graph'), [...host.routes.keys()].join(','))
host.unload()

if (failures.length > 0) {
  console.error(`\n[lifecycle] ${failures.length} 项失败：插件没把路由清理函数交给框架。`)
  console.error('[lifecycle] 修法：把注册写成 ctx.effect(() => ctx.webServer.register({ ... }), 标签)')
  process.exit(1)
}
console.log('\n[lifecycle] 通过：路由随插件卸载一起移除。')
