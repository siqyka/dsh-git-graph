# dsh-git-graph

DeepSeek Harness（DSH）Web GUI 的嵌入式 Git 仓库图谱可视化插件。

在对话界面里直接查看、浏览、管理 git 仓库：提交历史图、分支过滤、提交详情、文件 diff、工作区状态、右键 git 操作，全部内嵌在 harness 界面中，无需离开当前对话。

![Git 图谱](https://img.shields.io/badge/DSH-Plugin-58a6ff)

## ✨ 功能

- **提交历史图**：GitHub 风格提交列表，分支分组折叠，分支着色
- **两种查看模式**：
  - **📍 当前区域**：打开哪个对话就显示哪个对话工作区的 git 仓库，切换对话自动跟随；非 git 仓库的对话显示空态提示（不显示图谱）
  - **📁 手动选择**：自己挑选任意文件夹固定查看，切换任何对话都不改变
- **分支过滤**：勾选/取消勾选分支，不勾选的分支彻底隐藏
- **提交详情**：提交信息、文件变更列表、单文件 diff、两次提交对比（Ctrl+点击）
- **工作区状态**：未提交/未跟踪文件一览
- **右键菜单**：checkout / merge / reset / cherry-pick / stash / 新建标签 等 git 操作
- **键盘快捷键**：`Ctrl+F` 搜索、`Ctrl+H` 回到 HEAD、`↑↓` 导航、`Esc` 关闭
- **明暗主题**：跟随 harness 界面自动切换，也可手动固定
- **三种挂载位置**：侧边栏按钮停靠右侧栏 / 会话页内「Git 图谱」标签页

## 📦 安装

### 1. 把插件加入 profile

编辑你的 DSH web profile 的 `package.json`，添加依赖：

```json
{
  "dependencies": {
    "dsh-git-graph": "file:./plugins/git-graph"
  }
}
```

（`plugins/git-graph` 为本插件源码所在目录，按实际路径调整。）

### 2. 挂载 bundle

在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: git-graph
      name: dsh-git-graph
      config:
        repo: "C:/path/to/your/repo"
```

> `config.repo` / `config.repos` 是初始可访问仓库白名单；运行中被会话工作区发现的仓库也会自动加入可访问集合。

### 3. 安装并重启

```bash
pnpm install
# 然后重启 dsh web（或直接使用一键重启脚本）
```

打开 http://127.0.0.1:3080 ，点左下角 **Git 图谱** 按钮即停靠到右侧栏。

## 🖱️ 使用

| 操作 | 说明 |
| --- | --- |
| 左下角「Git 图谱」按钮 | 停靠 / 取消停靠右侧栏（再次点击或 ✕ 关闭） |
| 会话页「Git 图谱」标签 | 在该对话内查看图谱 |
| 📍 当前区域 / 📁 手动选择 | 切换查看模式 |
| 分支组标题 | 点击折叠 / 展开该分支 |
| ☑ 分支过滤 | 选择显示哪些分支 |
| 提交行 | 点击查看详情，Ctrl+点击与另一提交对比 |
| 提交行右键 | git 操作菜单 |
| ↻ 刷新 | 重新加载仓库数据 |

## 🛠️ 开发

```
git-graph/
├── index.js          # 服务端：git API（graph/branches/status/diff/...）
├── client.js         # 客户端插件：侧边栏按钮、停靠面板、会话标签页
├── web/index.html    # 图谱界面（iframe 内独立页面）
├── package.json      # 插件清单（dsh.client.inject + bundle patch）
└── cordis.patch.yml  # profile 挂载点
```

修改后同步到 DSH 部署目录（`node_modules/dsh-git-graph/`）：

```powershell
.\sync-deploy.ps1
```

服务端（`index.js`）改动需重启 dsh web；页面（`web/index.html`）改动刷新即生效。

## 📄 开源协议

[MIT](./LICENSE)

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/) —— 插件运行平台
