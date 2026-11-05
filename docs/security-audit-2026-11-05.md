# dsh-git-graph 安全扫描报告

> **状态更新（v0.21）**：本报告列出的问题**已全部修复**：H-1（写操作改 POST + Origin/Referer 同源校验）、H-2（`remoteinfo` 仅允许 http/https）、M-1/M-2（写操作纳入 POST 校验）、M-3（新增 `escHtml()` 并覆盖全部 HTML 插值点）、L-1（拒绝响应只返回 count）、L-2（nosniff + CSP + no-store）。L-3（iframe sandbox）经评估为负收益，未采纳，理由见 AGENTS.md。修复后的验证结果见文末「修复验证」。


- **扫描日期**：2026-11-05
- **版本**：0.20.0
- **范围**：`index.js`（服务端 1351 行）、`client.js`（60 行）、`web/index.html`（3922 行）、`package.json`、`cordis.patch.yml`
- **方法**：静态代码审计 + 动态验证（用 mock `webServer` 加载真实 handler，构造攻击场景实测，不靠推测）
- **依赖情况**：**零运行时依赖**（`dependencies`、`devDependencies` 均为空；无 lockfile、无 `node_modules`；仅 peer `@deepseek-ai/dsh`），因此不存在第三方供应链 CVE 面

---

## 一、结论摘要

| 等级 | 数量 | 说明 |
| --- | --- | --- |
| 🔴 高危 | 2 | 以下两类问题都能被实际利用 |
| 🟠 中危 | 3 | 需要用户先访问恶意页面或打开恶意仓库 |
| 🟡 低危 | 3 | 信息泄露与加固缺失 |
| ✅ 已验证安全 | 6 类 | 命令注入、路径穿越、密钥泄露等均未发现问题 |

**最重要的两个结论：**

1. **写操作可被任意网页跨站触发（CSRF）**，实测能销毁用户未提交的代码改动。
2. **`remoteinfo` 允许危险 URL 协议**，可导致在用户点击"打开 GitHub 提交页"时执行脚本。

---

## 二、🔴 高危问题

### H-1　写操作存在 CSRF，可跨站销毁未提交代码

**位置**：`index.js` 路由入口（`/git-graph/api`）+ `gitop` 分支

**问题**：

- 所有接口都是 **GET**，`gitop` 这类**写操作**（沉淀/还原/提交/推拉/删分支/打标签）也用 GET
- **没有** Origin / Referer 校验
- **没有** CSRF token
- **没有** 请求方法校验（`req.method` 从未被读取）

任何网页只需一个 `<img src="http://127.0.0.1:PORT/git-graph/api?op=gitop&action=discard&repo=...&file=...">`，浏览器就会自动发出请求。

**实测结果**（模拟 `Referer: https://evil.example/`）：

```
discard 前 keep.txt = "MODIFIED - about to be destroyed\n"
GET /git-graph/api?op=gitop&action=discard&repo=<repo>&file=keep.txt   -> 200 {"ok":true}
discard 后 keep.txt = "important\r\n"        ← 用户改动被销毁
```

同类实测还成功写入了 ref：

```
GET ...&action=tag&name=pwned-by-evil&hash=HEAD  -> 200 ok
当前 tags: "pwned-by-evil"
```

**影响**：任意网页（含恶意广告 iframe）可在用户不知情时丢弃其未提交改动、提交、切换分支、删除本地分支、推送。

**说明**：因为未设置 `Access-Control-Allow-Origin`，攻击者**读不到**响应内容，但**写操作的副作用已经发生**——这足以造成破坏。

**建议修复**：

1. **写操作改为 POST**，并校验 `method === 'POST'`（仅此一项就能挡掉 `<img>`/`<a>` 类攻击）
2. 校验 `Origin`/`Referer` 必须同源（`127.0.0.1:PORT` 或 `localhost`）
3. 加 CSRF token（页面加载时下发，写操作回传）

> 注：若宿主 DSH 已对 `/git-graph/*` 统一鉴权（本插件自身没有做），可利用性会下降，但"写操作走 GET"仍是应修的缺陷——它绕过了浏览器对跨站请求的基本防护设计。

### H-2　`remoteinfo` 未限制 URL 协议，`window.open` 可变脚本执行

**位置**：`index.js` `remoteinfo` → `web/index.html:3721` `window.open(res.web + "/commit/" + hash, "_blank")`

**问题**：`remoteinfo` 把仓库的 `origin` 远程地址原样转换为 `web` 字段返回，**未校验协议**；前端直接拼进 `window.open`。

**实测**（把 `origin` 设为对应值）：

| `origin` 设置 | 返回 `web` | 前端实际调用 |
| --- | --- | --- |
| `javascript:alert(1)//` | `javascript:alert(1)` | `window.open("javascript:alert(1)/commit/abc1234")` ⚠️ |
| `JAVASCRIPT:alert(1)//` | `JAVASCRIPT:alert(1)` | ⚠️ 大小写未拦 |
| `data:text/html,<script>alert(1)</script>` | 同左 | ⚠️ |
| `vbscript:msgbox(1)//` | `vbscript:msgbox(1)` | ⚠️ |
| `file:///C:/Windows/` | `file:///C:/Windows` | ⚠️ |
| `https://github.com/u/r.git` | `https://github.com/u/r` | ✅ 正常 |

