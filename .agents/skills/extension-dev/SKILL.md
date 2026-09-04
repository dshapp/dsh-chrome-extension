---
name: chrome-extension-local-dev
description: 在用户当前使用的 Chrome 中加载、重载、打开并调试一个本地 Manifest V3 扩展。当用户要求安装或重载一个解压版（unpacked）扩展、打开它的 action/popup/side panel，或检查扩展页面、service worker、chrome.storage 状态时使用。
---

# Chrome 扩展本地开发

通过长活 MCP daemon（单条 CDP 连接、只弹一次授权）在用户当前使用的 Chrome 中开发扩展。

## 调用工具

```bash
node <skill-dir>/scripts/chrome-devtools-mcp.mjs <tool-name> '<json-arguments>'
```

CDP 连接失效时重连（Chrome 会再授权一次）：

```bash
node <skill-dir>/scripts/chrome-devtools-mcp.mjs --shutdown
```

## 工作流

1. **发现扩展** —— 定位 `manifest.json`；其所在目录就是解压版扩展路径
2. **连接** —— 若缺少 `DevToolsActivePort`，优先用 CU（computer use）工具打开 `chrome://inspect/#remote-debugging`、开启远程调试并代替用户点击 Allow；仅当 CU 不可用时才让用户自己操作。绝不通过重启或修改其 profile 来绕过。
3. **安装/重载** —— `list_extensions`，按精确的清单名称匹配；缺失则 `install_extension`（绝对路径），已存在则按其 ID `reload_extension`。每次源码改动后先重载再验证。
4. **打开表面** —— 用 `new_page` 打开 `chrome-extension://<id>/<page>` 做 DOM/console/storage 调试；真实的 popup/action/side panel 交互用 `trigger_extension_action`。
5. **检查状态** —— 从扩展页面读取 `chrome.storage`；`evaluate_script` 只用源码中找到的 key。
