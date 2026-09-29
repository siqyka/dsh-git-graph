# 适配性与兼容性声明

本文档记录 dsh-git-graph 对 DeepSeek Harness（DSH）各版本的适配策略、逐版本证据、
API 依赖面与能力披露。

## 1. 规则要点（为什么这样维护）

- 官方明示 DSH 处于 developer preview：**可能存在破坏性变更**；稳定公开面为
  插槽系统（`slots`）、服务注入（`webServer` 等）、清单格式（package.json `dsh` 字段）。
- **官方原生兼容闸门（v0.14.0 起采用）**：
  - `engines.dsh`（顶层，与 `engines.node` 并列）— 作者声明的兼容 SemVer 范围，
    官方 loader 目前不强制，但插件市场类工具（如 dsh-plugin-manager 的更新检查）会读取；
  - `peerDependencies["@deepseek-ai/dsh"]` — **强制闸门**：DSH ≥0.2.0 在 profile
    组合与 `dsh plugin add` preflight 时按此校验，不满足直接拒绝安装 / 启动失败
    （可被 profile 的 `compatibility.json` 白名单豁免）；
  - `peerDependenciesMeta` 标记 optional，避免 npm/pnpm 自动安装 peer 本体；
  - `dsh.manifestVersion: 1` 声明清单格式版本。
- 本插件两个范围均声明 `>=0.1.0-rc.6 <0.3.0`，锚点版本隔离实测见下表。
- 历史：v0.13.1 及以前用自建字段 `dsh.compatibility.dshReleases`（AI-Scarlett/DSH-Store
  目录的逐版本声明约定）。官方 0.2.0 引入原生 peerDependencies 闸门后，该字段
  已在 v0.14.0 移除，检查脚本迁移为官方窗口语义（latest + next 双轨）。
- 声明是「来源兼容声明」，**不等于**安装/启动/卸载验收；逐版本证据另行记录（见下表）。
- 每次插件改代码 / DSH 出新版本：先跑 `node scripts/check-compat.mjs`，有缺口就在
  隔离环境实测后修正范围、提升插件版号、推送。

## 2. 逐版本证据矩阵

证据等级（build-dsh-plugin E0–E5 约定）：

- E3 = 一次性隔离 DSH_HOME 的安装 / 配置合成 / 卸载（不触碰真实 `~/.dsh`）
- E4 = 真实 profile 中的安装 / 启动 / 可见 UI / 卸载
- `—` = 该行尚无独立证据（状态如实呈现，不臆测）

| DSH 版本 | 声明 | install | start | uninstall | rollback | 证据日期 |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1.2-alpha.4 | >=0.1.0-rc.6 <0.3.0 | E4（真实 profile 安装并运行） | E4（本机 web GUI 中「Git 图谱」标签加载图谱，v0.13 验证） | — | — | 2026-09-04（运行验证） |
| 0.1.2-alpha.5 | 同上 | E3：隔离 DSH_HOME 安装通过（`dsh plugin --profile web add`） | E3：`--dump-config` 合成树含 `git-graph` | E3：`plugin remove` 后合成树已清理 | — | 2026-09-05 |
| 0.1.2-rc.1 | 同上 | E3：同上 | E3：同上 | E3：同上 | — | 2026-09-05 |
| 0.1.7-rc.2（npm latest） | 同上 | E3：隔离 DSH_HOME，`dsh plugin add link:<仓库>` 通过 | E3：`--dump-config` 合成树含 `# == dsh-git-graph` | E3：`plugin remove` 后合成树已清理 | — | 2026-09-29 |
| 0.2.0-rc.1（npm next） | 同上 | E3：同上；add preflight 按 `peerDependencies` 校验通过 | E3：同上 | E3：同上 | — | 2026-09-29 |

另：0.2.0-rc.1 真实 profile E4——`link:` 挂载本仓库后 `dsh web` 启动，`/git-graph/index.html`
与 `/git-graph/api?op=repos` 返回 200，SPA 启动 payload 含 `dsh-git-graph`（2026-09-29）。

