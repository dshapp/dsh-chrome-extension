---
name: chrome-extension-local-dev
description: 在用户当前使用的 Chrome 中加载、重载、打开并调试一个本地 Manifest V3 扩展。当用户要求安装或重载一个解压版（unpacked）扩展、打开它的 action/popup/side panel，或检查扩展页面、service worker、chrome.storage 状态时使用。
---

# Chrome 扩展本地开发

通过长活 MCP daemon（单条 CDP 连接、授权一次）在用户当前使用的 Chrome 中开发扩展。

## 调用工具

```bash
node <skill-dir>/scripts/chrome-devtools-mcp.mjs <tool-name> '<json-arguments>'
```

daemon 常驻并复用同一条 CDP 连接，因此**正常使用不会重复弹授权窗**。

## 授权弹窗：自己点，别等用户

Chrome 152+ 对 browser 级 CDP 做了权限门禁：

- `/json/version`、`/json/list` 一律返回 **404**；唯一入口是 `DevToolsActivePort` 里的 browser WebSocket。
- **每建立一条新的 browser 级连接**，Chrome 都会弹出 “Allow remote debugging?” 原生 sheet，并**阻塞握手**直到有人回答。
- 授权**绑定在这条连接上**，不是记住某个 app：连接断了、daemon 被杀了，下次就会再弹一次。

所以「只弹一次」的正确含义是：**一条连接授权一次，之后这条连接上的所有工具调用都不再弹**。daemon 常驻复用同一条连接，因此正常开发全程只需授权一次。反过来说，反复弹窗一定意味着连接在反复重建——去查是谁在重连，而不是去关弹窗。

出现弹窗时**必须由你用 CU 工具点掉，不要让用户手动点**：

```
mcp__cu__get_app_state { app: "com.google.Chrome", mode: "ax", ax_filter: "Allow remote debugging" }
mcp__cu__press_key     { app: "com.google.Chrome", keys: "return", activate: true }
```

若 `activate: true` 没能把 Chrome 提到前台（用
`osascript -e 'tell application "System Events" to return name of first process whose frontmost is true'`
可以确认），先显式激活再按键——**键必须落在前台窗口上，否则 sheet 不会响应**：

```bash
osascript -e 'tell application "Google Chrome" to activate'
```

要点（已在 Chrome 152 / macOS 上实测）：

- **“Allow” 是该 sheet 的默认按钮**，所以 `return` 即同意；`Escape` 是取消，别用错。
- 必须是**受信任的键盘事件**且 Chrome 在前台，所以 `activate: true` 不能省。
- **合成点击无效**：AX 的 `AXPress`、坐标 `click` 都会返回 `ok:true` 却**并不会授权**，握手仍然挂起。不要用点击，用按键。
- `osascript` 通常被拒绝辅助功能访问（-25211），**不要**指望用 AppleScript 点它。
- 弹窗**会堆积**：每个未回答的连接各占一个 sheet。若一次连开多条连接，需要重复按 `return` 直到 `ax_filter` 查不到为止。

## 不要随意重启 daemon

**绝不要**为了“刷新状态”去跑 `--shutdown`：杀掉 daemon 会丢掉已授权的连接，下次调用必然**重新弹窗**。daemon 默认**不再有空闲超时**（`DEFAULT_IDLE_MS = 0`），可以长期常驻。

只有在 CDP 连接确实失效（工具调用持续报连接错误）时才重连，并预期要再授权一次：

```bash
node <skill-dir>/scripts/chrome-devtools-mcp.mjs --shutdown
```

## 工作流

1. **发现扩展** —— 定位 `manifest.json`；其所在目录就是解压版扩展路径
2. **连接** —— 直接调用工具即可（daemon 会按需自启）。若缺少 `DevToolsActivePort`，用 CU 打开 `chrome://inspect/#remote-debugging` 开启远程调试。出现授权 sheet 就按上一节自己按 `return`。绝不通过重启 Chrome 或修改其 profile 来绕过。
3. **安装/重载** —— `list_extensions`，按精确的清单名称匹配；缺失则 `install_extension`（绝对路径），已存在则按其 ID `reload_extension`。参数名是 **`id`** 不是 `extensionId`（传错会报 `Invalid arguments ... Required at id`）：`reload_extension '{"id":"<扩展ID>"}'`。每次源码改动后先重载再验证。
4. **打开表面** —— 用 `new_page` 打开 `chrome-extension://<id>/<page>` 做 DOM/console/storage 调试；真实的 popup/action/side panel 交互用 `trigger_extension_action`。
5. **检查状态** —— 从扩展页面读取 `chrome.storage`；`evaluate_script` 只用源码中找到的 key。
