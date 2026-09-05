# 适配性与兼容性声明

本文档记录 dsh-git-graph 对 DeepSeek Harness（DSH）各版本的适配策略、逐版本证据、
API 依赖面与能力披露。规则依据：DSH STORE [registry/README.md](https://github.com/AI-Scarlett/DSH-Store/blob/main/registry/README.md)（目录准入规则）
与 [automation-policy.json](https://github.com/AI-Scarlett/DSH-Store/blob/main/registry/automation-policy.json)、
官方 [build-dsh-plugin](https://github.com/AI-Scarlett/build-dsh-plugin) 契约。

## 1. 规则要点（为什么这样维护）

- 官方明示 DSH 处于 developer preview：**可能存在破坏性变更**；稳定公开面为
  插槽系统（`slots`）、服务注入（`webServer` 等）、清单格式（`dsh.plugin.json` + package.json `dsh` 字段）。
- DSH STORE 每 8 小时以「官方 npm `@deepseek-ai/dsh` 的 latest + 前两个未弃用发行版」
  为滚动窗口复检；窗口内**至少 1 个精确 `dshReleases: "compatible"` 记录**才保持
  approved，全部 unknown/incompatible/缺失 → 自动 `unlisted`（issue #205 场景）。
- 范围声明（`dsh.compatibility.dsh`）不能替代逐版本精确记录；未声明版本显示 `unknown`。
- `dshReleases` 键必须是**真实存在的完整 SemVer 发行版**；值只接受
  `compatible` / `incompatible` / `unknown`。
- 声明是「来源兼容声明」，**不等于**安装/启动/卸载/回滚验收；`dshOperations`
  证据另行记录（见下表）。
- 每次插件改代码 / DSH 出新版本：先跑 `node scripts/check-compat.mjs`，有缺口就
  在隔离环境实测后补声明、提升插件版号、推送。

## 2. 逐版本证据矩阵

证据等级（build-dsh-plugin E0–E5 约定）：

- E3 = 一次性隔离 DSH_HOME 的安装 / 配置合成 / 卸载（不触碰真实 `~/.dsh`）
- E4 = 真实 profile 中的安装 / 启动 / 可见 UI / 卸载
- `—` = 该行尚无独立证据（状态如实呈现，不臆测）

| DSH 版本 | 声明 | install | start | uninstall | rollback | 证据日期 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1.2-alpha.3 | compatible | — | — | — | — | 声明于 2026-09-04 |
| 0.1.2-alpha.4 | compatible | E4（真实 profile 安装并运行） | E4（本机 web GUI 中「Git 图谱」标签加载图谱，v0.13 验证） | — | — | 2026-09-04（运行验证） |
| 0.1.2-alpha.5 | compatible | E3：隔离 DSH_HOME 安装通过（`dsh plugin --profile web add`，pnpm link） | E3：`--dump-config` 合成树含 `git-graph`（apply 配置生效） | E3：`plugin remove` 后合成树已清理 | — | 2026-09-05 |
| 0.1.2-rc.1 | compatible | E3：隔离 DSH_HOME 安装通过（`dsh plugin --profile web add`，pnpm link） | E3：`--dump-config` 合成树含 `git-graph`（apply 配置生效） | E3：`plugin remove` 后合成树已清理 | — | 2026-09-05 |

> rollback：插件本体不实现 DSH 进程级回滚；商城安装走 DSH 官方 CLI + 固定 Commit，
> 回滚/卸载由 DSH-Store 的生命周期管理提供（其规则要求 install/start/uninstall/rollback
> 四项逐版本证据，缺项保持 unknown）。插件内置自更新（autoupdate）自带备份回滚
> （`.bak-<ts>` 目录 + 失败恢复），见 README「自动更新」。

### 隔离复测方法（alpha.5 / rc.1）

```powershell
# scripts/compat-isolated-test.ps1：每个版本独立 DSH_HOME，执行
#   npm i @deepseek-ai/dsh@<ver> → dsh plugin --profile web add <本仓库> →
#   dsh --profile web --dump-config（断言包含 git-graph）→ plugin remove → 再断言已清理
powershell -File scripts/compat-isolated-test.ps1
```

## 3. 对 DSH 的 API 依赖面

### 官方公开面（版本间稳定，升级时优先跟随这里）

| 依赖 | 形式 | 位置 |
| --- | --- | --- |
| `webServer` 服务注入 + `register({kind:'prefix'})` | 官方 Host 服务（`dsh-host-webserver`） | `index.js` |
| `slots` 插槽 + `conversation.view`（`scope: session`，框架注入 `sessionId` props） | 官方插槽系统（`dsh-client-ui-slots`/runner） | `client.js` |
| `dsh.plugin.json` 清单 + package.json `dsh.client.inject/platform` / `dsh.bundle.patch` | 官方 manifest 契约 | 仓库根 |
| `engines.node` | STORE 自动批准要求（Node 兼容声明） | `package.json` |

### 内部面（非稳定契约，均有回落/容错）

| 依赖 | 说明 | 容错策略 |
| --- | --- | --- |
| 浏览器端 `/api/session/list` Remote（内部 RPC，`namespace/method` + `args._request`） | 用于解析当前会话工作区 cwd；官方 UI 同款通道但非发布契约 | v0.13 起：① 首选 iframe `?sid=`（官方注入）精确匹配；② RPC 失败 `console.warn` 且回落「最近活跃会话」启发式；③ 全部失败 → 空态 + 手动打开，不影响使用 |
| 自更新（`git ls-remote --tags` + codeload zip + bsdtar） | 作者自有渠道，绕过商城更新流 | 失败自动回滚备份；商城来源安装不受影响 |
| 服务端 `execFile` 调用系统 git | 外部进程能力 | 固定参数数组、无 shell；只读路径白名单 |

## 4. 能力披露（DSH STORE 权限信号）

| 能力 | 信号 | 说明 |
| --- | --- | --- |
| 文件系统读取 | files | 只读：会话工作区发现、`.git` 检测、目录浏览 |
| 执行外部命令 | commands | 仅调用系统 `git`（固定参数，无 shell）；`reveal` 打开系统文件管理器 |
| 网络 | network | 自更新（GitHub tags/codeload）、`fetch`/`pull`/`push`（经 git） |
| 凭据 | credentials | 无直接凭据读写；git 使用 DSH 主机已有 git 凭据 |
| 生命周期脚本 / 运行时依赖 | 无 | 无 preinstall/install/postinstall/prepare |
| 修改 DSH 核心 / `@deepseek-ai/*` / 官方插件 | 无 | 不触碰 |

据 automation-policy.json，具备 file/network/commands 中任一项即**不属于**
`source-verified` 自动批准面，商城按 `user-reviewed` 展示实际变化并逐次确认。

## 5. 版本节奏

1. 功能改动 → 同步 `package.json` / `dsh.plugin.json` version → `git commit` → `git tag vX.Y`
2. 每次发版前跑 `node scripts/check-compat.mjs`；有缺口先补 `dshReleases`
3. DSH 官方新版本发布后：隔离实测（脚本见上）→ 更新本表证据 → 补声明 → 发版

## 6. 变更历史

- v0.12.0：补齐 `dsh.compatibility`（范围 + alpha.3/4/5 精确声明），恢复 DSH STORE 收录
- v0.13.0：修复会话工作区识别（session/list RPC 格式）+ 空态一键扫描当前目录仓库
- v0.13.1：声明覆盖 `0.1.2-rc.1`（官方窗口滚动），新增 `check-compat.mjs` 与本文档