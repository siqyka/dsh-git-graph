# AGENTS.md — dsh-git-graph 开发指南

本文件面向在本仓库中工作的 AI 代理与人类开发者，说明项目结构、开发流程与约定。

## 项目是什么

dsh-git-graph 是 DeepSeek Harness (DSH) Web GUI 的嵌入式 Git 仓库图谱可视化插件：

- **会话页「Git 图谱」标签**：注册到 `conversation.view`，iframe 内嵌独立页面（`web/index.html`）
- **服务端 git API**：`execFile` 固定参数执行（无 shell），仓库路径白名单 + 会话工作区发现
- **未提交改动**：顶部常驻 `#wdPanel`，VSCode 风格分组文件列表 + 按需加载单文件 diff

## 目录结构

```
├── index.js          # 服务端（Host 半）：/git-graph 前缀路由
├── client.js         # 客户端（浏览器半）：注册 conversation.view 标签
├── web/index.html    # 页面骨架（iframe 独立页，markup + 两个资源引用）
├── web/app.css       # 样式（外部表，CSP style-src 'self'）
├── web/app.js        # 页面逻辑（外部脚本，CSP script-src 'self'）
├── package.json      # npm 清单（dsh.client + dsh.bundle.patch + engines.dsh + peer deps）
├── cordis.patch.yml  # profile 挂载点（默认不带 config.repo，白名单示例见注释）
├── scripts/          # check-compat / check-lifecycle / check-remote（纯 mock）/ check-remote-live（真机）
│                     # / check-remote-ui（Chrome+CDP）/ check-degrade（无桥时本地回归）/ publish.mjs
├── assets/           # README 演示截图
├── docs/             # 兼容性与安全审计证据
├── README.md / README_EN.md
└── LICENSE           # MIT
```

## 服务端 API（index.js）

`GET /git-graph/api?op=<op>&repo=<path>[&...]`，op 列表：

写操作（`gitop` / `autoupdate` / `addrepo` / `prefswrite`）必须用 **POST**，其余为 GET。
服务端对写 op 校验 `req.method`，GET 直接 405（v0.21 起，见下方安全防护）。

| op | 用途 | 关键参数 |
| --- | --- | --- |
| `repos` | 会话工作区向上定位 git 根 + 白名单兜底（失效/非 git 的路径被剔除，按 normKey 去重）；`add` 重复参数重新注册客户端持久化的「打开文件夹」仓库；另返回 `wsRemote`/`wsProbe` | `ws`、`add`(可多个) |
| `graph` | 提交历史（含 refs 装饰）；`order=date` 用 `--date-order`（平铺视图），缺省 `--topo-order`（分组视图）；`head` 由 `.git/HEAD` 直读不额外起进程；`total` 首屏问一次 `rev-list --all --count`，之后由客户端 `total=` 回传 | `limit`、`skip`、`total` |
| `head` | 轻量变更探测（每 5s 轮询用）：**0 spawn**，`readRefsFromDisk` 直接读盘，返回所有本地/远程 ref tip 的稳定签名 `sig`（含 ref 名，可发现新提交/分支移动/删除/强推）；读盘失败才回退 `for-each-ref` | — |
| `branches` | 本地/远程/标签 refs，**0 spawn**（`readRefsFromDisk`；`packed-refs` + 松散 `refs/**`，松散覆盖打包，符号引用两遍解析）；读盘失败回退 `for-each-ref` | — |
| `count` | 提交总数（`rev-list --all --count`），供「已显示 50 / 241」标签；从 `graph` 拆出以便首屏不等它。旧宿主无此 op → 客户端 `COUNT_OP_OK` 回退 | — |
| `prefs` / `prefswrite` | UI 偏好持久化（分支过滤/折叠/主题）。`prefs` 读全部；`prefswrite`（**POST**）用 `set=<JSON>` 合并写入，仅接受白名单 key，`null` 删除该 key。落盘 `<插件目录>/.state/prefs.json`（gitignore），跨端口/重启有效 | `set` |
| `workstatus` | 未提交改动分组列表：分支名取自 `status --branch` 的 `## ` 头记录（不再单独 `rev-parse`）；无暂存/无未暂存改动时**跳过对应的 numstat 调用**（干净工作区 1 次进程而非 3 次） | — |
| `workfile` | 单文件 diff / 未跟踪内容 | `file`、`staged`(`0`\|`1`\|`untracked`)、`old`(重命名旧路径) |
| `gitop` | 写操作：`stage`/`stage-all`/`unstage`/`unstage-all`/`discard`/`discard-all`/`commit`/`ignore`/`tag`/`tag-delete`/`tag-rename`/`branch`/`fetch`/`pull`/`push`/`checkout`/`delete-branch` | `action`、`file`(可多个)、`message`、`all`、`name`、`newname`、`hash`、`branch` |
| `filelog` | 单文件提交历史（--follow 跟踪重命名） | `file` |
| `reveal` | 在系统文件管理器中打开仓库目录 | — |
| `remoteinfo` | origin 远程 → web 基址（`https://…`，SSH/scp 语法归一化），无远程返回 `web:null` | — |
| `suggestmsg` | 依据工作区 diff 统计生成提交信息候选（启发式，无外部 AI 调用） | — |
| `checkupdate` | 对比本地版本与 GitHub 最新 tag（`ls-remote --tags`，复用 git 全局代理/sslBackend 配置），返回 `{current, latest, hasUpdate, managed}`；插件目录在 git 工作区内时 `managed:'git'`、`hasUpdate` 强制 false、`latest` 置空 | — |
| `autoupdate` | 一键自更新：`git clone --depth 1 --branch <tag>` 到临时目录 → 校验 `index.js` / `web/index.html` / `web/app.css` / `web/app.js`（缺任一即 `missing-*` 中止，旧安装不动）→ 同级备份（`.bak-<ts>`，`pruneBackups` 留最新 1 份）→ 清空替换 → 重启 dsh web 生效；失败自动回滚；git 工作区挂载时 409 `git-managed` | `tag` |
| `listdir` | 「打开文件夹」目录浏览（只读）：列出子目录（跳过 `.git`），每项 `git` 标记=存在 `.git` 条目；无 `path` 时返回盘符列表（win32）或 `/`；返回 `root`（`findGitRoot` 结果）供前端判断可用性；超 500 项截断 | `path` |
| `addrepo` | 「打开文件夹」确认添加：对路径 `findGitRoot` 向上定位仓库根 → 加入可访问集合（`recentKeys`）→ 返回 `{repo}`；非 git 仓库报 `not-a-git-repo` | `path` |
| `show` / `diff` / `filediff` | 提交详情 / 完整补丁 / 单文件 diff（`filediff` 也是单次 `show --no-color --format= <hash> -- <file>`，不要先查父提交） | `hash`、`file` |

## 关键约定

- **安全**：git 一律 `execFile` 固定参数数组，绝不拼接 shell；`workfile`/`gitop` 路径用 `resolve` + `startsWith` 防穿越（远端走 `resolveRemoteFile`）；长输出截断（`MAX_DIFF_CHARS`）；`gitop` 是**写操作**，破坏性动作前必须确认，暂存类可直接执行
- **安全防护（v0.21，见 `docs/security-audit-2026-11-05.md`）**：以下几条是安全审计后**必须保持**的约束，改代码时不要绕过：
  - **写操作必须 POST**：`WRITE_OPS = {gitop, autoupdate, addrepo, prefswrite}` 在**服务端**（`index.js`）与**客户端**（`web/index.html` 的 `api()`）各有一份，必须同步。服务端对写 op 校验 `req.method === 'POST'`，GET 直接 405。这是 CSRF 的主防线——`<img>`/`<a>` 发不出 POST。
  - **Origin/Referer 同源校验**：任一存在且与 `Host` 不符就 403 `cross-origin-blocked`。没有这两个头的请求（curl、测试、插件自启动）放行读操作，写操作仍需 POST。
  - **`remoteinfo` 只准 http(s)**：`isSafeWebUrl()` 用 `new URL()` 解析后比对协议，`javascript:`/`data:`/`vbscript:`/`file:` 一律返回 `web:null`。**这个值会进 `window.open()`**，绝不能直接回显 remote 原文。
  - **拒绝响应不泄露路径**：`repo-not-allowed` 只返回 `count`，不再回显 `repos` 数组（曾把本机全部仓库绝对路径回给调用方）。
  - **HTML 插值必须 `escHtml()`**：文件名/分支名/标签名都来自仓库，属不可信输入（Linux/macOS 上文件名可含 `<>`）。`confirmDialog` 的 `bodyHtml` 是唯一 `innerHTML` 注入点，**所有** repo 派生文本都要过 `escHtml`（`ignoreConfirm`/`discardConfirm`/分支名/标签名已全部覆盖）。
  - **响应头**：JSON 与页面都带 `X-Content-Type-Options: nosniff` + `no-store`；页面与两个静态资源带 CSP（`default-src 'none'` + `script-src 'self'` + `style-src 'self'`，见下条「页面拆分为三文件」）。
  - 未做 `iframe sandbox`：同源 iframe 带 `allow-scripts allow-same-origin` 等于没有隔离（可自行移除），去掉 `allow-same-origin` 又破坏 localStorage 与鉴权，负收益。