**攻击路径**：用户 clone/打开一个恶意仓库（其 `.git/config` 里 `origin` 被构造成 `javascript:`），在右键菜单点"打开 GitHub 提交页"即触发。

**建议修复**：服务端只允许 `https?:` 协议（白名单校验），不合法时返回 `web: null`；前端 `window.open` 前再校验一次 `new URL(web).protocol`。

---

## 三、🟠 中危问题

### M-1　`listdir` 未授权即可遍历整个磁盘

**实测**：

```
listdir C:/Users            -> 200，返回目录列表
listdir C:/Windows/System32 -> 200，返回目录列表
listdir E:/                 -> 200，返回盘符与目录
```

`listdir` 在 `repo` 校验**之前**处理（设计如此，便于空态选仓），因此**无需任何仓库上下文、无需认证**即可枚举本机目录树。攻击者结合 H-1 的 CSRF 可进一步枚举目录结构。

**建议**：限制在用户已授权的工作区/盘符范围内，或要求先有会话上下文。

### M-2　`addrepo` 可把任意 git 仓库纳入访问范围

**实测**：

```
addrepo E:/path/to/some-repo -> 200 {"ok":true,"repo":"..."}
随后 graph 读取该仓库             -> 200 ok=true，成功读出提交
```

任意 git 仓库都能被加入可访问集合，随后即可读取其提交历史、diff、分支。配合 CSRF 可静默扩大攻击面。

**建议**：`addrepo` 应要求人工确认（它本身就来自用户点选文件夹的交互，可校验来源会话）。

### M-3　`ignoreConfirm` 的路径未转义即写入 `innerHTML`（跨平台存储型 XSS）

**位置**：`web/index.html:2650` `confirmDialog` 的 `bodyHtml`

```js
"将把这些文件<b>加入 .gitignore</b>：" +
  "<div class='dlg-list'>" + paths.join("\n") + "</div>"     // paths 未转义
```

`confirmDialog` 最终执行 `$("ggDlgBody").innerHTML = bodyHtml`。

**对照**：同一文件的标签删除处**做了转义**（`web/index.html:3601`）：

```js
const safe = String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
```

说明作者有转义意识，此处属遗漏。

**实测限制**：在 Windows 上无法创建含 `<` `>` 的文件名（`git update-index` 也拒绝），因此**本平台不可利用**；但在 Linux/macOS 上文件名合法，clone 一个含恶意文件名的仓库即可触发。

**建议**：对 `paths` 同样做 HTML 转义（或改用 `textContent` 构建 DOM 节点）。

---

## 四、🟡 低危问题

### L-1　拒绝响应回显全部合法仓库绝对路径

`repo-not-allowed` 时返回 `{repos: ["C:/Users/.../repoA", ...]}`，泄露本机路径结构。建议只返回数量或不返回。

### L-2　缺少安全响应头

`/git-graph/api` 及页面均无 `Content-Security-Policy`、`X-Content-Type-Options`、`X-Frame-Options`。建议至少给 JSON 接口加 `X-Content-Type-Options: nosniff`。

### L-3　`iframe` 未设 `sandbox`

`client.js` 的 `<iframe className="gg-frame" src=...>` 没有 `sandbox` 属性，图谱页与宿主同源，一旦页面内出现 XSS 即可访问宿主上下文。建议评估加 `sandbox="allow-scripts allow-same-origin"`（需验证功能不受影响）。

### 补充：自更新链路

`applyUpdate` 用 `git clone --depth 1 --branch <tag> <硬编码 URL>`，**tag 有正则校验**（`^v?\d+\.\d+(?:\.\d+)?$`）、**走参数数组无 shell**、**失败自动回滚**、**git 工作区挂载时直接拒绝**（409 `git-managed`）——设计良好。唯一不足：**下载后只校验 `index.js`/`web/index.html` 存在，无签名/哈希校验**，安全性依赖 GitHub 仓库本身可信。属可接受风险，若需加固可为 tag 提供发布签名。

---