> rollback：插件本体不实现 DSH 进程级回滚；商城安装走 DSH 官方 CLI + 固定 Commit，
> 回滚/卸载由 DSH-Store 的生命周期管理提供（其规则要求 install/start/uninstall/rollback
> 四项逐版本证据，缺项保持 unknown）。插件内置自更新（autoupdate）自带备份回滚
> （`.bak-<ts>` 目录 + 失败恢复），见 README「自动更新」。

### 隔离复测方法

```powershell
# scripts/compat-isolated-test.ps1：每个版本独立 work/node_modules + 独立 DSH_HOME，
#   npm i @deepseek-ai/dsh@<ver> → dsh plugin --profile web add link:<插件> →
#   dsh --profile web --dump-config（断言包含 git-graph）→ plugin remove → 再断言已清理。
# 版本可参数化；需 pwsh 7（PowerShell 5.1 会把无 BOM UTF-8 按 ANSI 解码）。
pwsh -File scripts/compat-isolated-test.ps1                       # 默认锚点：0.1.7-rc.2 + 0.2.0-rc.1
pwsh -File scripts/compat-isolated-test.ps1 -Versions 0.2.0-rc.1  # 只测一个版本
```

原始日志样例（2026-09-29 两锚点版本全绿）：`%TEMP%\dsh-compat-v0140\run.log`
（临时目录，重跑脚本会重建；结论摘录保留在上表）。

## 3. 对 DSH 的 API 依赖面

### 官方公开面（版本间稳定，升级时优先跟随这里）

| 依赖 | 形式 | 位置 |
| --- | --- | --- |
| `webServer` 服务注入 + `register({kind:'prefix'})` | 官方 Host 服务（`dsh-host-webserver`） | `index.js` |
| `slots` 插槽 + `conversation.view`（`scope: session`，框架注入 `sessionId` props） | 官方插槽系统（`dsh-client-ui-slots`/runner） | `client.js` |
| package.json `dsh.client{platform,inject}` / `dsh.bundle.patch` / `dsh.manifestVersion` | 官方 manifest 契约（`dsh-package-manifest`） | `package.json` |
| `engines.dsh` + `peerDependencies["@deepseek-ai/dsh"]` | 官方兼容声明（后者 0.2.0 起强制闸门） | `package.json` |
| `engines.node` | Node 兼容声明 | `package.json` |

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

1. 功能改动 → 同步 `package.json` version → `git commit` → `git tag vX.Y`
2. 每次发版前跑 `node scripts/check-compat.mjs`（官方 latest + next 发行窗口覆盖检查）；
   有缺口先修正 `engines.dsh` / `peerDependencies` 范围并隔离实测
3. DSH 官方新版本发布后：`pwsh -File scripts/compat-isolated-test.ps1 -Versions <新版本>`
   隔离实测 → 更新本表证据 → 必要时收窄/修正范围 → 发版
4. npm 发布：`npm run publish:npm`（scope 包名 + 官方 registry，发布前自动跑检查链）

## 6. 变更历史

- v0.12.0：补齐 `dsh.compatibility`（范围 + alpha.3/4/5 精确声明），恢复 DSH STORE 收录
- v0.13.0：修复会话工作区识别（session/list RPC 格式）+ 空态一键扫描当前目录仓库
- v0.13.1：声明覆盖 `0.1.2-rc.1`（官方窗口滚动），新增 `check-compat.mjs` 与本文档
- v0.14.0：迁移到官方原生兼容声明（`engines.dsh` + `peerDependencies` 强制闸门 + `dsh.manifestVersion: 1`），
  移除自建 `dsh.compatibility.dshReleases` 与 `dsh.plugin.json`；自更新按挂载形态降级
  （git 工作区挂载 → `git pull` 提示）；锚点版本 0.1.7-rc.2 / 0.2.0-rc.1 隔离实测通过；
  准备 npm（scope）+ GitHub topic 双通道发布