- **性能铁律：进程创建才是瓶颈（v0.16，v0.18→v0.19 逐轮补漏）**：量性能必须用 node 的 `execFile`+`hrtime`（bash 的 `date +%s%N` 会被污染成 ~440ms）。两个量级都要记住：独立 node 进程里单次 `git` 约 **217ms**；**DSH 宿主进程里约 870ms**（腾讯管家 + 亚信防毒 + Defender 把进程创建串行化了，并行无收益）。判断快慢要看「DSH 内实测」。优化只看「每个 op 起几个 git」：
  - **每个请求的公共校验绝不能起进程（v0.18 最大的一处遗漏）**：路由入口的「是不是 git 仓库」校验原本用 `await isGitRepo()`（= 一次 `git rev-parse`），排在所有 op 之前，**每个请求都白付一次 spawn**。改用 `hasGitEntry()`（`statSync(.git)`）。`isGitRepo` 现在只剩 `addrepo`（用户手动开文件夹，一次性）在用
  - **能读文件就不起进程**：分支名读 `.git/HEAD`（`readHeadName`）；**refs 全量读盘（v0.19，`readRefsFromDisk`）**——`branches` 与 5s 轮询的 `head` 都 0 spawn（871ms → 1~2ms）。要点：先读 `packed-refs` 再扫松散 `refs/**`（松散覆盖打包），**符号引用必须两遍解析**（先收集全部 ref 再解 `ref: ` 目标），否则 `origin/HEAD -> origin/master` 会取到 packed 里的旧 sha；读不出再回退 `for-each-ref`
  - **能合并就合并**：`show` 用一条 `show --stat`（meta+stat）；`filediff` 用一条 `show <hash> -- <file>`（**不要先查 `%P` 父提交**）；`workstatus` 分支名取自 `status --branch` 的 `## ` 头
  - **能跳过就跳过**：`workstatus` 干净时跳过 `numstat`（3 → 1）；`graph` 的 `total` 首屏用 `count=0` 让客户端**异步**补（新增 `count` op），翻页复用 `total=`
  - **轮询必须轻**：5s 轮询用 `head`（v0.19 起 0 spawn）
  - 改任何 op 前先估算 spawn 次数。**v0.19 后的下限：`branches`/`head` 为 0，`repos` 为 0，其余都是每次请求 1 次**
- **新 op 必须带客户端降级**：`count` 是新增 op，旧宿主返回 `unknown-op`。`refreshTotal()` 用 `COUNT_OP_OK` 记住一次失败并回退到「graph 带 total」，否则 `TOTAL` 会永久停在页长、把后面的提交全部藏掉。同理 `hasMore()` 把 `TOTAL===0` 视为「未知」而不是「没有更多」，否则 count 在飞时按钮和滚动加载会一起消失
- **`show` 解析注意**：meta 与 stat 用 `\x1e--STAT--\x1e` 标记行分隔，**不要**用 `\x1f\x1f` 之类的字段组合——root commit 的 `%P` 为空，会产生连续 `\x1f` 导致元信息被提前截断（曾因此把 subject/author 解析成空串）
- **写操作刷新流**：`gitop` 成功后清空 `wdDiffCache` → `refreshWorkdir()`；`commit` 等改变历史/分支的操作用 `reloadGraphLight()`（不重新解析会话工作区）
- **diff 高亮**：统一用 `highlightDiff(pre, text)` 渲染 diff（行级 `.df-head/.df-hunk/.df-add/.df-del`）；未跟踪内容/错误信息仍用 `pre.textContent`
- **分页与缓存（v0.17）**：`graph` 支持 `limit`/`skip` + `total`。首屏 `PAGE_INITIAL=50`，下滑续拉 `PAGE_MORE=100`（`loadMore()` 追加去重、`LOADING_MORE` 防并发、`PAGINATION_EXHAUSTED` 防空页死循环）。**只有真实滚动才续拉**：监听在 `#graphWrap`（它才 `overflow:auto`，window 的 scroll 在 iframe 收不到），`maybeAutoLoad()` rAF 节流；列表短于视口时**刻意不自动填满**，由「加载更多」兜底。`total` 只在需精确总数时才跑 `rev-list --all --count`
- **响应缓存（v0.17）**：`DETAIL_CACHE`(hash→{info,diff}) / `FILEDIFF_CACHE`(hash\0file) / `FILELOG_CACHE`(file)，`cacheGet` LRU touch、`cacheSet` 超 `PAGE_LIMIT=400` 淘汰最旧。**只放内存 Map、绝不写 localStorage**（iframe 关闭/刷新即整体销毁，`pagehide`/`beforeunload` 再调 `clearResponseCache()` 兜底 bfcache）。失效：**切换仓库**、**任意 `gitop` 成功后**；提交不可变故详情不过期。**`showFileDiff`/`showFileHist` 必须先判「是否已展开」再发请求**（否则点 ✕ 收起也白跑一次 git）
- **状态记忆**：`loadStored/saveStored` 封装 localStorage，`gg2-` 前缀：`theme`/`wdshow`/`wdfolded`/`wdgroupfolded`/`brfolded`/`bfilter-hidden`（v0.22 **隐藏** refname 黑名单，null 或 [] = 全可见）/`repos`/`currepo:<工作区>`（**按工作区分键**，加载优先）/`flat`/`detailw`（px，非法值回落 CSS 默认）
- **搜索/日期是「过滤」不是「高亮」（v0.23）**：两者都**隐藏**不匹配提交（`passesFilters()` = `matches() && withinDateRange()`），新增筛选条件只改这两个函数。**组头有坑**：`buildRows()` 在组折叠时**不产出 commit 行**，不能用「等首个通过过滤的提交再吐组头」（折叠组组头会全消失）。正确做法：`groupCounts` 按每条分支的 first-parent 链**独立**统计（**不跨分支去重**，否则 local 与 remote 双胞胎互吃计数）再决定显隐——折叠组直接输出组头，展开组用 `pendingHead` 延迟到首条提交。空态同理，不能只看 `commitRows.length === 0`。
- **日期区间按本地日边界（v0.23）**：`DATE_FROM`/`DATE_TO` 存 `YYYY-MM-DD`，比较用 `dayStart()`/`dayEnd()`——结束日按 **23:59:59.999** 计算，所以结束日当天 23:50 的提交仍然算入；任一端可空（单侧边界），两端都空 = 不限。起止选反了自动交换（不弹错误框）。持久化键 `gg2-datefrom`/`gg2-dateto`（已在服务端偏好白名单里）。
- **日期选择器是应用内日历（v0.25.1，改这块前必读）**：`<input type="date">` 已**全部移除**，`#dateMenu` 里不再有任何 `<input>`。原因是原生控件的日历弹窗由浏览器绘制，CSS 碰不到，而截图里那正是最丑的一块。
  - **草稿态与生效态分离**：面板里的 `dFrom`/`dTo` 是**草稿**，只有 `applyDateRange()` 才写进 `DATE_FROM`/`DATE_TO`。`dDirty` 表示两者是否不同，**「应用/关闭」按钮的文字和主色都由它驱动**——没有改动时按钮是次要的「关闭」，否则会是「应用」。关闭路径（点按钮、点外部、再点触发器）**有改动就应用、没改动就只关**；唯独 `Esc` **丢弃草稿**，这是唯一能放弃半截区间（只有起没有止）的出口。
  - **一个网格写两端**：`dEnd` 指明日历当前写哪一端，`#dateFromChip`/`#dateToChip` 的 `.active` 表示它。点一天写当前端，若另一端为空则**自动切换**过去，所以「先点起点再点终点」不需要手动切标签；顺序反了在 `applyDateRange()` 里统一交换，不要在 `pickDay()` 里报错。
  - **`renderCalendar()` 会重建 42 个按钮，必须自己恢复焦点**：`pickDay()` 重建后要把焦点还给同一天，否则按 Enter 选完日期 `activeElement` 变成 `<body>`，方向键立刻失效。网格用**游标式 tabindex**（只有一个 `tabIndex=0`）。
  - **面板 `position: fixed` + 显式坐标**（`positionDateMenu()` 写 `left`/`top`）：原生弹层是 `right:0; top:32px` 绝对定位，300×420px 在窄屏横向溢出、在矮窗口整块掉出屏幕（实测 420px 高时 `top: -418`）。现在按「下方够就下方 / 否则翻上方 / 都不够就夹进视口」，比视口还高时设 `maxHeight` + `overflowY: auto`。**不要退回纯 CSS 锚定**，`resize` 时也要重新调用（已挂在窗口 resize 上）。
  - **弹层打开时方向键归日历**：`window` 的 keydown 里有 `if ($("dateMenu").classList.contains("show")) return;`。少了这一条，在网格里按 ↓ 会**同时**移动焦点和背后的提交选中（列表就在旁边，看着像"按一次跳两下"）。反向验证方式：临时删掉该行，`grid owns arrows while open` 立刻变红（选中从 `0004…` 跳到 `0007…`）。