## 五、✅ 已验证安全的部分

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| **命令注入** | ✅ 安全 | 全部走 `execFile` + 参数数组，无 `shell:true`；`reveal` 传 `[root]` 单参数，路径含空格/引号也无法注入 |
| **参数注入**（`name` 以 `-` 开头） | ✅ 无法利用 | 实测 `tag "-d victim"` / `branch "-d target"` 被 git 当作单个非法名称拒绝，不会拆成选项 |
| **路径穿越** | ✅ 有效 | `../../../../Windows/win.ini`、`..\..\`、`C:/Windows/`、`/etc/passwd` 均返回 400 `path-outside-repo`；`gitop` 同样拦截 |
| **硬编码密钥** | ✅ 无 | 全仓库 + **git 全历史**扫描 `api_key/secret/password/token/Bearer`，无明文凭据 |
| **敏感文件** | ✅ 无 | 历史中从未提交 `.env`/`credential`/`.pem`/`id_rsa` |
| **本地路径泄露（源码）** | ✅ 无 | 源码/配置/文档中无 `C:\Users\...`、`D:\Software` 等本机路径（符合仓库自身规范） |
| **XSS（主渲染路径）** | ✅ 安全 | 136 处 `textContent` vs 34 处 `innerHTML`，其中 33 处仅用于清空（`= ""`），唯一动态赋值即 M-3 |
| **`eval`/`Function`/`document.write`** | ✅ 无 | 全仓库未使用 |
| **依赖供应链** | ✅ 无风险 | 零运行时依赖 |

---

## 六、修复优先级建议

| 优先级 | 问题 | 工作量 |
| --- | --- | --- |
| **P0** | H-1 CSRF：写操作改 POST + Origin/Referer 校验 | 小（服务端 20 行） |
| **P0** | H-2 危险协议：`remoteinfo` 仅允许 `https?:` + 前端二次校验 | 小 |
| **P1** | M-1/M-2：`listdir`/`addrepo` 收敛授权范围 | 中 |
| **P1** | M-3：`ignoreConfirm` 路径转义 | 小（3 行） |
| **P2** | L-1/L-2/L-3：响应头、错误信息收敛、iframe sandbox | 小 |

---

## 七、说明

- 本报告全部结论基于**实测**（构造真实 git 仓库 + mock handler + 攻击请求），未依赖静态推测。
- 扫描过程**未修改任何项目源码**（仅临时创建测试文件，已全部删除），工作区变更与本轮扫描无关（为之前版本迭代遗留）。
- H-1 的实际可利用性取决于宿主 DSH 是否已对 `/git-graph/*` 统一鉴权，建议先确认；但"写操作走 GET 且无来源校验"无论宿主如何都建议修复。

---

## 八、修复验证（v0.21）

全部修复均经实测确认（构造真实仓库 + mock handler + 攻击请求）。

### 攻击侧：原本可成功的攻击现在被拒

| 攻击 | 结果 |
| --- | --- |
| 跨站 GET `gitop&action=discard`（模拟 `<img>`，带恶意 Referer/Origin） | **403 `cross-origin-blocked`**，文件未被改动 |
| 跨站 POST（伪造 Origin 为攻击者站点） | **403**，文件未被改动 |
| 无 Origin 的 GET 写操作（`action=tag`） | **405 `method-not-allowed`**，tag 未写入 |
| `origin` 设为 `javascript:` / `JAVASCRIPT:` / `data:` / `vbscript:` / `file:` | `web` 均为 **null** |
| 请求不存在的仓库 | 不再回显 `repos` 数组，只返回 `count`（无绝对路径泄露） |

### 功能侧：正常使用不受影响

| 场景 | 结果 |
| --- | --- |
| 同源 POST 打标签 / 分支 / 提交 / 暂存 | 全部 `ok:true` |
| 同源 POST `discard` | 成功还原文件 |
| 无 Origin 的读操作（curl/测试/自启动） | 正常 |
| 正常 remote（`https://`、`git@host:`、`ssh://`） | 仍正确归一化为 https 基址 |
| `escHtml()` 单测（7 例，含 `<img onerror>`、`<script>`、`&`、引号） | 全部正确转义，输出无可执行标签 |

### 回归

34 项功能回归全绿：`repos`/`graph`/`count`/`branches`/`head`/`workstatus`/`show`/`diff`/`filediff`/`workfile`/`filelog`/`suggestmsg`/`remoteinfo` + `gitop` 的 stage/unstage/commit/tag/branch + 路径穿越拦截 + 非法 repo 拦截。

### 未采纳项说明

**L-3（iframe sandbox）**：评估后判定为负收益，未实施。同源 iframe 若同时给 `allow-scripts` 和 `allow-same-origin`，iframe 内的脚本可以自行移除 sandbox 属性，隔离形同虚设；若去掉 `allow-same-origin`，图谱页的 `localStorage`（主题/折叠/仓库记忆等状态）与同源 API 鉴权都会失效。因此本轮从**输入侧**修复（转义 + 协议白名单 + CSP），而非依赖 sandbox。

### 仍建议关注

- **H-1 的实际可利用性取决于宿主**：若 DSH 已对 `/git-graph/*` 统一鉴权，则跨站请求在网关层就被拦下。本插件的防护是**纵深防御**，不是唯一防线。
- **`listdir` 的磁盘枚举能力仍然存在**（「打开文件夹」功能本身所需）。现已要求同源且写类操作走 POST，跨站无法驱动；若需进一步收紧，可限定只允许在用户已授权的工作区与盘符范围内浏览。
- **自更新无签名校验**：`autoupdate` 依赖 GitHub 仓库可信，下载后仅校验关键文件存在。如需更强保证，可为发布 tag 签名并在 `applyUpdate` 中验签。
