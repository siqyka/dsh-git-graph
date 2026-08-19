# AGENTS.md — dsh-git-graph 开发指南

本文件面向在本仓库中工作的 AI 代理与人类开发者，说明项目结构、开发流程与约定。

## 项目是什么

dsh-git-graph 是 DeepSeek Harness (DSH) Web GUI 的嵌入式 Git 仓库图谱可视化插件：

- **会话页「Git 图谱」标签**：注册到 `conversation.view` 插槽，iframe 内嵌独立页面（`web/index.html`）
- **服务端只读 git API**：`execFile` 固定参数执行（无 shell），仓库路径白名单 + 会话工作区发现
- **未提交改动**：图谱顶部常驻区块（`#wdPanel`），VSCode 风格分组文件列表 + 按需加载单文件 diff

## 目录结构

```
├── index.js          # 服务端（Host 半）：注册 /git-graph 前缀路由
├── client.js         # 客户端（浏览器半）：仅注册 conversation.view 标签
├── web/index.html    # 图谱页面（iframe 独立页，全部逻辑内联 <script>）
├── package.json      # npm 清单（dsh.client.inject + dsh.bundle.patch）
├── dsh.plugin.json   # DSH 官方插件清单（id: dsh-external/dsh-git-graph）
├── cordis.patch.yml  # profile 挂载点（config.repo 为仓库白名单，示例路径）
├── sync-deploy.ps1   # 同步到本地 DSH 部署目录（-Dst 参数 / $env:DSH_GIT_GRAPH_DST）
├── assets/           # README 演示截图
├── README.md / README_EN.md
└── LICENSE           # MIT
```

## 服务端 API（index.js）

`GET /git-graph/api?op=<op>&repo=<path>[&...]`，op 列表：

| op | 用途 | 关键参数 |
| --- | --- | --- |
| `repos` | 会话工作区向上定位 git 根 + 白名单兜底（白名单与「打开文件夹」添加的仓库中，失效/非 git 的路径都会被过滤剔除，返回列表按 normKey 大小写去重）；`add` 重复参数重新注册客户端持久化的「打开文件夹」仓库 | `ws`、`add`(可多个) |
| `graph` | 提交历史（topo 序，含 refs 装饰） | — |
| `branches` | 本地/远程/标签 refs | — |
| `workstatus` | 未提交改动分组列表（porcelain -z + numstat -z） | — |
| `workfile` | 单文件 diff / 未跟踪内容 | `file`、`staged`(`0`\|`1`\|`untracked`)、`old`(重命名旧路径) |
| `gitop` | 写操作：`stage`/`stage-all`/`unstage`/`unstage-all`/`discard`/`discard-all`/`commit`/`ignore`/`tag`/`tag-delete`/`tag-rename`/`branch`/`fetch`/`pull`/`push`/`checkout`/`delete-branch` | `action`、`file`(可多个)、`message`、`all`、`name`、`newname`、`hash`、`branch` |
| `filelog` | 单文件提交历史（--follow 跟踪重命名） | `file` |
| `reveal` | 在系统文件管理器中打开仓库目录 | — |
| `remoteinfo` | origin 远程 → web 基址（`https://…`，SSH/scp 语法归一化），无远程返回 `web:null` | — |
| `suggestmsg` | 依据工作区 diff 统计生成提交信息候选（启发式，无外部 AI 调用） | — |
| `checkupdate` | 对比本地版本与 GitHub 最新 tag（`git ls-remote --tags`，复用 git 全局代理/sslBackend/version 配置），返回 `{current, latest, hasUpdate}` | — |
| `autoupdate` | 一键自更新：`git clone --depth 1 --branch <tag>` 下载到临时目录 → 校验 `index.js`/`web/index.html` → 同级目录备份（`<插件目录>.bak-<ts>`，`pruneBackups` 保留最新 1 份）→ 清空并替换 → 需重启 dsh web 生效；失败自动回滚备份 | `tag` |
| `listdir` | 「打开文件夹」目录浏览（只读）：列出子目录（不含文件，跳过 `.git`），每项 `git` 标记=存在 `.git` 条目；无 `path` 时返回盘符列表（win32）或 `/`；返回 `root`（`findGitRoot` 结果，供前端判断「打开此文件夹」可用性）；超 500 项截断 | `path` |
| `addrepo` | 「打开文件夹」确认添加：对路径 `findGitRoot` 向上定位仓库根 → 加入可访问集合（`recentKeys`）→ 返回 `{repo}`；非 git 仓库报 `not-a-git-repo` | `path` |
| `show` / `diff` / `filediff` | 提交详情 / 完整补丁 / 单文件 diff | `hash`、`file` |

## 关键约定