- **点外部收起弹层只有一条通路（v0.26.0，改这块前必读）**：分支过滤、日期、未提交改动的分组菜单、右键菜单，全部由**一个** `dismissPopovers()` 负责，注册在 `window` 的**捕获阶段**，且 `pointerdown` 与 `click` 各挂一次。四个必须保持的约束：
  - **必须捕获阶段，不能用 `document` 上的冒泡监听**。原先在冒泡 `click` 里做 `if (!closest(...)) close()`，而用户接着点的地方——**提交行、分支组头、`全部暂存`**——自己调了 `ev.stopPropagation()`，事件到不了 `document`，菜单不收起；更糟的是日期草稿会被**之后**某次无关点击才应用，列表拿早已放弃的日期重过滤一遍。
  - **必须同时听 `pointerdown`**：`disabled` 的 `<button>` **不派发任何** mouse/click 事件，只派发 pointer 事件。未提交改动面板的「全部暂存」「提交」在工作区干净时正是 `disabled`，点它一个事件都不产生（插桩 mousedown/mouseup/click 到 window 捕获，日志全空），菜单于是不收起。`pointerdown` 在禁用控件上照常触发。
  - **但日期草稿的应用只能放在 `click` 阶段**（踩过的回归）：`applyDateRange()` 会 `render()` 重建列表，在 `pointerdown` 里做会让被按的行在 mouseup 前销毁 → **不合成 click** → 提交没被选中（实测 `SELECTED` 仍 `null`）；`setTimeout(0)` 同样早于 mouseup。正确：`pointerdown` 只关面板并记 `dateDraftOwed`，`click` 阶段才提交；`pointerup` 再挂 `setTimeout(0)` 兜底「拖走再松手」。事件路径派发时即固定，`click` 阶段重渲染不会吞掉这一下。
  - **"里面"的判据要含触发器本身**（`.filterWrap` / `.dateWrap` / `.wd-filterWrap` / `#ctxMenu`），否则点触发器想收起时会被先关掉再被触发器自己的 handler 打开，变成关不掉。
- **两个弹层互斥**：日期面板与分支过滤**不能同时开着**（都会遮住列表）。这不是单独写的逻辑，而是上面捕获监听的副产品——打开另一个时，被点的目标不在前一个的 wrap 内，前一个就先被收起了。反向验证：旧代码上 `max=2`（两个同时开），新代码 `max=1`。
- **分支过滤菜单窄屏要夹进视口（`positionFilterMenu()`）**：它是 `position:absolute; right:0` 挂在触发器下。`≤560px` 时 header 换两行且 `.hd-center` 变 `flex-start`，触发器靠左，200px 菜单按右边缘定位会豁出去（实测 520px 时 `left=-100`，一半点不到）。现按视口夹紧，**且只在越界时才改**。两个细节：菜单 `offsetParent` 是 `.filterWrap`，写 `left` 前减去父级偏移；`resize` 时重算（与 `positionDateMenu()` 并列）。
- **偏好持久化到服务端（v0.22；v0.25.1 修「切换 tab 配置被改掉」）**：`localStorage` 按 **origin** 隔离，而 DSH web 端口每次启动可能变，换端口后 `gg2-*` 全**静默清空**——这才是「选了分支重进又没了」的真因。所以偏好同时写服务端：`op=prefs` 读、`prefswrite` 写（POST），落盘 `<插件目录>/.state/prefs.json`（gitignore）。白名单 `PREFS_ALLOWED_KEYS`（bfilter/wdshow/wdfolded/wdgroupfolded/brfolded/theme/datefrom/dateto/flat/flat-reset），其它 key 忽略；单文件上限 256KB。启动时 `prefsLoad()` 先灌回内存再首次渲染，第一帧即筛选后状态。旧宿主无 prefs op 时 `PREFS_OP_OK` 记住一次失败并降级。
- **「切换 tab 配置被改掉」的四个真因（v0.25.1，改这块前必读）**：
  - **同一份偏好在两个 store 用了两种格式**：`gg2-theme` 曾被 `setTheme()` 用**裸字符串**写，而 `prefsLoad()` 用 `saveStored`（JSON）写回，读回带引号的 `"ocean"` → `THEMES.includes` 判假 → **删键**回落 `auto`。现统一 `saveStored`，读取用 `readStoredTheme()` 同时接受两种形式。**新增 key 必须成对用 `loadStored`/`saveStored`。**
  - **`prefsLoad()` 只把主题写进 localStorage，没赋值给 `themePref`**。`themePref` 在脚本解析时就从 localStorage 初始化了，而换端口后那个 store 是空的，所以本次加载仍是 `auto`。现在末尾显式 `themePref = p["gg2-theme"]` 再 `applyTheme()`。**通用规则：状态变量必须在 `prefsLoad()` 里被赋值，只写 localStorage 等于只为"下一次加载"恢复。**
  - **一次性迁移标记只存在 localStorage 里**：`gg2-flat-reset` 丢了后 `FLAT_DEFAULT_MIGRATED` 变假，「把平铺重置为 false」的逻辑**再跑一次**，把用户选的平铺改回分组。现在该标记进白名单并持久化，且**服务端存在显式 `gg2-flat` 本身就当作"用户已选择"的证据**——有它就不重置，无论标记在不在。另外 `prefsSync` 在 `PREFS_LOADED` 之前会直接 return，所以迁移的写必须**推迟到 `PREFS_LOADED = true` 之后**（原来写在迁移分支里等于静默丢弃）。
  - **`applyFilter()` 曾无条件持久化**：`fillFilterMenu()` 每次加载都调它，于是每次加载都写一次服务端；更糟的是**没有 `.fBranch` 复选框时**（`branches` 请求失败）它从空 DOM 推出「什么都没隐藏」并写入 `[]`——**一次瞬时 git 失败就把用户的分支筛选永久清掉**。现在无复选框时只按未筛选渲染、**不动存储**，并且只在值真变了才写。
- **分支过滤存"黑名单"（v0.22）**：`HIDDEN_REFS` 存**被隐藏**的 refname（`null`/`[]` = 全可见），而不是"已勾选"。这样**新建分支默认可见**——旧方案存可见列表，新分支不在列表里就被判为隐藏，表现为"我的分支凭空消失"。`applyFilter()` 每次都从 DOM 重算黑名单并**顺带收敛**（不存在的 ref 自动剔除）。旧键 `gg2-bfilter`（可见列表）由 `migrateLegacyFilter()` 在首次拿到 `BRANCHES` 后一次性迁移成黑名单，然后删掉旧键。
- **空筛选结果必须给出口（v0.23）**：列表为空时给提示 + 出口按钮，但**判据必须区分三种空**：①分支全被隐藏 → 「恢复全选」；②搜索/日期无匹配 → 「清除筛选」（`clearFilters()`）；③**只是分支组全折叠** → 什么都不显示（这是正常状态，只按行数判断会误报）。统一用 `nothingToShow` 判定：有筛选时看 `groupCounts` 合计是否为 0，无筛选时才看行数且排除"全部折叠"的情况。

