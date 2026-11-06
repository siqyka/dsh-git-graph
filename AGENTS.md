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
├── web/index.html    # 图谱页面骨架（iframe 独立页，只剩 markup + 两个资源引用）
├── web/app.css       # 页面样式（外部表，CSP style-src 'self'）
├── web/app.js        # 页面逻辑（外部脚本，CSP script-src 'self'）
├── package.json      # npm 清单（dsh.client + dsh.bundle.patch + engines.dsh + peerDependencies）
├── cordis.patch.yml  # profile 挂载点（默认不带 config.repo，白名单示例在注释里）
├── scripts/          # check-compat.mjs（窗口覆盖检查）/ publish.mjs（发布链）/ compat-isolated-test.ps1（隔离实测）
├── docs/             # compatibility.md 兼容性证据
├── assets/           # README 演示截图
├── README.md / README_EN.md
└── LICENSE           # MIT
```

## 服务端 API（index.js）

`GET /git-graph/api?op=<op>&repo=<path>[&...]`，op 列表：

写操作（`gitop` / `autoupdate` / `addrepo` / `prefswrite`）必须用 **POST**，其余为 GET。
服务端对写 op 校验 `req.method`，GET 直接 405（v0.21 起，见下方安全防护）。

| op | 用途 | 关键参数 |
| --- | --- | --- |
| `repos` | 会话工作区向上定位 git 根 + 白名单兜底（白名单与「打开文件夹」添加的仓库中，失效/非 git 的路径都会被过滤剔除，返回列表按 normKey 大小写去重）；`add` 重复参数重新注册客户端持久化的「打开文件夹」仓库 | `ws`、`add`(可多个) |
| `graph` | 提交历史（含 refs 装饰）；`order=date` 用 `--date-order` 按提交日期交错排列（平铺视图用），缺省 `--topo-order`（分组视图用，同分支提交保持连续）；`head` 由 `.git/HEAD` 直读（`readHeadName`）不额外起进程；`total` 首屏问一次 `rev-list --all --count`，之后由客户端 `total=` 回传（翻页只 1 次 spawn），全量请求或首页即覆盖全部时直接取 `commits.length` | `limit`、`skip`、`total` |
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
| `checkupdate` | 对比本地版本与 GitHub 最新 tag（`git ls-remote --tags`，复用 git 全局代理/sslBackend/version 配置），返回 `{current, latest, hasUpdate, managed}`；插件目录在 git 工作区内时 `managed:'git'`、`hasUpdate` 强制 false、`latest` 置空 | — |
| `autoupdate` | 一键自更新：`git clone --depth 1 --branch <tag>` 下载到临时目录 → 校验 `index.js` / `web/index.html` / `web/app.css` / `web/app.js`（缺任一即 `missing-*` 中止，旧安装不动）→ 同级目录备份（`<插件目录>.bak-<ts>`，`pruneBackups` 保留最新 1 份）→ 清空并替换 → 需重启 dsh web 生效；失败自动回滚备份；git 工作区挂载时直接 409 `git-managed` 拒绝 | `tag` |
| `listdir` | 「打开文件夹」目录浏览（只读）：列出子目录（不含文件，跳过 `.git`），每项 `git` 标记=存在 `.git` 条目；无 `path` 时返回盘符列表（win32）或 `/`；返回 `root`（`findGitRoot` 结果，供前端判断「打开此文件夹」可用性）；超 500 项截断 | `path` |
| `addrepo` | 「打开文件夹」确认添加：对路径 `findGitRoot` 向上定位仓库根 → 加入可访问集合（`recentKeys`）→ 返回 `{repo}`；非 git 仓库报 `not-a-git-repo` | `path` |
| `show` / `diff` / `filediff` | 提交详情 / 完整补丁 / 单文件 diff（`filediff` 也是单次 `show --no-color --format= <hash> -- <file>`，不要先查父提交） | `hash`、`file` |

## 关键约定

- **安全**：git 一律 `execFile` 固定参数数组，绝不拼接 shell；`workfile`/`gitop` 的文件路径用 `path.resolve` + `startsWith` 防穿越；长输出截断（`MAX_DIFF_CHARS`）；`gitop` 是**写操作**，客户端必须在破坏性动作（discard / commit）前弹确认框，暂存类可逆操作可直接执行
- **安全防护（v0.21，见 `docs/security-audit-2026-11-05.md`）**：以下几条是安全审计后**必须保持**的约束，改代码时不要绕过：
  - **写操作必须 POST**：`WRITE_OPS = {gitop, autoupdate, addrepo, prefswrite}` 在**服务端**（`index.js`）与**客户端**（`web/index.html` 的 `api()`）各有一份，必须同步。服务端对写 op 校验 `req.method === 'POST'`，GET 直接 405。这是 CSRF 的主防线——`<img>`/`<a>` 发不出 POST。
  - **Origin/Referer 同源校验**：任一存在且与 `Host` 不符就 403 `cross-origin-blocked`。没有这两个头的请求（curl、测试、插件自启动）放行读操作，写操作仍需 POST。
  - **`remoteinfo` 只准 http(s)**：`isSafeWebUrl()` 用 `new URL()` 解析后比对协议，`javascript:`/`data:`/`vbscript:`/`file:` 一律返回 `web:null`。**这个值会进 `window.open()`**，绝不能直接回显 remote 原文。
  - **拒绝响应不泄露路径**：`repo-not-allowed` 只返回 `count`，不再回显 `repos` 数组（曾把本机全部仓库绝对路径回给调用方）。
  - **HTML 插值必须 `escHtml()`**：文件名/分支名/标签名都来自仓库，属不可信输入（Linux/macOS 上文件名可含 `<>`）。`confirmDialog` 的 `bodyHtml` 是唯一 `innerHTML` 注入点，**所有** repo 派生文本都要过 `escHtml`（`ignoreConfirm`/`discardConfirm`/分支名/标签名已全部覆盖）。
  - **响应头**：JSON 与页面都带 `X-Content-Type-Options: nosniff` + `no-store`；页面与两个静态资源带 CSP（`default-src 'none'` + `script-src 'self'` + `style-src 'self'`，见下条「页面拆分为三文件」）。
  - 未做：`iframe sandbox` —— 同源 iframe 加 `allow-scripts allow-same-origin` 等于没有隔离（iframe 可自行移除 sandbox），去掉 `allow-same-origin` 又会破坏 localStorage 与 API 鉴权，属负收益，故不加。
- **性能铁律：进程创建才是瓶颈（v0.16，v0.18→v0.19 逐轮补漏）**：量性能必须用 node 的 `execFile`+`hrtime`（bash 的 `date +%s%N` 会被 bash 自身启动污染成 ~440ms）。两个不同量级的数字都要记住：独立 node 进程里单次 `git` 约 **217ms**；而在 **DSH 宿主进程里约 870ms**（同一台机器装了腾讯管家 + 亚信防毒 + Defender，进程创建被串行化，并行没有收益）。所以判断快慢要看「DSH 内实测」，不能只看 mock。优化只看「每个 op 起几个 git」：
  - **每个请求的公共校验绝不能起进程（v0.18 最大的一处遗漏）**：路由入口的「是不是 git 仓库」校验原本用 `await isGitRepo()`（= 一次 `git rev-parse`），排在所有 op 之前，**每个请求都白付一次 spawn**。改用 `hasGitEntry()`（`statSync(.git)`）。`isGitRepo` 现在只剩 `addrepo`（用户手动开文件夹，一次性）在用
  - **能读文件就不起进程**：分支名读 `.git/HEAD`（`readHeadName`）；**refs 全量读盘（v0.19，`readRefsFromDisk`）**——`branches` 和 5s 轮询的 `head` 都改成 0 spawn（871ms → 1~2ms）。实现要点：先读 `packed-refs` 再扫松散 `refs/**`（松散覆盖打包），**符号引用必须两遍解析**（先收集所有 ref，再解 `ref: ` 目标）——否则 `origin/HEAD -> origin/master` 会取到 packed 里的旧 sha。读不出来时回退 `for-each-ref`
  - **能合并就合并**：`show` 用一条 `show --stat`（meta+stat）；`filediff` 用一条 `show <hash> -- <file>`（**不要先查 `%P` 父提交**）；`workstatus` 分支名取自 `status --branch` 的 `## ` 头
  - **能跳过就跳过**：`workstatus` 干净时跳过 `numstat`（3 → 1）；`graph` 的 `total` 首屏用 `count=0` 让客户端**异步**补（新增 `count` op），翻页复用 `total=`
  - **轮询必须轻**：5s 轮询用 `head`（v0.19 起 0 spawn）
  - 改任何 op 前先估算 spawn 次数。**v0.19 后的下限：`branches`/`head` 为 0，`repos` 为 0，其余都是每次请求 1 次**
- **新 op 必须带客户端降级**：`count` 是新增 op，旧宿主返回 `unknown-op`。`refreshTotal()` 用 `COUNT_OP_OK` 记住一次失败并回退到「graph 带 total」，否则 `TOTAL` 会永久停在页长、把后面的提交全部藏掉。同理 `hasMore()` 把 `TOTAL===0` 视为「未知」而不是「没有更多」，否则 count 在飞时按钮和滚动加载会一起消失
- **`show` 解析注意**：meta 与 stat 用 `\x1e--STAT--\x1e` 标记行分隔，**不要**用 `\x1f\x1f` 之类的字段组合——root commit 的 `%P` 为空，会产生连续 `\x1f` 导致元信息被提前截断（曾因此把 subject/author 解析成空串）
- **写操作刷新流**：`gitop` 成功后清空 `wdDiffCache` → `refreshWorkdir()`；`commit` 等改变历史/分支的操作用 `reloadGraphLight()`（不重新解析会话工作区）
- **diff 高亮**：统一用 `highlightDiff(pre, text)` 渲染 diff（行级 `.df-head/.df-hunk/.df-add/.df-del`）；未跟踪内容/错误信息仍用 `pre.textContent`
- **分页与缓存（v0.17）**：`graph` op 支持 `limit`/`skip` + `total`。客户端首屏 `PAGE_INITIAL=50`，下滑续拉 `PAGE_MORE=100`（`loadMore()` 追加去重，`LOADING_MORE` 防并发、`PAGINATION_EXHAUSTED` 防空页死循环，全量 `load`/`reloadGraphLight` 时重置）。**只有真实滚动才触发续拉**：监听在 `#graphWrap`（它才是 `overflow:auto` 的滚动容器，window 的 scroll 在 iframe 里收不到），`maybeAutoLoad()` 用 rAF 节流；列表短于视口时（分支组默认折叠时很常见）**刻意不自动填满**，否则会在用户没要求时把每一页都偷偷拉完——此时由「加载更多」按钮兜底。`total` 只在需要精确总数时才补跑 `rev-list --all --count`（全量请求用 `commits.length`；末页未满用 `skip + commits.length`），避免每次翻页多起一个进程
- **响应缓存（v0.17）**：`DETAIL_CACHE`(hash→{info,diff}) / `FILEDIFF_CACHE`(hash\\0file) / `FILELOG_CACHE`(file)，`cacheGet` 做 LRU touch、`cacheSet` 超 `PAGE_LIMIT=400` 淘汰最旧。**只放内存 Map、绝不写 localStorage**：图谱跑在插件自己的 iframe 里（`client.js` 渲染 `/git-graph/index.html`），关标签/刷新/关插件/重启都会连整个 document 一起销毁，「关闭后清理」由结构本身保证；另外 `pagehide`/`beforeunload` 主动 `clearResponseCache()`，兼作 bfcache 复活时的兜底。失效时机：**切换仓库**（hash/路径跨仓库不通用）、**任意 `gitop` 写操作成功后**（`runGitOp` 里）；提交数据本身不可变，因此详情缓存不需要过期策略。**`showFileDiff`/`showFileHist` 必须先判断「是否已展开」再发请求**（原来是先 fetch 再判断要不要收起，导致点 ✕ 收起也白跑一次 git）
- **状态记忆**：`loadStored/saveStored` 封装 localStorage；键统一 `gg2-` 前缀（v0.8 起）：`gg2-theme`、`gg2-wdshow`（分组开关）、`gg2-wdfolded`（面板折叠）、`gg2-wdgroupfolded`（组折叠）、`gg2-brfolded`（分支组折叠）、`gg2-bfilter-hidden`（v0.22 起：分支过滤的**隐藏** refname 黑名单，null/[] = 全可见）；分支过滤按 refname 记忆（sha 会变）。v0.11 新增：`gg2-repos`（「打开文件夹」添加的仓库路径数组，每次 `load()` 通过 `repos?add=` 重新注册到服务端）、`gg2-currepo:<工作区>`（上次选择/打开的仓库，**按工作区分键**，见下条；加载时优先选它）。`gg2-flat`（平铺视图开关）。v0.15 新增：`gg2-detailw`（详情面板宽度 px，null/非法值=回落 CSS 默认）
- **搜索/日期是「过滤」不是「高亮」（v0.23）**：顶栏搜索与日期区间都会**隐藏**不匹配的提交（`passesFilters()` = `matches() && withinDateRange()`），不再给匹配行加黄圈。判定入口统一走 `passesFilters`/`filtersActive`，新增筛选条件只改这两个函数。**组头的处理有坑**：`buildRows()` 在分支组折叠时**根本不产出 commit 行**，所以不能用「等首个通过过滤的提交出现再吐组头」——那样折叠组的组头会全部消失。正确做法是先用 `groupCounts` 按每条分支的 first-parent 链**独立**统计通过过滤的提交数（**不跨分支去重**，否则 local 与它的 remote 双胞胎会互相吃掉计数），再据此决定组头显隐：折叠组直接输出组头，展开组用 `pendingHead` 延迟到首条提交处输出。空态判定同理，**不能只看 `commitRows.length === 0`**（全折叠时本来就为 0），要看 `groupCounts` 的合计。
- **日期区间按本地日边界（v0.23）**：`DATE_FROM`/`DATE_TO` 存 `YYYY-MM-DD`，比较用 `dayStart()`/`dayEnd()`——结束日按 **23:59:59.999** 计算，所以结束日当天 23:50 的提交仍然算入；任一端可空（单侧边界），两端都空 = 不限。起止选反了自动交换（不弹错误框）。持久化键 `gg2-datefrom`/`gg2-dateto`（已在服务端偏好白名单里）。
- **日期选择器是应用内日历（v0.25.1，改这块前必读）**：`<input type="date">` 已**全部移除**，`#dateMenu` 里不再有任何 `<input>`。原因是原生控件的日历弹窗由浏览器绘制，CSS 碰不到，而截图里那正是最丑的一块。
  - **草稿态与生效态分离**：面板里的 `dFrom`/`dTo` 是**草稿**，只有 `applyDateRange()` 才写进 `DATE_FROM`/`DATE_TO`。`dDirty` 表示两者是否不同，**「应用/关闭」按钮的文字和主色都由它驱动**——没有改动时按钮是次要的「关闭」，否则会是「应用」。关闭路径（点按钮、点外部、再点触发器）**有改动就应用、没改动就只关**；唯独 `Esc` **丢弃草稿**，这是唯一能放弃半截区间（只有起没有止）的出口。
  - **一个网格写两端**：`dEnd` 指明日历当前写哪一端，`#dateFromChip`/`#dateToChip` 的 `.active` 表示它。点一天写当前端，若另一端为空则**自动切换**过去，所以「先点起点再点终点」不需要手动切标签；顺序反了在 `applyDateRange()` 里统一交换，不要在 `pickDay()` 里报错。
  - **`renderCalendar()` 会重建 42 个按钮，必须自己恢复焦点**：`pickDay()` 在重建后把焦点还给同一天，否则键盘用户按 Enter 选日期后 `document.activeElement` 变成 `<body>`，方向键立刻失效（实测过）。同理网格用**游标式 tabindex**（只有一个 `tabIndex=0`），不要给 42 个按钮都能 Tab 到。
  - **面板 `position: fixed` + 显式坐标**（`positionDateMenu()` 写 `left`/`top`）：原生弹层是 `right:0; top:32px` 的绝对定位，300×420px 在窄屏会横向溢出、在矮窗口会整块掉到屏幕外（实测 420px 高时 `top: -418`，完全不可达）。现在按「下方有空间就下方 / 否则翻到上方 / 都不够就夹进视口」放置，比视口还高时设 `maxHeight` + `overflowY: auto`。**不要退回纯 CSS 锚定**，`resize` 时也要重新调用（已挂在窗口 resize 上）。
  - **弹层打开时方向键归日历**：`window` 的 keydown 里有 `if ($("dateMenu").classList.contains("show")) return;`。少了这一条，在网格里按 ↓ 会**同时**移动焦点和背后的提交选中（列表就在旁边，看着像"按一次跳两下"）。反向验证方式：临时删掉该行，`grid owns arrows while open` 立刻变红（选中从 `0004…` 跳到 `0007…`）。
- **点外部收起弹层只有一条通路（v0.26.0，改这块前必读）**：分支过滤、日期、未提交改动的分组菜单、右键菜单，全部由**一个** `dismissPopovers()` 负责，注册在 `window` 的**捕获阶段**，且 `pointerdown` 与 `click` 各挂一次。四个必须保持的约束：
  - **必须捕获阶段，不能用 `document` 上的冒泡监听**。原先是一堆冒泡 `click` 里做 `if (!closest(...)) close()`，而用户接着会点的地方——**提交行、分支组头、`全部暂存`**——自己调了 `ev.stopPropagation()`，事件根本到不了 `document`。实测（真实 Chrome + 真实仓库）：过滤菜单打开后点提交行**不收起**，日期面板同样；更糟的是日期草稿会被**之后**某次无关点击才应用，列表拿早已放弃的日期重过滤一遍。
  - **必须同时听 `pointerdown`**：`disabled` 的 `<button>` **不派发任何** mouse/click 事件，只派发 pointer 事件。未提交改动面板的「全部暂存」「提交」在工作区干净时正是 `disabled`，点它一个事件都不产生（插桩 mousedown/mouseup/click 到 window 捕获，日志全空），菜单于是不收起。`pointerdown` 在禁用控件上照常触发。
  - **但日期草稿的应用只能放在 `click` 阶段**——这是踩过的回归，不是洁癖：`applyDateRange()` 会 `render()` 重建整个提交列表。在 `pointerdown` 里做，被按下的那行在 mouseup 之前就被销毁，mouseup 落在游离节点上 → **不合成 click** → 用户点的提交根本没被选中（实测 `SELECTED` 仍是 `null`）。用 `setTimeout(0)` 从 pointerdown 推迟也不行，定时器同样早于 mouseup。正确做法：`pointerdown` 只关面板并记 `dateDraftOwed`，`click` 阶段才提交；`pointerup` 再挂一个 `setTimeout(0)` 兜底，覆盖"按下后拖走再松手"这种不产生 click 的序列。事件路径在派发时即固定，所以 `click` 阶段的重渲染**不会**吞掉这一下（实测行自己的监听仍会执行，`SELECTED` 正确）。
  - **"里面"的判据要含触发器本身**（`.filterWrap` / `.dateWrap` / `.wd-filterWrap` / `#ctxMenu`），否则点触发器想收起时会被先关掉再被触发器自己的 handler 打开，变成关不掉。
- **两个弹层互斥**：日期面板与分支过滤**不能同时开着**（都会遮住列表）。这不是单独写的逻辑，而是上面捕获监听的副产品——打开另一个时，被点的目标不在前一个的 wrap 内，前一个就先被收起了。反向验证：旧代码上 `max=2`（两个同时开），新代码 `max=1`。
- **分支过滤菜单窄屏要夹进视口（`positionFilterMenu()`）**：它是 `position:absolute; right:0` 挂在触发器下，只在触发器离左边足够远时成立。`≤560px` 时 header 换两行且 `.hd-center` 变 `justify-content:flex-start`，触发器靠近左边缘，200px 的菜单按右边缘定位就直接豁出去（实测 520px 宽时 `left = -100`，一半点不到）。现在按视口夹紧，**且只在越界时才改**，正常宽度保持原来的右对齐观感。两个细节：菜单的 `offsetParent` 是 `.filterWrap`，写 `left` 前必须把视口坐标减去父级偏移；`resize` 时要重算（挂在已有的 resize handler 上，与 `positionDateMenu()` 并列）。
- **偏好持久化到服务端（v0.22，修「分支过滤重进就没了」；v0.25.1 修「切换 tab 配置被改掉」）**：`localStorage` 按 **origin** 隔离，而 DSH 的 web 端口每次启动可能变化（如 10426 → 5828），换端口后所有 `gg2-*` 记忆会**静默清空**——这就是"选了分支、重进又没了"的真正原因（不是保存逻辑坏了）。因此把 UI 偏好**同时写一份到服务端**：`op=prefs` 读、`op=prefswrite` 写（POST），落盘于 `<插件目录>/.state/prefs.json`（已 gitignore，不跟仓库走）。服务端有**白名单** `PREFS_ALLOWED_KEYS`（只允许 bfilter / wdshow / wdfolded / wdgroupfolded / brfolded / theme / datefrom / dateto / flat / flat-reset），其它 key 一律忽略；单文件上限 256KB。启动时 `prefsLoad()` 先把服务端值灌回内存再首次渲染，保证第一帧就是筛选后的状态。旧宿主（未重启、无 prefs op）用 `PREFS_OP_OK` 记住一次失败后降级为纯 localStorage，不刷错误请求。
- **「切换 tab 配置被改掉」的四个真因（v0.25.1，改这块前必读）**：
  - **同一份偏好在两个 store 里用了两种格式**。`gg2-theme` 曾被 `setTheme()` 用**裸字符串**写（`localStorage.setItem("gg2-theme", themePref)`），而 `prefsLoad()` 用 `saveStored`（JSON）写回。于是读回的是带引号的 `"ocean"`，`THEMES.includes` 判假 → **顺手删掉这个键**并回落 `auto`。现在统一走 `saveStored`，读取用 `readStoredTheme()` **同时接受两种形式**（先 `JSON.parse`，失败再按旧值处理）。**新增任何 key 都必须成对用 `loadStored`/`saveStored`，不要手写 `localStorage.setItem`。**
  - **`prefsLoad()` 只把主题写进 localStorage，没赋值给 `themePref`**。`themePref` 在脚本解析时就从 localStorage 初始化了，而换端口后那个 store 是空的，所以本次加载仍是 `auto`。现在末尾显式 `themePref = p["gg2-theme"]` 再 `applyTheme()`。**通用规则：状态变量必须在 `prefsLoad()` 里被赋值，只写 localStorage 等于只为"下一次加载"恢复。**
  - **一次性迁移标记只存在 localStorage 里**：`gg2-flat-reset` 丢了后 `FLAT_DEFAULT_MIGRATED` 变假，「把平铺重置为 false」的逻辑**再跑一次**，把用户选的平铺改回分组。现在该标记进白名单并持久化，且**服务端存在显式 `gg2-flat` 本身就当作"用户已选择"的证据**——有它就不重置，无论标记在不在。另外 `prefsSync` 在 `PREFS_LOADED` 之前会直接 return，所以迁移的写必须**推迟到 `PREFS_LOADED = true` 之后**（原来写在迁移分支里等于静默丢弃）。
  - **`applyFilter()` 曾无条件持久化**：`fillFilterMenu()` 每次加载都调它，于是每次加载都写一次服务端；更糟的是**没有 `.fBranch` 复选框时**（`branches` 请求失败）它从空 DOM 推出「什么都没隐藏」并写入 `[]`——**一次瞬时 git 失败就把用户的分支筛选永久清掉**。现在无复选框时只按未筛选渲染、**不动存储**，并且只在值真变了才写。
- **分支过滤存"黑名单"（v0.22）**：`HIDDEN_REFS` 存**被隐藏**的 refname（`null`/`[]` = 全可见），而不是"已勾选"。这样**新建分支默认可见**——旧方案存可见列表，新分支不在列表里就被判为隐藏，表现为"我的分支凭空消失"。`applyFilter()` 每次都从 DOM 重算黑名单并**顺带收敛**（不存在的 ref 自动剔除）。旧键 `gg2-bfilter`（可见列表）由 `migrateLegacyFilter()` 在首次拿到 `BRANCHES` 后一次性迁移成黑名单，然后删掉旧键。
- **空筛选结果必须给出口（v0.23）**：列表为空时给提示 + 出口按钮，但**判据必须区分三种空**：①分支全被隐藏 → 「恢复全选」；②搜索/日期无匹配 → 「清除筛选」（`clearFilters()`）；③**只是分支组全折叠** → 什么都不显示（这是正常状态，只按行数判断会误报）。统一用 `nothingToShow` 判定：有筛选时看 `groupCounts` 合计是否为 0，无筛选时才看行数且排除"全部折叠"的情况。

- **详情面板可调宽（v0.15）**：`#main` 内 `#graphWrap` 与 `#detail` 之间插入 `#detailGrip`（6px 分隔条，`display:none`，仅 `#main.detail-open` 时显示；≤760px 覆盖态同样隐藏）。`#detail.open` 宽度取 `var(--gg-detail-w, 430px)`（CSS 仍是默认值真源，用户拖动后才写内联变量到 `document.documentElement`）。拖动用 Pointer Events + `setPointerCapture`（覆盖鼠标/触屏/笔），拖动中给 `#detail` 加 `.no-anim` 关掉 160ms 宽度过渡、`body.gg-col-resize` 全局改光标；宽度夹在 `[260, min(1200, mainW-520)]`（预留图谱可用空间）。双击分隔条清空存储并恢复默认；方向键 ±12 / Shift ±40 无障碍微调；`resize` 时重新夹紧。**打开/关闭详情一律走 `setDetailOpen(bool)`**（同时切 `#detail.open` 与 `#main.detail-open`，后者驱动分隔条显隐），不要再单独 `classList.add/remove("open")`。程序化改宽（恢复/重置/resize）用 `withoutDetailAnim(fn)`：加 `.no-anim` 后必须在**下一帧**（rAF 两次）移除，同帧移除会让过渡从旧宽度重启动画
- **打开文件夹**（v0.11，v0.25 起顶栏按钮为纯图标）：客户端 `listdir`/`addrepo` 走顶栏右区第一个图标按钮 `#btnOpenDir`（悬停提示「打开文件夹」）或空态按钮 `#btnOpenDirEmpty`；选中文件夹 `addrepo` 成功 → 写入 `gg2-repos`（+ `saveCurRepo`）→ `REPO=新仓库` → `load()` 全量重载；空态时 `REPO` 为 null 且 `api()` 不带 repo 参数，服务端 `listdir`/`addrepo`/`repos` 在 repo 校验之前处理，无碍
- **右键菜单**：无害操作（复制/查看详情/打标签/从提交新建分支/打开 GitHub 提交页/复制仓库路径/打开文件夹）；写操作走 `gitop`（tag / tag-delete / tag-rename / branch），`remoteinfo` 失败或无远程时 GitHub 项给出提示
- **远程/分支操作**（v0.9，v0.25 起顶栏按钮为纯图标）：顶栏 `#btnFetch`（`gitop fetch` = `git fetch --all --prune`）+ `#btnPush`（`gitop push` 当前分支，确认框「确认推送」）；分支组头右键菜单——本地分支：🔄 切换（`checkout`，有未提交改动时先确认）、⬆ 推送该分支、🗑️ 删除（`delete-branch`，`-d` 拒绝未合并分支，HEAD 分支禁止删除）；远程分支：⬇ 拉取、复制远程分支名。fetch/pull/push 用 120s 超时（`runGit` 第 4 参）；**远程组头始终生成**——chain 为空（无独有提交）时仍显示组头，标签区分「已同步」（tip 等于同名本地分支）与「已包含」（提交全部由其他组显示）
- **跟随工作区切换（v0.20）**：图谱跑在 iframe 里，`?sid=` 在元素创建时就固定了，DSH 切换工作区时**复用同一个 iframe**（document 不重建），所以不加轮询就会一直显示旧仓库。`checkSessionWorkspace()` 每 3s 调 `resolveSessionWs()`（它优先匹配 `?sid`，无 sid 时回退「最近活跃会话」，因此独立打开页面也能跟随），`ws !== SESSION_WS` 时清缓存并 `load(ws)`。`load()` 用 `load.INFLIGHT` 防重入（切换与手动刷新可能并发，慢的那个会画错仓库）。
- **「上次选的仓库」必须按工作区分键（v0.20 修的真正根因）**：之前用单一全局键 `gg2-currepo`，而它在 `load()` 里**优先于会话工作区**——切到工作区 B 后只要旧仓库 A 还在白名单里，`current` 就仍是 A，表现得像「图谱无视切换」。改用 `gg2-currepo:<工作区路径>`（`curRepoKey/loadCurRepo/saveCurRepo`），各工作区各记各的，切换必跟随、切回还记得。**新增读仓库偏好的地方一律走这三个函数，不要再直接读写 `gg2-currepo`**。
- **自更新**（v0.10，v0.14 起按挂载形态降级，v0.25 起按钮变纯图标）：`load()` 后静默调 `checkForUpdate(true)`；响应带 `managed:'git'`（插件目录在 git 工作区内，`gitManaged()` 服务端检测并缓存）时隐藏 `#btnUpdate`，手动检查提示 `git pull`；否则有新版时显示立方体图标（`.has-upd` 高亮，版本号只在 `title`/`aria-label` 里，**不改按钮宽度**），点击 → 确认框「发现新版本」→ `autoupdate` → 提示重启生效；手动点击按钮在无更新时提示已最新；版本号取自 `package.json` 的 `version` 字段（远程地址在 `repository.url`）
- **标签管理**：打标签对话框（`openTagDlg`）列出该提交已有标签，每行 ✎ 改名（`tag-rename`：先建新名于同 commit 再删旧名）+ ✕ 删除（`tag-delete`，确认框按钮「确认删除」）；`confirmDialog(title, body, danger, okLabel)` 支持自定义确认按钮文字
- **批量操作**：行复选框选择（`WD_SELECT`，键 `groupKey\0path`）→ `updateBatchBar()` 渲染批量条（暂存/取消暂存/还原/忽略/提交选中）；`commit` 带 `file` 时只暂存并提交这些文件（selective commit）；`ignore` = 追加 `.gitignore`（去重）+ 已跟踪文件先 `git rm --cached`（保留磁盘文件）；写操作成功后统一 `WD_SELECT.clear()`；「放弃/还原」统一叫**还原**（`discardConfirm`，确认框标题「还原更改」）
- **客户端**：纯 JS + `React.createElement`（无 JSX/TSX 转换）；Slot 注册用 `ctx.slots.register`；`inject` 只声明实际使用的服务
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
  - **旧宿主安全降级**：服务端只读它认识的 query key，老 `index.js` 会忽略 `order` 并退回 topo 序，页面不会报错（只是平铺下顺序不是时间线）。
  - **refs 标签在消息之前**：行内 refs（`.cl-refs`）渲染在 subject **左侧**、紧随泳道 gutter，而不是跟在消息尾部。分支/tag 名是最短、最便于扫读的部分，固定在左侧后可整列竖着扫；尾随在 subject 后面会漂到"这句话恰好结束的地方"，离视线起点很远。**配套约束**：`.cl-msg` 必须 `flex: 1 1 auto; min-width: 0`，否则标签前置后长 subject 不再占满剩余宽度、省略号失效。
  - **泳道图只在平铺模式显示**：`buildCommitRow()` 里只有 `FLAT_MODE` 为真才创建 `.cl-graph` 占位，`renderLaneGraph()` 也在开头直接 `if (!FLAT_MODE) return`（顺带跳过 O(n) 的 `ensureLayout`）。**分组模式左侧什么都没有**——组头那一行没有提交节点，画出来必然断线，用户明确要求此时不显示，而不是显示一条会断的线。改这块时别把两个渲染路径合并。
- **页面拆分为三文件（v0.26.0）**：`web/index.html` 只剩骨架（markup + `<link rel="stylesheet" href="app.css">` + `<script src="app.js"></script>`），样式在 `web/app.css`，逻辑在 `web/app.js`。**不要把它们合并回去**，理由与约束如下：
  - **拆分的目的就是收紧 CSP**。原先单文件必须 `script-src 'unsafe-inline'` + `style-src 'unsafe-inline'`；拆成外部文件后两条都变成 `'self'`，页面不再需要任何内联许可（`PAGE_CSP` 在 `index.js` 顶部，页面与两个资源共用同一份）。**评审时认这一点**：`'unsafe-inline'` 是否真的消失了，比文件是否分开更重要。
  - **`style="..."` 属性会被 `style-src 'self'` 拦掉**（实测：Chrome 报 "Applying inline style violates …"，该属性整条失效）。所以 markup 里**不允许出现 `style=` 属性**；需要静态样式就写进 `app.css`，需要动态改就写 CSSOM（`el.style.x = …` / `setProperty`）——**CSSOM 写入不受该指令限制**（已实测：`style.color=`、`cssText`、`setProperty`、`insertRule`、`new CSSStyleSheet()` 全部照常工作，只有 `setAttribute('style', …)` 和静态属性被拦）。隐藏元素统一用 `.gg-none`（`display:none !important`），不要再写 `style="display:none"`。
  - **`app.css` 的缩进从 0 开始**：原来嵌在 `<style>` 里整体缩进两格，抽出时已去掉外层那两格，内部相对缩进保留。改样式时别再假设有外层缩进。
  - **`index.js` 用显式白名单提供这两个文件**（`/git-graph/app.css`、`/git-graph/app.js`），不是目录服务器——`web/` 目录以后放别的东西也不会被意外送出。新增第三方资源必须同时改这里、`PAGE_CSP` 与 `scripts/publish.mjs` 的检查。
  - **发布链与自更新都要校验它们存在**：`scripts/publish.mjs` 断言 HTML 里引用了 `app.css`/`app.js` 并直接 `node --check web/app.js`；`autoupdate` 在替换安装前检查 `web/app.css`/`web/app.js`（缺失就 `missing-web-css`/`missing-web-js` 中止，旧安装原样保留）。少一个文件就是一个白屏，所以这两处检查不是冗余。
  - 验证方式：`web/index.html` 里出现 `<style>`/内联 `<script>`/`style=` 之一即视为回归；等价性可以用「旧单文件 vs 新三文件」同数据渲染后比对计算样式与截图（v0.26 实测 19/19 字段一致、截图逐像素相同）。
  - **升级窗口期会白屏，`#bootFail` 是为此存在的（v0.26.0）**：`web/` 三个文件**每个请求都从磁盘重新读**，而 `index.js` 只在宿主启动时加载一次。所以「插件更新了、dsh web 还没重启」这个窗口里，新 `index.html` 会被送出去，但它引用的 `app.css`/`app.js` 在**旧**服务端里没有路由 → 双双 404 → 页面只剩无样式骨架。**这不只发生在开发时，任何从旧版本升级的用户都会遇到**，因此 markup 里带一块 `#bootFail` 提示，明说「重启 dsh web 即可恢复」。三条约束：
    - **它必须在 CSS 完全没加载时也读得出来**，所以 markup 里是纯文本 + 浏览器默认样式，**不要给它加 `style=` 属性**（那正好会被严格 CSP 拦掉，等于在最需要它的时候失效）。
    - **靠自己淡入，不靠 JS 显示**：`opacity:0` + `animation: bootReveal 0s linear 1.2s forwards`。健康加载时 `app.js` 在 1.2s 内就把它移除，所以正常路径完全看不到它（实测采样 `op=0 → gone`）；而 `app.js` 挂掉时没有人负责隐藏，它就自己浮现。**不要改成「JS 检测失败后才显示」**——JS 没加载时那条路径根本不会执行。
    - **必须是 `position:fixed`，不能留在文档流里**。`opacity:0` 不占位是错觉：它在流里时会把 `header` 下推整整一个卡片的距离，`app.js` 移除时再弹回去。实测在流里插入该元素 → `header` 下移 **209px**；改 `fixed` 后位移 **0**。所以这条不是审美，是加载期的布局抖动。
    - 判定「CSS 是否真的生效」**必须用专用哨兵自定义属性** `--gg-page-ready`（定义在 `app.css` 的 `:root` 里）：`getComputedStyle(document.documentElement).getPropertyValue("--gg-page-ready") === "1"` 即视为样式表已生效。**不要用颜色判断**（旧写法比较 `body` 的 `color`/`backgroundColor`）：11 套主题里有 8 套的 `--bg` 是**渐变**、画在 `<html>` 上，`body` 背景因此透明，任何颜色探针都会判成「没有样式表」——本项目实测踩过：表现是**正常加载时也弹出「Git 图谱未能加载」**（8/11 主题全中）。也不要用 `document.styleSheets.length`——404 的 HTML 错误页在部分浏览器里也会被计入 styleSheets。
    - **样式表 404 时提示必须自己重新钉住**：让它 `position:fixed` 的那条规则就在**缺失的那个样式表**里，所以此时它回到普通文档流；而 `app.js` 仍在正常跑，`selectCommit()`/详情面板的 `scrollIntoView` 会把页面滚走，连带把提示带到屏幕外（实测 `scrollY 2312`、提示 `top -2304`，用户完全看不到——而这是它唯一存在的场景）。所以 `clearBootNotice()` 在哨兵缺失分支里用 **CSSOM**（`Object.assign(notice.style, {...})`）重新钉到视口并给足对比度。**这里可以用 CSSOM 但不能用 `style` 属性**：`style-src 'self'` 拦的是内联**属性**，CSSOM 写入不受该指令限制。三种状态均已实测：正常加载 → 提示被移除；CSS 404 → 可见且钉住（`top:12`，即使 `scrollY 2168`）；JS 404 → 宽限窗口内 `opacity:0`/`position:fixed`，之后自行淡入。
- **页面**：`app.js` 顶部 `"use strict"`；API 失败统一 `{ok:false, error}`；主题变量用 `--bg/--text/...` + `html.gg-light`；v0.8 起 **8 种风格方案**（🌸 樱花/🌊 海洋/🌲 森林/🌙 夜空/🍬 糖果/💼 商务/✨ 星河/🤖 科技，移植自拾光记）各带 `#ggDeco` 背景装饰（花瓣/波浪气泡鱼/树草萤火虫/星星月亮流星/彩虹彩带/几何玻璃/地球/电路齿轮），`renderBgDecor()` 按当前风格动态生成，仅彩色风格启用；**`#graphWrap` 背景必须保持透明**（否则实色背景会盖住装饰层），header/statsBar/statusLine 用 `position:relative; z-index:1` 保证内容可读、弹层（菜单 30/40、对话框 60）在其上
- **顶栏三区网格（v0.25）**：`header` 是 `display:grid` + `grid-template-columns: minmax(0,1fr) auto minmax(0,1fr)`，三个子元素 `.hd-left` / `.hd-center` / `.hd-right`。
  - **为什么不用 spacer + flex**：`flex:1` 的空档只能把中间推到「剩余空间的中间」，两侧内容一变宽（仓库路径长了、更新图标出现了）中间就漂。两条等宽 `1fr` 边轨把剩余空间**均分**给左右，`.hd-center` 因此始终落在整条顶栏的中心（实测 1400px 宽下偏移 0.0px，左右各 490.5px）。改这里时**不要退回 flex + spacer**，也不要给某一个边轨写死宽度。
  - **中区顺序固定为 分支过滤 → 日期 → 搜索**（`#btnFilter`、`#btnDate`、`.searchWrap`），在 `.hd-center` 里按 DOM 顺序排列即可，不要用 `order` 打乱——顺序是用户可感知的语义（先缩小范围，再找东西）。
  - **右区**：`#btnOpenDir` / `#btnFetch` / `#btnPush` / `#btnRefresh` / `#btnUpdate` 五个 `.icon-btn`，然后 `.hd-sep` 分隔线，最后 `#btnSettings`（**必须是最右**）。分隔线是必要的：图标尺寸下 8px 的普通间距会让齿轮看起来像「又一个仓库动作」。
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
- **快捷键与「唯一选中态」（v0.24）**：`Ctrl+/` 开关快捷键面板（`#shortcutDlg`）、`Ctrl+F` 聚焦搜索、`Ctrl+B` 折叠/展开全部分支组、`↑/↓`+`j/k` 切换提交并同步打开详情、`Esc` 关闭；提交对话框内 `✨ AI 生成提交信息` 调 `suggestmsg` 填充候选（可编辑）
  - **只有一个游标：`SELECTED`（hash）**。鼠标点击与 `↑/↓`/`j`/`k` 都只写它，**不要再引入 `KEY_IDX` 之类的第二个下标游标**。历史上是两套状态（`SELECTED` 给鼠标、`KEY_IDX` 给键盘），后果是**点选第 6 行再按 ↓ 会从第 1 行开始**——键盘游标从没被告知鼠标去了哪里。更隐蔽的是 `KEY_IDX` 是 `COMMITS` 的下标，却由**过滤后的可见行列表**算出，于是「搜索/日期过滤」或「分支折叠」激活时，虚线框会落在根本不是你刚按的那条提交上。
  - **为什么用 hash 而不是下标**：过滤、折叠、分页都会让下标指向另一条提交，任何下标游标每次 render 后都得重新同步（这正是旧代码反复出错的地方）；hash 是唯一稳定标识。
  - **按下时从 `SELECTED` 出发**：`list.indexOf(SELECTED)` 得当前位；返回 `-1`（选中的提交当前没被渲染：被过滤、在折叠组里、或还没翻到）时 ↓ 从头开始、↑ 从末尾开始，保证按键**总有一次可见的移动**，而不是静默无反应。
  - **`kbdVisibleList()` 直接读 DOM**（`#commitList .cl-row` 的 `data-hash`），不要用 `buildRows()` 重算：`buildRows()` 只知道分支折叠，`render()` 另外还会因 `passesFilters()`（搜索/日期）和 `HIGHLIGHT`（图例高亮）丢行——两边不一致会让方向键「按了没反应」或「一次跳两条」。**DOM 里有什么，用户就能看到并逐条走过什么。**
  - **选中样式 = 背景高亮 + 虚线框，同一个 `.cl-row.sel`**：`.kbd` 类已删除。样式分成两个类时，「详情开着的那行」和「键盘接着来的那行」可以是两行，虚线框的存在正是为了回答"我现在在哪、下一步去哪"。
  - **`buildCommitRow(c)` / `buildHeadRow(r)` 只收实际用到的参数**：`hidden`/`vis`/`hlSet` 曾作为未使用参数一路传下去（`buildHeadRow` 的 `vis`/`hlSet` 从未被读），已删除；行是否需要渲染由调用方（`render()`）判定，构造器不再重复判断。
- **分支过滤语义**：不勾选的分支其提交与分组头完全隐藏；`visibleSet()` 返回空集时显示空列表（禁止回落全显）；`buildRows(vis)` 对本地与远程分支都生成可折叠分组——**过滤激活时，tip 不在可见集的分支直接跳过且不标记 seen**（否则其祖先提交会被吞掉，导致共享该祖先的可见分支组变空），leftovers 也按可见集过滤（已完全合并进已显示提交的分支不重复生成）
- **未提交改动**：常驻图谱顶部 `#wdPanel`（`refreshWorkdir` 拉取 workstatus 并渲染面板 + 状态栏）；分组（staged 按 X 码、unstaged 按 Y 码、`??` 为未跟踪、冲突码 `U`）；`workfile` 按需加载 + 客户端缓存（`wdDiffCache`）；无改动时显示「✓ 工作区干净」；分组显隐由 `WD_SHOW` 控制（顶栏 ☑ 分组菜单），面板/分组折叠用 `WD_FOLDED` / `WD_GROUP_FOLDED`；`#wdPanel` 禁止加 `overflow:hidden`（会裁切绝对定位的分组菜单）
  - **文件列表超过 10 行就在内部滚动（v0.26.0）**：`MAX_WD_ROWS = 10`，由 `layoutWdBody(body)` 给 `.wd-body` 设 `maxHeight` 并加 `.scrolls`（`overflow-y:auto`）。这样滚的是列表，**顶栏的 全部暂存/提交/分组/刷新 和批量条保持钉住**，不会跟着滚走。
  - **上限用真实几何量出来，不要写死行高**：行里有徽标、复选框、可变内边距，展开 diff 后高度还会变，组头也占高度。正确定义是「把 clip 线放在第 11 行的上边缘」——`rows[10].getBoundingClientRect().top - body.getBoundingClientRect().top`，所以不论 11 行怎么分布在几个组里，可见的永远正好 10 行。折叠组里的行 `offsetParent === null` 要跳过（它们测得 0，会把上限拉成 nonsense）。
  - **什么时候重算**：`renderWdGroups()` 渲染后、组头折叠切换后（哪些行是第 11 行会变）、`window.resize`（`relayoutWdBody()`）。**展开单行 diff 时刻意不重算**：行数没变，上限就不该动；重算会用占位文案「加载中…」的高度把上限撑大，等真正内容到了 clip 线就再也对不上了（本项目实测踩过）。展开后 diff 在列表内滚动即可，面板高度保持不变。
  - **`.wd-row` 必须 `flex-wrap: wrap`**：diff 块是 row 的子元素，row 又是 flex 容器；不换行时 diff 会被当成又一个横向 flex item 挤到文件名右边（截图里表现为文件名右侧一大片空白、diff 竖在右上角）。配合 `#wdPanel .wd-row.open .wd-diff { flex: 1 0 100% }` 强制它独占一行、占满整行宽。
  - **滚动条用 `--text3` 而非 `--bg4`**：深色主题 `--bg4`(#222b37) 与面板底 `--bg3`(#1a212b) 几乎同色，thumb 等于隐形；而 `#wdPanel .wd-body` 正是新加的那个常驻滚动区。用 `color-mix(in srgb, var(--text3) 45%, transparent)` 保证 11 套主题下都可见，并给该区域加 `scrollbar-width: thin`。（`opacity` 对 `::-webkit-scrollbar-thumb` 无效，别用。）
- **解析细节**：`porcelain -z` 重命名两条记录（`XY <新路径>` + `<旧路径>`）；`numstat -z` 重命名为 `n\tn` + 旧路径 + 新路径；Windows 路径先 `replace(/\\/g,'/')` 再比较

## 开发与验证流程

1. 修改源码（`index.js` / `client.js` / `web/index.html` / `web/app.css` / `web/app.js`）
2. 语法校验：
   - `node --check index.js client.js`
   - `node --check web/app.js`（页面逻辑已是外部文件，直接检查；`web/index.html` 里若又出现内联 `<script>`，提取后同法检查）
3. 挂载方式（v0.14 起单一真源 = 本仓库）：`dsh plugin --profile web add link:<本仓库路径>` 一次性挂载，之后改代码**无需重新挂载**
4. `index.js` / `client.js` 改动需重启 dsh web；`web/` 三个页面文件刷新即生效
5. 服务端功能测试：构造场景仓库（staged / unstaged / untracked / rename / MM / 删除），用 mock `webServer` 直接调 handler 断言 JSON；页面级用临时 http server + 浏览器验证
6. 版本节奏：功能迭代 → `npm run check:compat` → 锚点版本隔离实测（`pwsh -File scripts/compat-isolated-test.ps1`）→ `package.json` version 同步 → `git commit` → `git tag vX.Y`
7. npm 发布：改名 scoped 包（`npm whoami`）后 `npm run publish:npm`（自动跑语法/兼容/pack 检查链，强制官方 registry）

## 注意

- 提交前检查：不要把本地绝对路径（如 `D:/...`、`C:\Users\<用户名>\...`）写进 `cordis.patch.yml` / README —— 开源仓库使用示例路径占位
- `.gitignore` 已排除 `node_modules/`、`*.log`、`.DS_Store`、`.playwright-mcp/`（浏览器测试残留）
- **编码铁律（教训：BOM 曾导致 Harness 启动崩溃）**：任何 `.json` / `.yaml` / `.yml` 配置文件必须 **UTF-8 无 BOM** 保存。PowerShell 5.1 的 `Set-Content -Encoding utf8` / `Out-File -Encoding utf8` **会写 BOM**（UTF8 带 BOM）——JSON.parse 严格模式不接受 BOM，会导致 `readProfileManifest → JSON.parse` 抛 `SyntaxError: Unexpected token`，Harness 启动失败。**正确写法**：
  - 读：`[System.IO.File]::ReadAllText($path)`（自动处理编码，若需去 BOM 用 `.TrimStart([char]0xFEFF)`）
  - 写：`[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))`（`$false` = 无 BOM）
  - 或 PowerShell 7+：`Set-Content -Encoding utf8NoBOM`
  - 写完必须校验：读回字节前 3 字节 ≠ `EF BB BF`
- **挂载与兼容（v0.14 起）**：profile 以 `dsh plugin add link:` 直挂本仓库（单一真源，旧的 `.dsh/plugins/git-graph` 副本 + `sync-deploy.ps1` 双轨已退役）。兼容声明用官方字段：`engines.dsh` + `peerDependencies["@deepseek-ai/dsh"]`（DSH ≥0.2.0 在 add preflight 与 profile 组合时**强制校验**，不满足直接拒绝）+ `dsh.manifestVersion: 1`；`peerDependenciesMeta` 必须标 optional（防 npm/pnpm 自动安装 peer 本体）。改兼容范围必须先跑锚点版本隔离实测（证据记入 docs/compatibility.md）
- **包名必须 scoped，且三处逐字相同（v0.26.1，改这块前必读）**：npm 上不带 scope 的 `dsh-git-graph` 属于另一个项目（enoughpower/dsh-git-graph），本插件无法沿用，因此包名是 `@shiqyka/dsh-git-graph`。以下**三处必须逐字一致**，`npm run publish:npm` 会在发布前比对并在不一致时中止：
  - `package.json` 的 `name`
  - `client.js` 里 `window.__ModuleLoader__.load({ id })` —— 客户端加载器按**包名**去核对模块注册的 id，不同则标签页**静默消失**（不报错、不打日志）
  - `cordis.patch.yml` 里 insert 行的 `name` —— 组合层用它做 `require.resolve` 再读 `dsh.client` 才带起浏览器半；裸名在这里解析不到任何东西，行不挂载
  - 附带一条：`client.js` 注入样式标签的 `dataset.plugin` 也必须等于包名。核心的 `claimStyles()` 用 `style[data-plugin="<入口 id>"]` 认领样式，写裸名会让这个标签在插件卸载 / HMR 后**留在页面上**。
  - 根因（实测）：`exactPackageSpecifier()` 只接受裸包名或 `@scope/name` 两种形状，随后走 Node 解析；profile 的 `node_modules` 里有什么名字就只能解析到什么名字。所以改名必须同时动 profile 的依赖键与 `dsh.profile.bundles` —— 已装的旧 profile 改完会**静默跳过该 bundle**（`skippedBundles`），表现为「插件不见了」，需重新 `dsh plugin add`。