- **安全**：git 一律 `execFile` 固定参数数组，绝不拼接 shell；`workfile`/`gitop` 的文件路径用 `path.resolve` + `startsWith` 防穿越；长输出截断（`MAX_DIFF_CHARS`）；`gitop` 是**写操作**，客户端必须在破坏性动作（discard / commit）前弹确认框，暂存类可逆操作可直接执行
- **写操作刷新流**：`gitop` 成功后清空 `wdDiffCache` → `refreshWorkdir()`；`commit` 等改变历史/分支的操作用 `reloadGraphLight()`（不重新解析会话工作区）
- **diff 高亮**：统一用 `highlightDiff(pre, text)` 渲染 diff（行级 `.df-head/.df-hunk/.df-add/.df-del`）；未跟踪内容/错误信息仍用 `pre.textContent`
- **分页**：`graph` op 支持 `limit`/`skip` + `total`（rev-list --count）；客户端 `PAGE=200`，`LOADED`/`TOTAL` 跟踪进度，`render()` 末尾按 `TOTAL > LOADED` 渲染「加载更多」按钮，`loadMore()` 追加去重
- **状态记忆**：`loadStored/saveStored` 封装 localStorage；键统一 `gg2-` 前缀（v0.8 起）：`gg2-theme`、`gg2-wdshow`（分组开关）、`gg2-wdfolded`（面板折叠）、`gg2-wdgroupfolded`（组折叠）、`gg2-brfolded`（分支组折叠）、`gg2-bfilter`（分支过滤勾选 refnames，null=全选）；分支过滤按 refname 记忆（sha 会变）。v0.11 新增：`gg2-repos`（「打开文件夹」添加的仓库路径数组，每次 `load()` 通过 `repos?add=` 重新注册到服务端）、`gg2-currepo`（上次选择/打开的仓库，加载时优先选它）
- **打开文件夹**（v0.11）：客户端 `listdir`/`addrepo` 走「📂 打开」按钮或空态按钮（`#btnOpenDir`/`#btnOpenDirEmpty`）；选中文件夹 `addrepo` 成功 → 写入 `gg2-repos`/`gg2-currepo` → `REPO=新仓库` → `load()` 全量重载；空态时 `REPO` 为 null 且 `api()` 不带 repo 参数，服务端 `listdir`/`addrepo`/`repos` 在 repo 校验之前处理，无碍
- **右键菜单**：无害操作（复制/查看详情/打标签/从提交新建分支/打开 GitHub 提交页/复制仓库路径/打开文件夹）；写操作走 `gitop`（tag / tag-delete / tag-rename / branch），`remoteinfo` 失败或无远程时 GitHub 项给出提示
- **远程/分支操作**（v0.9）：顶栏 `⬇ 拉取`（`gitop fetch` = `git fetch --all --prune`）+ `⬆ 推送`（`gitop push` 当前分支，确认框「确认推送」）；分支组头右键菜单——本地分支：🔄 切换（`checkout`，有未提交改动时先确认）、⬆ 推送该分支、🗑️ 删除（`delete-branch`，`-d` 拒绝未合并分支，HEAD 分支禁止删除）；远程分支：⬇ 拉取、复制远程分支名。fetch/pull/push 用 120s 超时（`runGit` 第 4 参）；**远程组头始终生成**——chain 为空（无独有提交）时仍显示组头，标签区分「已同步」（tip 等于同名本地分支）与「已包含」（提交全部由其他组显示）
- **自更新**（v0.10）：`load()` 后静默调 `checkForUpdate(true)`；有新版时顶栏显示 `🔄 新版本 vX.Y` 按钮（`#btnUpdate`），点击 → 确认框「发现新版本」→ `autoupdate` → 提示重启生效；手动点击按钮在无更新时提示已最新；版本号取自 `package.json` 的 `version` 字段（远程地址在 `repository.url`）
- **标签管理**：打标签对话框（`openTagDlg`）列出该提交已有标签，每行 ✎ 改名（`tag-rename`：先建新名于同 commit 再删旧名）+ ✕ 删除（`tag-delete`，确认框按钮「确认删除」）；`confirmDialog(title, body, danger, okLabel)` 支持自定义确认按钮文字
- **批量操作**：行复选框选择（`WD_SELECT`，键 `groupKey\0path`）→ `updateBatchBar()` 渲染批量条（暂存/取消暂存/还原/忽略/提交选中）；`commit` 带 `file` 时只暂存并提交这些文件（selective commit）；`ignore` = 追加 `.gitignore`（去重）+ 已跟踪文件先 `git rm --cached`（保留磁盘文件）；写操作成功后统一 `WD_SELECT.clear()`；「放弃/还原」统一叫**还原**（`discardConfirm`，确认框标题「还原更改」）
- **客户端**：纯 JS + `React.createElement`（无 JSX/TSX 转换）；Slot 注册用 `ctx.slots.register`；`inject` 只声明实际使用的服务
- **页面**：内联脚本 `"use strict"`；API 失败统一 `{ok:false, error}`；主题变量用 `--bg/--text/...` + `html.gg-light`；v0.8 起 **8 种风格方案**（🌸 樱花/🌊 海洋/🌲 森林/🌙 夜空/🍬 糖果/💼 商务/✨ 星河/🤖 科技，移植自拾光记）各带 `#ggDeco` 背景装饰（花瓣/波浪气泡鱼/树草萤火虫/星星月亮流星/彩虹彩带/几何玻璃/地球/电路齿轮），`renderBgDecor()` 按当前风格动态生成，仅彩色风格启用；**`#graphWrap` 背景必须保持透明**（否则实色背景会盖住装饰层），header/statsBar/statusLine 用 `position:relative; z-index:1` 保证内容可读、弹层（菜单 30/40、对话框 60）在其上
- **快捷键**：`Ctrl+/` 开关快捷键面板（`#shortcutDlg`）、`Ctrl+F` 聚焦搜索、`Ctrl+B` 折叠/展开全部分支组、`↑/↓`+`j/k` 导航、`Enter` 详情、`Esc` 关闭；提交对话框内 `✨ AI 生成提交信息` 调 `suggestmsg` 填充候选（可编辑）
- **分支过滤语义**：不勾选的分支其提交与分组头完全隐藏；`visibleSet()` 返回空集时显示空列表（禁止回落全显）；`buildRows(vis)` 对本地与远程分支都生成可折叠分组——**过滤激活时，tip 不在可见集的分支直接跳过且不标记 seen**（否则其祖先提交会被吞掉，导致共享该祖先的可见分支组变空），leftovers 也按可见集过滤（已完全合并进已显示提交的分支不重复生成）
- **未提交改动**：常驻图谱顶部 `#wdPanel`（`refreshWorkdir` 拉取 workstatus 并渲染面板 + 状态栏）；分组（staged 按 X 码、unstaged 按 Y 码、`??` 为未跟踪、冲突码 `U`）；`workfile` 按需加载 + 客户端缓存（`wdDiffCache`）；无改动时显示「✓ 工作区干净」；分组显隐由 `WD_SHOW` 控制（顶栏 ☑ 分组菜单），面板/分组折叠用 `WD_FOLDED` / `WD_GROUP_FOLDED`；`#wdPanel` 禁止加 `overflow:hidden`（会裁切绝对定位的分组菜单）
- **解析细节**：`porcelain -z` 重命名两条记录（`XY <新路径>` + `<旧路径>`）；`numstat -z` 重命名为 `n\tn` + 旧路径 + 新路径；Windows 路径先 `replace(/\\/g,'/')` 再比较