- **详情面板可调宽（v0.15）**：`#graphWrap` 与 `#detail` 之间是 `#detailGrip`（6px，仅 `#main.detail-open` 显示）。`#detail.open` 宽度取 `var(--gg-detail-w, 430px)`（CSS 是默认值真源，拖动后才写内联变量）。Pointer Events + `setPointerCapture`；拖动中加 `.no-anim` 关 160ms 过渡、`body.gg-col-resize` 改光标；宽度夹在 `[260, min(1200, mainW-520)]`；双击恢复默认、方向键 ±12 / Shift ±40、`resize` 重夹。**开关一律走 `setDetailOpen(bool)`**。程序化改宽用 `withoutDetailAnim(fn)`：`.no-anim` 必须在**下一帧**（rAF 两次）移除，同帧移除会让过渡从旧宽度重启动画
- **打开文件夹**（v0.11，v0.25 起纯图标）：`listdir`/`addrepo` 走 `#btnOpenDir`（title「打开文件夹」）或空态 `#btnOpenDirEmpty`；`addrepo` 成功 → 写 `gg2-repos`（+ `saveCurRepo`）→ `REPO=新仓库` → `load()` 全量重载；空态时 `REPO` 为 null、`api()` 不带 repo，服务端 `listdir`/`addrepo`/`repos` 在 repo 校验之前处理，无碍
- **右键菜单**：无害项（复制 / 查看详情 / 打标签 / 从提交建分支 / 打开 GitHub 页 / 复制仓库路径 / 打开文件夹）；写操作走 `gitop`（tag / tag-delete / tag-rename / branch），无远程时 GitHub 项给提示
- **远程/分支操作**（v0.9，v0.25 起纯图标）：顶栏 `#btnFetch`（`gitop fetch` = `git fetch --all --prune`）+ `#btnPush`（当前分支，确认框）；分支组头右键——本地：🔄 切换（`checkout`，有改动先确认）、⬆ 推送、🗑️ 删除（`delete-branch`，`-d` 拒绝未合并，HEAD 禁止删）；远程：⬇ 拉取、复制名。fetch/pull/push 用 120s 超时（`runGit` 第 4 参）；**远程组头始终生成**——chain 为空仍显示，标签区分「已同步」（tip 等于同名本地分支）与「已包含」。
- **跟随工作区切换（v0.20）**：图谱跑在 iframe 里，`?sid=` 在元素创建时就固定了，DSH 切换工作区时**复用同一个 iframe**（document 不重建），所以不加轮询就会一直显示旧仓库。`checkSessionWorkspace()` 每 3s 调 `resolveSessionWs()`（它优先匹配 `?sid`，无 sid 时回退「最近活跃会话」，因此独立打开页面也能跟随），`ws !== SESSION_WS` 时清缓存并 `load(ws)`。`load()` 用 `load.INFLIGHT` 防重入（切换与手动刷新可能并发，慢的那个会画错仓库）。
- **「上次选的仓库」必须按工作区分键（v0.20 修的真正根因）**：之前用单一全局键 `gg2-currepo`，而它在 `load()` 里**优先于会话工作区**——切到工作区 B 后只要旧仓库 A 还在白名单里，`current` 就仍是 A，表现得像「图谱无视切换」。改用 `gg2-currepo:<工作区路径>`（`curRepoKey/loadCurRepo/saveCurRepo`），各工作区各记各的，切换必跟随、切回还记得。**新增读仓库偏好的地方一律走这三个函数，不要再直接读写 `gg2-currepo`**。
- **自更新**（v0.10，v0.25 起纯图标）：`load()` 后静默 `checkForUpdate(true)`；`managed:'git'`（插件目录在 git 工作区内）时隐藏 `#btnUpdate`、手动检查提示 `git pull`；否则有新版显示立方体图标（`.has-upd`，版本号只在 `title`/`aria-label`，**不改宽度**）→ 确认 → `autoupdate` → 提示重启；无更新时提示已最新；版本取 `package.json` 的 `version`。
- **标签管理**：`openTagDlg` 列出该提交已有标签，每行 ✎ 改名（`tag-rename`：先建新名于同 commit 再删旧名）+ ✕ 删除（`tag-delete`，确认框按钮「确认删除」）；`confirmDialog(title, body, danger, okLabel)` 可自定义确认按钮文字
- **批量操作**：行复选框（`WD_SELECT`，键 `groupKey\0path`）→ `updateBatchBar()` 渲染批量条（暂存/取消暂存/还原/忽略/提交选中）；`commit` 带 `file` 时只暂存并提交这些文件；`ignore` = 追加 `.gitignore`（去重）+ 已跟踪文件先 `git rm --cached`（保留磁盘文件）；写成功后统一 `WD_SELECT.clear()`；「放弃/还原」统一叫**还原**（`discardConfirm`，标题「还原更改」）
- **客户端**：纯 JS + `React.createElement`（无 JSX/TSX）；Slot 注册用 `ctx.slots.register`；`inject` 只声明真正用到的服务
- **真·泳道图（v0.23）**：平铺视图的提交列表左侧是**整块一个 SVG 覆盖层**（`#laneSvg`，绝对定位在 `#commitList` 内），能画真正的分叉/合并曲线。
  - **布局算法** `layoutGraph(commits)`（纯函数，无 DOM）：移植自 VS Code Git Graph 的**预留点（reserved point）**策略——分支独占一条连续路径，合并路径复用目标父分支已预留的连接点。**不要改成朴素泳道分配**：那样无关泳道会在每一行斜向漂移，视觉全乱。输出 `{nodes:[{hash,lane,row,colour}], edges:[{fromLane,toLane,row,colour,missingParent}], laneCount}`。
  - **`missingParent`**：父提交不在已加载窗口内（分页！）时置真，渲染成虚线，表示「历史还有，只是没加载」。
  - **缓存** `ensureLayout()` 按 `长度:首提交hash` 做签名，切换仓库/加载更多时自动失效。
  - **几何**：`LANE_STEP=30`、`LANE_PAD=22`（按真实 4 泳道仓库标定：行高约 53px，30px 间距才不会让曲线接近竖直），gutter 宽 = `max(56, PAD*2 + (lanes-1)*STEP + 8)`；曲线控制点取 span 的 50%，水平位移集中在垂直中点，分叉才像"离开车道"而不是斜杠，逐行 `.cl-graph` 只是个撑开宽度的占位符。
  - **坐标来自真实布局**：`renderLaneGraph(list, rowEls)` 在行插入 DOM **之后**用 `getBoundingClientRect()` 取每行中心 y，所以消息换行、详情面板撑高时曲线仍对齐；两端有一端不可见（被筛掉）的边直接跳过，不跨空隙硬画。
  - **渲染顺序**：先画边（`lane-shadow` 在下做描边遮挡 + `lane-line` 在上着色），再画节点（`lane-hit` 透明大圆做点击热区 + `lane-node` 实体圆），节点设 `pointer-events` 由 hit 圆接管，点击调用 `selectCommit()`。
- **平铺视图 / 分组视图双模式（v0.23，v0.25 入口改到设置里）**：`FLAT_MODE`（持久化键 `gg2-flat`，已进服务端偏好白名单）由 ⚙ 设置里的分段控件经 `setFlatMode(on)` 切换，**默认分组模式**；**泳道图只在平铺模式显示**。
  - **为什么要这个开关**：分支分组头占一行但**没有提交节点**，泳道跨过它必然断开——这是分组模式与「连续泳道」的**结构性冲突**，靠调参数解决不了。平铺视图去掉组头、按**提交日期（`--date-order`）**一路排下来，泳道就能连贯画到底（这才是 VS Code Git Graph 那种观感）。
  - **`buildRows()` 在 `FLAT_MODE` 下直接返回全部提交行**（仍受 `vis` 分支过滤约束——平铺是"不分组"，不是"不过滤"）。
  - **空态判据要跟着分叉**：平铺没有折叠概念，`commitRows.length === 0` 就是真空；分组模式还得排除「全部折叠」这个正常状态。`matchingTotal` 在平铺时直接数 `ROWS` 里的 commit 数（`groupCounts` 只在分组模式有意义）。
  - **平铺用 `--date-order`，分组用 `--topo-order`**：排序参数由 `api()` **自动注入**（`op === "graph"` 且调用方没显式指定 `order` 时按 `FLAT_MODE` 补上），**不要在每个调用点手写**——首屏、`loadMore()`、`reloadGraphLight()` 三处必须同序，否则会把两种排序拼进同一个列表，看起来像乱序。`--date-order` 会让同一分支的提交被其它分支打断（这是时间线排序的固有代价），换来日期严格递减的阅读顺序。
  - **旧宿主安全降级**：老 `index.js` 忽略 `order` 并退回 topo 序，页面不报错（只是平铺下顺序不是时间线）。
  - **refs 标签在消息之前**：行内 refs（`.cl-refs`）渲染在 subject **左侧**、紧随泳道 gutter，而不是跟在消息尾部。分支/tag 名是最短、最便于扫读的部分，固定在左侧后可整列竖着扫；尾随在 subject 后面会漂到"这句话恰好结束的地方"，离视线起点很远。**配套约束**：`.cl-msg` 必须 `flex: 1 1 auto; min-width: 0`，否则标签前置后长 subject 不再占满剩余宽度、省略号失效。
  - **泳道图只在平铺模式显示**：`buildCommitRow()` 里只有 `FLAT_MODE` 为真才创建 `.cl-graph` 占位，`renderLaneGraph()` 也在开头直接 `if (!FLAT_MODE) return`（顺带跳过 O(n) 的 `ensureLayout`）。**分组模式左侧什么都没有**——组头那一行没有提交节点，画出来必然断线，用户明确要求此时不显示，而不是显示一条会断的线。改这块时别把两个渲染路径合并。