## 开发与验证流程

1. 修改源码（`index.js` / `client.js` / `web/index.html`）
2. 语法校验：
   - `node --check index.js client.js`
   - `web/index.html` 内联脚本：提取 `<script>…</script>` 内容后 `node --check`
3. 同步到部署目录：`.\sync-deploy.ps1 -Dst <你的部署目录>`
4. `index.js` / `client.js` 改动需重启 dsh web；`web/index.html` 刷新即生效
5. 服务端功能测试：构造场景仓库（staged / unstaged / untracked / rename / MM / 删除），用 mock `webServer` 直接调 handler 断言 JSON；页面级用临时 http server + 浏览器验证
6. 版本节奏：功能迭代 → `package.json` / `dsh.plugin.json` version 同步 → `git commit` → `git tag vX.Y`

## 注意

- 提交前检查：不要把本地绝对路径（如 `D:/...`、`C:\Users\<用户名>\...`）写进 `cordis.patch.yml` / `sync-deploy.ps1` / README —— 开源仓库使用示例路径占位
- `.gitignore` 已排除 `node_modules/`、`*.log`、`.DS_Store`、`.playwright-mcp/`（浏览器测试残留）
- **编码铁律（教训：BOM 曾导致 Harness 启动崩溃）**：任何 `.json` / `.yaml` / `.yml` 配置文件必须 **UTF-8 无 BOM** 保存。PowerShell 5.1 的 `Set-Content -Encoding utf8` / `Out-File -Encoding utf8` **会写 BOM**（UTF8 带 BOM）——JSON.parse 严格模式不接受 BOM，会导致 `readProfileManifest → JSON.parse` 抛 `SyntaxError: Unexpected token`，Harness 启动失败。**正确写法**：
  - 读：`[System.IO.File]::ReadAllText($path)`（自动处理编码，若需去 BOM 用 `.TrimStart([char]0xFEFF)`）
  - 写：`[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))`（`$false` = 无 BOM）
  - 或 PowerShell 7+：`Set-Content -Encoding utf8NoBOM`
  - 写完必须校验：读回字节前 3 字节 ≠ `EF BB BF`
- **profile 依赖链**：profile 的 `package.json` 用 `file:` 依赖指向 `C:/Users/18412/.dsh/plugins/git-graph`（源目录），pnpm 安装时复制到 `node_modules/dsh-git-graph`（hoisted 副本）。**两处都要同步**：`sync-deploy.ps1` 同步 node_modules 副本 + 手动同步 `.dsh/plugins/git-graph` 源目录（否则下次 `pnpm install` 会用旧源覆盖副本）。`.dsh/plugins/git-graph` 不在本仓库，不参与 git