- **页面拆分为三文件（v0.26.0）**：`web/index.html` 只剩骨架（markup + `<link rel="stylesheet" href="app.css">` + `<script src="app.js"></script>`），样式在 `web/app.css`，逻辑在 `web/app.js`。**不要把它们合并回去**，理由与约束如下：
  - **拆分的目的就是收紧 CSP**。原先单文件必须 `script-src 'unsafe-inline'` + `style-src 'unsafe-inline'`；拆成外部文件后两条都变成 `'self'`，页面不再需要任何内联许可（`PAGE_CSP` 在 `index.js` 顶部，页面与两个资源共用同一份）。**评审时认这一点**：`'unsafe-inline'` 是否真的消失了，比文件是否分开更重要。
  - **`style="..."` 属性会被 `style-src 'self'` 拦掉**（实测 Chrome 报 "Applying inline style violates …"，整条失效）。markup 里**不允许 `style=` 属性**；静态样式写 `app.css`，动态改走 CSSOM（`el.style.x = …` / `setProperty`）——**CSSOM 不受该指令限制**（`style.color=`、`cssText`、`setProperty`、`insertRule`、`new CSSStyleSheet()` 全正常，只有 `setAttribute('style',…)` 与静态属性被拦）。隐藏统一用 `.gg-none`。
  - **`app.css` 的缩进从 0 开始**：抽出时已去掉原 `<style>` 里的外层两格，内部相对缩进保留；改样式别再假设有外层缩进。
  - **`index.js` 用显式白名单提供这两个文件**（`/git-graph/app.css`、`/git-graph/app.js`），不是目录服务器——`web/` 目录以后放别的东西也不会被意外送出。新增第三方资源必须同时改这里、`PAGE_CSP` 与 `scripts/publish.mjs` 的检查。
  - **发布链与自更新都要校验它们存在**：`scripts/publish.mjs` 断言 HTML 里引用了 `app.css`/`app.js` 并直接 `node --check web/app.js`；`autoupdate` 在替换安装前检查 `web/app.css`/`web/app.js`（缺失就 `missing-web-css`/`missing-web-js` 中止，旧安装原样保留）。少一个文件就是一个白屏，所以这两处检查不是冗余。
  - 验证：`node scripts/check-remote-ui.mjs` 的静态段即断言 `<style>`/内联 `<script>`/`style=` 全无；等价性用「旧单文件 vs 新三文件」同数据渲染比对（v0.26 实测 19/19 字段一致、截图逐像素相同）。
  - **升级窗口期会白屏，`#bootFail` 是为此存在的（v0.26.0）**：`web/` 三个文件**每请求从磁盘重读**，而 `index.js` 只在宿主启动时加载一次。所以「插件更新了、dsh web 还没重启」这个窗口里新 `index.html` 会被送出，但它引用的 `app.css`/`app.js` 在**旧**服务端没有路由 → 双双 404 → 只剩无样式骨架。**任何从旧版本升级的用户都会遇到**，故 markup 带一块 `#bootFail`，明说「重启 dsh web 即可恢复」。四条约束：
    - **CSS 完全没加载时也要读得出来**：纯文本 + 浏览器默认样式，**不要加 `style=` 属性**（正好会被严格 CSP 拦掉，等于在最需要它时失效）。
    - **靠自己淡入，不靠 JS 显示**：`opacity:0` + `animation: bootReveal 0s linear 1.2s forwards`。健康加载时 `app.js` 在 1.2s 内移除它，正常路径看不到（实测 `op=0 → gone`）；`app.js` 挂掉时没人负责隐藏，它就自己浮现。**不要改成「JS 检测失败后才显示」**——JS 没加载时那条路径不执行。
    - **必须 `position:fixed`，不能留在文档流**：`opacity:0` 不占位是错觉，在流里会把 `header` 下推一个卡片，`app.js` 移除时再弹回。实测插入 → `header` 下移 **209px**；改 `fixed` 后位移 **0**。这是布局抖动不是审美。
    - 判定「CSS 生效」**必须用哨兵属性** `--gg-page-ready`（`app.css` 的 `:root`）：`getComputedStyle(document.documentElement).getPropertyValue("--gg-page-ready") === "1"`。**不要用颜色判断**：11 套主题里 8 套 `--bg` 是**渐变**画在 `<html>` 上、`body` 透明，任何颜色探针都判成「没样式表」——本项目踩过：**正常加载也弹「Git 图谱未能加载」**。也不要用 `document.styleSheets.length`（404 错误页也被计入）。
    - **样式表 404 时提示必须自己重新钉住**：让它 `position:fixed` 的规则就在**缺失的那个样式表**里，此时它回到文档流；而 `app.js` 仍在跑，`selectCommit()` 的 `scrollIntoView` 会把提示带出屏幕（实测 `scrollY 2312`、提示 `top -2304`）。所以 `clearBootNotice()` 在哨兵缺失分支用 **CSSOM**（`Object.assign(notice.style,{...})`）重新钉到视口——**可以用 CSSOM 但不能用 `style` 属性**。三种状态实测：正常 → 移除；CSS 404 → 可见且钉住（`top:12`）；JS 404 → 宽限后淡入。
- **页面**：`app.js` 顶部 `"use strict"`；API 失败统一 `{ok:false, error}`；主题变量 `--bg/--text/...` + `html.gg-light`；v0.8 起 **8 种风格**各带 `#ggDeco` 装饰，`renderBgDecor()` 动态生成，仅彩色风格启用；**`#graphWrap` 背景必须透明**（否则盖住装饰层），header/statsBar/statusLine 用 `position:relative; z-index:1` 让内容可读、弹层（菜单 30/40、对话框 60）在其上
- **顶栏三区网格（v0.25）**：`header` 是 `display:grid` + `grid-template-columns: minmax(0,1fr) auto minmax(0,1fr)`，三个子元素 `.hd-left` / `.hd-center` / `.hd-right`。
  - **为什么不用 spacer + flex**：`flex:1` 的空档只能把中间推到「剩余空间的中间」，两侧内容一变宽（仓库路径长了、更新图标出现了）中间就漂。两条等宽 `1fr` 边轨把剩余空间**均分**给左右，`.hd-center` 因此始终落在整条顶栏的中心（实测 1400px 宽下偏移 0.0px，左右各 490.5px）。改这里时**不要退回 flex + spacer**，也不要给某一个边轨写死宽度。
  - **中区顺序固定为 分支过滤 → 日期 → 搜索**（`#btnFilter`、`#btnDate`、`.searchWrap`），在 `.hd-center` 里按 DOM 顺序排列即可，不要用 `order` 打乱——顺序是用户可感知的语义（先缩小范围，再找东西）。
  - **右区**：`#btnOpenDir` / `#btnFetch` / `#btnPush` / `#btnRefresh` / `#btnUpdate` 五个 `.icon-btn`，然后 `.hd-sep` 分隔线，最后 `#btnSettings`（**必须最右**）。分隔线必要：图标尺寸下 8px 间距会让齿轮看起来像「又一个仓库动作」。
- **图标按钮只留图形（v0.25）**：`.icon-btn` = 30×30 的透明方框 + 16px 描边 SVG。**名称只能放在 `title` 与 `aria-label` 里**（两者都要写，`title` 给鼠标、`aria-label` 给读屏；只写 `title` 的按钮在无障碍树里是空名）。三条由此派生的约束：
  - **不要再用 `textContent` 表示进行中状态**。`btnFetch`/`btnPush`/`btnUpdate` 原来靠 `btn.textContent = "拉取中…"` 表示忙碌，而图标按钮的唯一子节点是 `<svg>`，赋值 `textContent` 会**把图标删掉**。统一走 `setBusy(btn, busy, label)`：加 `.busy`（旋转 SVG）、置 `disabled`、设 `aria-busy`、改 `title`，并在 `finally` 里传回原 title。
  - **不要给顶栏写兜底的 `header button { ... }` 规则**。以前有一条 28px 高、12px 横向内边距的通配规则；`.icon-btn`/`.pill-btn` 没重声明的属性会被它悄悄接管（例如 `padding`），30px 方框就变成 30px × 高矮不一。现在只有 `.icon-btn` 与 `.pill-btn` 两个类。
  - **更新提示不再改按钮宽度**。原来有新版本时按钮文案变成「🔄 新版本 vX.Y」，右区一宽中间就跟着漂（正是上面那条要避免的）。改为固定 30px 的立方体图标 + `.has-upd` 高亮，版本号写在 `title`/`aria-label` 里。
- **⚙ 设置 = 二级页面（v0.25）**：`#settingsDlg` 里放两组「设一次就不常改」的选项——**视图**（`#stView` 分段控件：按分支分组 / 平铺）与**主题**（`#stThemes` 网格，11 项）。**顶栏不再有 `#btnFlat` / `#btnTheme` / `#themeMenu` / `.themeWrap`**，这些 id 与样式已删除，别再按 id 去找它们。
  - **视图是绝对值不是开关**：`setFlatMode(on)` 接收目标值，分段控件两个选项都可见，点哪个就是「变成这个」。原 `#btnFlat` 是 toggle，放不进分段控件——一个会「翻转」的按钮在两项都可见的控件里，双击与误点无法区分。
  - **主题选择器用 `THEME_NAMES`（纯中文名）而不是 `THEME_LABELS`**：后者带 emoji，和左侧颜色圆点一起会出现「一个主题两种符号」，而 emoji 不预览任何东西。emoji 仍留在 `title` 与 README 里。
  - **`applyTheme()` 必须调 `syncSettingsState()`**（不是只调 `syncThemePicker()`）：齿轮上的「非默认」小圆点也由主题推导，只刷新选择器会留下过期的圆点（本项目实测过：切回默认主题后圆点仍在）。
  - **模态要吃掉键盘**：`#settingsDlg` 或 `#shortcutDlg` 打开时，方向键 / `j` / `k` 必须直接 return，否则会在对话框背后滚动列表并打开提交详情。`Ctrl+/` 是例外，它在模态内仍工作（用来切到快捷键面板）。`Esc` 的关闭顺序里 `#settingsDlg` 排在 `#shortcutDlg` 之前。
  - **窄屏**：≤560px 时 `header` 变成两行（`grid-template-areas: "left right" "center center"`），中区整体换到第二行；>560px 单行。≤760px 先隐藏 `.repo` 再把 `.searchWrap` 收窄——隐藏的是**冗余信息**（路径与下拉的 title 重复），不是功能。
- **快捷键与「唯一选中态」（v0.24）**：`Ctrl+/` 快捷键面板、`Ctrl+F` 聚焦搜索、`Ctrl+B` 折叠/展开全部分支组、`↑/↓`+`j/k` 切换提交并同步打开详情、`Esc` 关闭；提交框内 `✨ AI 生成提交信息` 调 `suggestmsg` 填充候选（可编辑）
  - **只有一个游标：`SELECTED`（hash）**。鼠标点击与 `↑/↓`/`j`/`k` 都只写它，**不要再引入 `KEY_IDX` 之类的第二个下标游标**。历史上两套状态（`SELECTED` 给鼠标、`KEY_IDX` 给键盘），后果是**点选第 6 行再按 ↓ 会从第 1 行开始**——键盘游标从没被告知鼠标去了哪里。更隐蔽的是 `KEY_IDX` 是 `COMMITS` 的下标，却由**过滤后的可见行列表**算出，于是「搜索/日期过滤」或「分支折叠」激活时，虚线框会落在根本不是你刚按的那条提交上。
  - **为什么用 hash 而不是下标**：过滤、折叠、分页都会让下标指向另一条提交，任何下标游标每次 render 后都得重新同步（旧代码反复出错的根源）；hash 是唯一稳定标识。
  - **按下时从 `SELECTED` 出发**：`list.indexOf(SELECTED)` 得当前位；返回 `-1`（选中的提交当前没被渲染：被过滤、在折叠组里、或还没翻到）时 ↓ 从头开始、↑ 从末尾开始，保证按键**总有一次可见的移动**，而不是静默无反应。
  - **`kbdVisibleList()` 直接读 DOM**（`#commitList .cl-row` 的 `data-hash`），不要用 `buildRows()` 重算：`buildRows()` 只知道分支折叠，`render()` 另外还会因 `passesFilters()`（搜索/日期）和 `HIGHLIGHT`（图例高亮）丢行——两边不一致会让方向键「按了没反应」或「一次跳两条」。**DOM 里有什么，用户就能看到并逐条走过什么。**
  - **选中样式 = 背景高亮 + 虚线框，同一个 `.cl-row.sel`**：`.kbd` 类已删除。样式分成两个类时，「详情开着的那行」和「键盘接着来的那行」可以是两行，虚线框的存在正是为了回答"我现在在哪、下一步去哪"。
  - **`buildCommitRow(c)` / `buildHeadRow(r)` 只收实际用到的参数**：`hidden`/`vis`/`hlSet` 曾作为未使用参数一路传下去（`buildHeadRow` 的 `vis`/`hlSet` 从未被读），已删除；行是否需要渲染由调用方（`render()`）判定，构造器不再重复判断。
- **分支过滤语义**：不勾选的分支其提交与组头完全隐藏；`visibleSet()` 空集时显示空列表（禁止回落全显）；`buildRows(vis)` 对本地与远程分支都生成可折叠分组——**过滤激活时 tip 不在可见集的分支直接跳过且不标记 seen**（否则其祖先会被吞掉，共享该祖先的可见组变空），leftovers 也按可见集过滤
- **未提交改动**：常驻顶部 `#wdPanel`（`refreshWorkdir` 拉取 workstatus 并渲染面板 + 状态栏）；分组（staged 按 X 码、unstaged 按 Y 码、`??` 未跟踪、冲突码 `U`）；`workfile` 按需加载 + 客户端缓存（`wdDiffCache`）；干净时显示「✓ 工作区干净」；分组显隐 `WD_SHOW`，面板/分组折叠 `WD_FOLDED` / `WD_GROUP_FOLDED`；`#wdPanel` 禁止 `overflow:hidden`（会裁切绝对定位的分组菜单）
  - **文件列表超过 10 行就在内部滚动（v0.26.0）**：`MAX_WD_ROWS = 10`，由 `layoutWdBody(body)` 给 `.wd-body` 设 `maxHeight` 并加 `.scrolls`（`overflow-y:auto`）。这样滚的是列表，**顶栏的 全部暂存/提交/分组/刷新 和批量条保持钉住**，不会跟着滚走。
  - **上限用真实几何量出来，不要写死行高**：行里有徽标、复选框、可变内边距，展开 diff 后高度还会变，组头也占高度。正确定义是「把 clip 线放在第 11 行的上边缘」——`rows[10].getBoundingClientRect().top - body.getBoundingClientRect().top`，所以不论 11 行怎么分布在几个组里，可见的永远正好 10 行。折叠组里的行 `offsetParent === null` 要跳过（它们测得 0，会把上限拉成 nonsense）。
  - **什么时候重算**：`renderWdGroups()` 渲染后、组头折叠切换后（哪些行是第 11 行会变）、`window.resize`（`relayoutWdBody()`）。**展开单行 diff 时刻意不重算**：行数没变，上限就不该动；重算会用占位文案「加载中…」的高度把上限撑大，等真正内容到了 clip 线就再也对不上了（本项目实测踩过）。展开后 diff 在列表内滚动即可，面板高度保持不变。
  - **`.wd-row` 必须 `flex-wrap: wrap`**：diff 块是 row 的子元素，row 又是 flex 容器；不换行时 diff 会被当成又一个横向 flex item 挤到文件名右边（截图里表现为文件名右侧一大片空白、diff 竖在右上角）。配合 `#wdPanel .wd-row.open .wd-diff { flex: 1 0 100% }` 强制它独占一行、占满整行宽。
  - **滚动条用 `--text3` 而非 `--bg4`**：深色主题 `--bg4`(#222b37) 与面板底 `--bg3`(#1a212b) 几乎同色，thumb 等于隐形；而 `#wdPanel .wd-body` 正是新加的那个常驻滚动区。用 `color-mix(in srgb, var(--text3) 45%, transparent)` 保证 11 套主题下都可见，并给该区域加 `scrollbar-width: thin`。（`opacity` 对 `::-webkit-scrollbar-thumb` 无效，别用。）
- **解析细节**：`porcelain -z` 重命名两条记录（`XY <新路径>` + `<旧路径>`）；`numstat -z` 为 `n\tn` + 旧路径 + 新路径；Windows 路径先 `replace(/\\/g,'/')` 再比较

## 远程 SSH 工作区（v0.26.3，改 runGit / apply() / 远端 UI 前必读）

`ssh://<alias>/<abs path>` 会话下，全部读 op 与 `gitop` 每个 action 返回的 JSON 与本地逐字段一致；
`scripts/check-remote-live.mjs` 用真主机 git 原始输出对账（76 条断言）。

**分流**：`runGit` 是**唯一分叉点**（47 个调用点，另有 3 处直接调 `runGitRemote`），签名与返回类型不变——**不要在 op handler 里判远端**，也不要在远端复刻本地实现。

**spec 形状**（每个字段都被强校验，写错**同步抛错**）：
`spawn({ argv: ['git', ...args], cwd: sshUrl, graceMs: 5000, stdio: { stdout: {maxBytes}, stderr: {maxBytes: min(maxBuffer, 1MB)} } })`。
- **`-C` 必须去掉**：`git -C ssh://…` 必然 exit 128，远端路径由 `cwd` 表达。断言 `argv` 严格等于 `['git', ...args]`。
- `done` 是 `{exitCode, signal}` **对象**，只在传输层失败时 reject——git 自己的非零退出是 resolve。判码要显式读 `result && result.exitCode`：`okExitCodes.includes(undefined)` 一旦成立就会把失败当成功。
- 超时：`fetch/pull/push` 的 120s 由 `runGitRemote` 的 `setTimeout` + `handle.terminate()` 实现，**不是** `execFile` 的 `timeout`；`graceMs` 与 `timeoutMs` 是两件事。
- **断连绝不重放写操作**：`done` reject 且 message 匹配 `/SSH connection dropped/` 时，只有 `args[0]` 不在 `REMOTE_WRITE_SUBCOMMANDS`（add/commit/restore/reset/rm/tag/branch/fetch/pull/push/checkout）才重试一次——写操作可能已经在远端执行了。

**`node:path` 在 `ssh://` 上全错，用 POSIX 词法解析**（`remoteJoin` / `resolveRemoteFile`，不 import `node:path`）。

```
resolve('ssh://qiyk/home/u/repo','a/b.js')   → F:\<cwd>\ssh:\qiyk\home\u\repo\a\b.js
join('ssh://qiyk/home/u/repo','.git','HEAD') → .\ssh:\qiyk\home\u\repo\.git\HEAD
isAbsolute('ssh://qiyk/home/u/repo')         → false
```

**三个同步读盘函数在远端返回 null / 走 async 版**：`gitDirOf`、`readRefsFromDisk`、`findGitRoot`。
对应 `hasGitEntryAsync`（`rev-parse --git-dir`，**只缓存肯定答案**）、`findGitRootAsync`（`--show-toplevel` 拼回 `ssh://alias/...`）、`readHeadNameAsync`（`branch --show-current`，detached 输出空串）。
**性能铁律在这里方向相反**：本地「能合并就合并、能读盘就读盘」，远端「能拆就拆、绝不读盘」。远端一条 `for-each-ref` ≈ **10.5ms**，复刻本地读盘要走 4 次 SFTP 往返 ≈ **571ms**（真机实测）。`branches`/`head` 因此走 for-each-ref 回退，两边答案必须逐字段相同。

**输出是尾部截断（StreamTail）**：`finalize().truncated` 为真必须 reject、绝不解折半截文本（半条 log 看起来像「完整但很短的历史」）。`maxBuffer` 传满额而非 `MAX_DIFF_CHARS`——触上限是「截断并 reject」，传小会把大文件变 500。

**noDelay 是可选加速，不是正确性依赖**：`router.engine?.pool?.get?.(alias)?.client?.setNoDelay?.(true)` 整链带 `?.` 与 try/catch（`engine`/`pool` 非导出契约），拿不到退回默认 RTT 94ms/条。

**远端 push/fetch 用远端主机的凭据与网络**，本机代理与 SSH key 都不参与；`commit` 记**远端**的 `user.name`/`user.email`（真机 `qiyk / ethan.71@163.com`）。**`push` 常失败且属正常**——远端无 `credential.helper`，实测 `fatal: could not read Username for 'https://github.com'`（exit 128），回 500 + stderr。**不要为「让 push 工作」加凭据转发**：那是用户自己的凭据。

**五处拦截**（`{ok:false, error:'unsupported-remote', op, hint}` + 400，`hint` 回答「为什么」，`REMOTE_UNSUPPORTED` 是唯一真源）：`reveal` / `listdir` / `addrepo` / `findrepos` / `gitop ignore`。全是**本机文件系统**能力，而桥只放行 `git` 与 `rg`。
- **`gitop ignore` 必须在 action 分派之前拦**：它是唯一走 `appendFileSync` 的 action，晚了就拿 `ssh://` 拼成本机路径去写（实测 500 + `ENOENT: ... \ssh:\qiyk\tmp\...\.gitignore`）。
- `listdir`/`addrepo`/`findrepos` 在 `repos` 之前应答、**没有自己的 `ws` 参数**，靠两个信号：`lastWs` 与请求自身的 `path`。只按 `path` 判会漏掉「从盘符开始浏览」那次 `listdir`（`path` 是空串）。

**`lastWs` 是远端判定的地基**：`repos` 里 `const ws = normalize(...)` 之后必须 `lastWs = ws`。没赋值时 `sessionIsRemote()` 恒假、只读门禁也拿不到会话——**这条曾整段失效过**。

**远端写的只读门禁（fail-open）**：`lib/patch-subprocess.js` **不引用 `mode-gate.js`**，走 subprocess 桥的 `git` 在 `read-only` 会话下照样以远端登录用户权限执行。本插件在 `gitop` 入口自带一道——`remoteWriteMode()`：`ctx.get('sandboxPolicy')`（局部 `serviceOf` 包 try/catch，真 context 上属性读抛 without inject）→ `sessions.list().find(s => String(s?.header?.cwd || '') === lastWs)` → `policy.resolve({session}).mode`。**workspace root 绝不从请求取**，请求只是「找到服务端已知会话」的选择器。`undefined` = **放行**（无策略服务即 unconfined），只有明确 `read-only` 才拒（`read-only-session` + 403）。**只作用于远端**：本地 `execFile('git')` 绕开沙箱是 v0.1 起的既有行为。

**接线只有四处，多一处都是权限或语义风险**：① 白名单按工作区记账（`remoteWsRoots`：`normKey(ws)` → `normKey(findGitRootAsync(ws))` 或 `null`，`repos` 每次刷新）；`if (isRemotePath(repo)) return true` 是**权限放大**，live 检查会抓（`ssh://alias/etc` 必须 403）。② 每请求 git 校验 `hasGitEntry` → `await hasGitEntryAsync`。③ `repos` 里 `findGitRoot` → `findGitRootAsync`。④ `graph` 的 `readHeadName` → `readHeadNameAsync`。

**路径守卫必须分叉，两处**：`workfile`/`filelog` 与 **`gitop` 的 `okPath`**。本地 `resolve(repo,file)` + `startsWith(base+'/')`，远端 `resolveRemoteFile(repo,p) !== null`——`resolve('ssh://a/home/u/repo','x')` 得 `F:/.../ssh:/a/home/u/repo/x`，**永远不以 ssh:// base 开头**，旧写法在远端拒绝每个文件。判据是 **alias 根**：`../../../etc/passwd` 上溯到 `/etc` 仍在 alias 内**放行**，由 git 报 not-found；翻出 `/` 才 400 `path-outside-repo`。**两面都要测**：只断言「越界被拒」时守卫改成恒真照样绿；只测空文件列表时 `okPath` 根本没被调用。

**远端未跟踪文件**：一条 `ls-files --others --exclude-standard --directory -z -- <file>` 同时回答「是不是目录」（`--directory` 给目录加尾斜杠）与「存不存在」，再用 `git diff --no-index --no-color -- /dev/null <file>` 取内容。**exitCode 1 正常**（有差异），`0` 无差异，`>=2` 才是错——**不能走 `runGit`**（只认 `[0]`），必须 `runGitRemote(..., {okExitCodes:[0,1]})`。真机：文本带 patch；空文件只有 `new file mode`；目录 stdout 空 + `Could not access`；二进制 `Binary files ... differ`。

**`gitop` 参数名易错**：`checkout`/`delete-branch` 读 **`name`**，`push`/`pull` 读 **`branch`**，`branch` 读 `name` + `hash`——传错得到 `missing-branch-name`，看起来像没接线。

### 客户端（改远端相关 UI 前必读）

判定分两层，**不要合并**：`isRemoteRepo(r)` = `r.startsWith("ssh://")`；`remoteActive()` 只看 `REPO`（屏幕上这个仓库）；`WS_REMOTE` 镜像 `repos.wsRemote`（为空态准备，那时 `REPO` 还是 null）；`pickerBlocked()` = `WS_REMOTE || remoteActive()` 管**会话级**能力（打开文件夹 / 扫描本机磁盘），`remoteActive()` 管**仓库级**能力（`reveal` / `gitop ignore`）。

**三处入口**：`#btnOpenDir` / `#btnOpenDirEmpty` → `disabled` + `title`；右键菜单「在文件管理器中打开」→ **整项不渲染**（能且只能失败的菜单项读起来像 bug）；批量条「忽略选中」→ `disabled` + `title`；`#btnScanDir` 在远端会话下 `.gg-none`。
- **`title` 必须能被还原**：`ORIG_TITLES` + `origTitleOf(el)` 首次覆盖前抓原文，切回本地写回；硬编码副本会随 `index.html` 漂移。
- **`applyRemoteUi()` 是幂等总入口**：`repos` 响应后、`REPO` 落定后、`showEmpty()` 里、`repoSwitch` 的 change 里都要调。视觉全靠 `.icon-btn[disabled]`、`.es-open[disabled]`、`.wd-batch button[disabled]` 三条 CSS（第三条 M4 补：之前批量按钮禁用后仍 hover 变色）。
- **徽标只跟「屏幕上这个仓库」，不跟会话**：判据 `remoteActive() && !EMPTY_SHOWN`。**不要写成 `remoteActive() || pickerBlocked()`**——那会让远端会话里显示**本地**仓库时，本地路径前挂上「远程 · qiyk」，标签与徽标互相矛盾（用户实测报的就是这个）。`EMPTY_SHOWN`（`showEmpty()` 置真 / `hideEmpty()` 置假）抑制空态：`#repoLabel` 此刻是破折号；用状态变量而非读 DOM。徽标在 `.hd-left` 的 `#repoLabel` 之前，`textContent = "远程 · " + alias`（**必须 textContent**，alias 是外部输入），显隐走 `.gg-none`；一出现就改左轨宽度，脚本断言 `.hd-center` 偏移 ≤1px。
- **状态栏**：`renderStatusLine()` 在远端追加「· 远端 <alias> · 网络与凭据使用远端主机」——用那台机器的代理与 SSH key，不说清会被当成自己的凭据问题。
- **错误文案统一走 `opErrorText(res)`**（`code + " —— " + hint`）。服务端为 `unsupported-remote` / `read-only-session` 写了 `hint`，吞掉就只剩裸错误码。
- **空态文案必须按 `wsProbe` 分叉，不能统一归因于「插件没装」**（v0.26.3 修的归因错误）：远端没有 git 根有五种原因，旧的 `wsIsGit:false` 全渲染成「需要安装并启用 `@shiqyka/dsh-ssh-workspace`」——最常见的那种（目录不是仓库、或仓库在子目录里）反而被支走。`probeRemoteGitRoot(ws)` 与 `findGitRootAsync` **跑同一条命令**，所以多存原因**不多起进程**，只是不再塌缩成 `null`：返回 `{root, bridge, git, reason, detail}`，`reason` ∈ `bridge-missing` / `not-a-repo` / `git-missing` / `path-unusable` / `unreachable` / `unknown` / `ok`；`repos` 新增 `wsProbe`（本地 `null`），`remoteEmptyText(probe)` 是**唯一**文案来源。
  - **`bridge:false` 是唯一「真的没装插件」的信号**：靠 `REMOTE_SUBPROCESS_INSTALLED` 标记判断，**不 spawn**（未打补丁的 `spawn` 会拿 `ssh://` 当本机 cwd 跑 git）。反过来 **`bridge:true` 时绝不兜底成「装插件」**——分类失败必须落到 `unreachable`（带 detail），因为桥已证明是通的。
  - **分类先看退出码，文本只是兜底（真机教训）**：git 会翻译消息——中文 locale 主机答 `fatal: 不是 git 仓库（或者直至挂载点 / 的任何父目录）`，英文正则全匹配不上。所以 `runGitRemote` 转 `Error` 时**附带 `exitCode`**（语言无关），`PROBE_EXIT_REASONS` 先判：`128` 不是仓库 / `127` 没装 git / `1` `cd` 不进去；其余（传输、认证）才走 `PROBE_PATTERNS` 文本匹配（来自 ssh-workspace 自己，是英文，**顺序有意义**：先具体后泛化）。`detail` 只留 stderr **首行**（截 160）。
  - **降级不白屏、不一直 loading**：缺失 `wsProbe`（老宿主，新页面配旧服务端）时回落到不指名插件的兜底句；`graph` 失败分支同理，远端会话下不引导「打开其他文件夹」（去不了）。上述各面均有断言（`空态/未分类`、`空态/老宿主无 wsProbe`）。

**验收脚本** `node scripts/check-remote-ui.mjs`（真实 Chrome+CDP，发布链 2e 步，缺 Chrome/dsh web 时 SKIP）：把 `api()` 与 `resolveSessionWs()` 换成固定响应，驱动真实 `load()` 后断言 DOM——本地基线 → 远端 → **远端会话 + 本地仓库** → 切回本地 → 空态（五种原因五份文案各断一次）→ 520px 窄屏，共 63 条。最不能删的两段：**「切回本地全部复原」**（只测远端会把「一次性覆盖不还原」判绿）与**「远端会话 + 本地仓库」**（徽标判据写成 `pickerBlocked()` 时只有这段会红）。空态拆五段是刻意的：合成一段只测得出「有文案」，测不出「文案对了」。

**降级回归** `node scripts/check-degrade.mjs`（发布链 2f 步，无基线 tag 时 SKIP）：基线（默认 `v0.26.2`）的 `index.js` 与当前版本同挂到**无 subprocess 服务**的 fake host（= 没装 ssh-workspace 的真实状态），对两份相同仓库副本跑同一套 op 序列逐字段比对，唯一允许的差异是 `wsRemote`/`wsProbe`（断言「恰好只这两个」）。**挡的是「远端全绿、本地被改坏」**：`-C` 被误删、白名单多认路径、守卫恒假，远端测试都照过。

## 生命周期约定（v0.26.2，改 apply() 前必读）

**apply() 里装的任何东西都必须交出清理函数**，否则宿主卸载插件后资源留在原地，再次挂载就会撞车。这个项目已经真实踩过一次（面板报的是 `webserver: duplicate prefix route "/git-graph"`）：

- `ctx.webServer.register(...)` 的返回值是一个 disposer。直接调用它而**不交给框架**，插件卸载（热重载、配置更新、禁用再启用、HMR）时 fiber 没有可执行的清理，`/git-graph` 前缀路由仍留在路由表里；下一次挂载再注册同一路径，重复守卫直接抛错 —— **插件再也装不回来**。
- 正确写法是把它包进 `ctx.effect`：`ctx.effect(() => ctx.webServer.register({ ... }), 标签)`。effect 体返回的 disposer 会被 fiber 收集，卸载时按注册逆序执行。
- 同类资源同理：定时器、事件监听、在别的服务上注册的行，都用 `ctx.effect` 返回清理函数。兄弟插件 `@shiqyka/dsh-ssh-workspace` 同形：`routes.map((r) => webServer.register(r))` 收进数组，再 `return () => { for (const d of disposers) d() }`。
- **`return disposer` 不算数**：`apply()` 的返回值在这条链路上没被收集（实测：让 apply 返回同一个 disposer，卸载后路由仍在表里）。必须走 `ctx.effect`。

回归防线：`node scripts/check-lifecycle.mjs` 用最小 fake host（只实现 `ctx.effect` 与 `ctx.webServer.register`）断言「挂载 → 卸载 → 能再挂载」，已接进 `npm run publish:npm` 第 2b 步，旧写法会让发布在语法检查后立刻中止。**不要为了让发布通过而放宽这个检查** —— 它挡住的正是「插件装上后卸不掉、再也装不回来」这个真实故障。

## 开发与验证流程

1. 修改源码（`index.js` / `client.js` / `web/index.html` / `web/app.css` / `web/app.js`）
2. 语法校验：
   - `node --check index.js client.js`
   - `node --check web/app.js`（页面逻辑已是外部文件，直接检查；`web/index.html` 里若又出现内联 `<script>`，提取后同法检查）
3. 挂载方式（v0.14 起单一真源 = 本仓库）：`dsh plugin --profile web add link:<本仓库路径>` 一次性挂载，之后改代码**无需重新挂载**
4. `index.js` / `client.js` 改动需重启 dsh web；`web/` 三个页面文件刷新即生效
5. 服务端功能测试：构造场景仓库（staged / unstaged / untracked / rename / MM / 删除），用 mock `webServer` 调 handler 断言 JSON；页面级用临时 http server + 浏览器验证。远端另跑 `check-remote.mjs` / `check-remote-live.mjs` / `check-degrade.mjs`
6. 版本节奏：功能迭代 → `npm run check:compat` → 锚点版本隔离实测（`pwsh -File scripts/compat-isolated-test.ps1`）→ `package.json` version 同步 → `git commit` → `git tag vX.Y`
7. npm 发布：`npm run publish:npm`（自动跑三处包名一致性、语法、兼容、pack 检查链，强制官方 registry）。发布后核对 `npm view @shiqyka/dsh-git-graph version`；registry 有几十秒到数分钟的处理延迟，`npm publish` 打印 `202` 后首次查询 404 属正常，要轮询而不是当成失败重发（重发会撞 `EPUBLISHCONFLICT`）。

## 注意

- 提交前检查：不要把本地绝对路径（如 `D:/...`、`C:\Users\<用户名>\...`）写进 `cordis.patch.yml` / README —— 开源仓库使用示例路径占位
- `.gitignore` 已排除 `node_modules/`、`*.log`、`.DS_Store`、`.playwright-mcp/`（浏览器测试残留）
- **编码铁律（教训：BOM 曾导致 Harness 启动崩溃）**：`.json` / `.yaml` / `.yml` 必须 **UTF-8 无 BOM**。PowerShell 5.1 的 `-Encoding utf8` **会写 BOM**，而 JSON.parse 不接受 → `readProfileManifest` 抛 `SyntaxError`，Harness 起不来。写用 `[System.IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding($false)))` 或 pwsh 7+ `-Encoding utf8NoBOM`；写完校验前 3 字节 ≠ `EF BB BF`
- **挂载与兼容（v0.14 起）**：profile 以 `dsh plugin add link:` 直挂本仓库（单一真源）。兼容声明用官方字段：`engines.dsh` + `peerDependencies["@deepseek-ai/dsh"]`（DSH ≥0.2.0 在 add preflight 与 profile 组合时**强制校验**）+ `dsh.manifestVersion: 1`；`peerDependenciesMeta` 必须标 optional。改兼容范围必须先跑锚点版本隔离实测（证据记入 docs/compatibility.md）
- **包名必须 scoped，且三处逐字相同（v0.26.1，改这块前必读）**：npm 上不带 scope 的 `dsh-git-graph` 属于另一个项目（enoughpower/dsh-git-graph），本插件无法沿用，因此包名是 `@shiqyka/dsh-git-graph`。以下**三处必须逐字一致**，`npm run publish:npm` 会在发布前比对并在不一致时中止：
  - `package.json` 的 `name`
  - `client.js` 里 `window.__ModuleLoader__.load({ id })` —— 客户端加载器按**包名**去核对模块注册的 id，不同则标签页**静默消失**（不报错、不打日志）
  - `cordis.patch.yml` 里 insert 行的 `name` —— 组合层用它做 `require.resolve` 再读 `dsh.client` 才带起浏览器半；裸名在这里解析不到任何东西，行不挂载
  - 附带一条：`client.js` 注入样式标签的 `dataset.plugin` 也必须等于包名。核心的 `claimStyles()` 用 `style[data-plugin="<入口 id>"]` 认领样式，写裸名会让这个标签在插件卸载 / HMR 后**留在页面上**。
  - 根因（实测）：`exactPackageSpecifier()` 只接受裸包名或 `@scope/name` 两种形状，随后走 Node 解析；profile 的 `node_modules` 里有什么名字就只能解析到什么名字。所以改名必须同时动 profile 的依赖键与 `dsh.profile.bundles` —— 已装的旧 profile 改完会**静默跳过该 bundle**（`skippedBundles`），表现为「插件不见了」，需重新 `dsh plugin add`。
