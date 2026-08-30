# DSH Chrome 扩展 — 同步梳理报告

> 对照仓库：`/Users/user/dshapp/dsh-macapp`
> 提交范围：`d2ea20d642f9bafee46c353407068078f9fcd937`（含）→ `HEAD`，共 **49** 个提交
> 本项目：`/Users/user/dshapp/dsh-chrome-extension`
> 方法：逐提交实际 diff 审阅 + 本项目对应模块源码核验（只读，未修改任何文件）


### P0 — 正确性与数据可靠性

| # | 问题 | 现状证据 | 建议 |
|---|---|---|---|
| 1 | 重连后未自动收敛历史 | `downlink.js:161-166` 触发 `onGenerationReady`；`session-service.js:298-300` 有 `resync()`；但 `dependencies.js:16-29` 未传回调 | 连接 `onGenerationReady` → `sessions.resync()` |
| 2 | 浏览器工具结果静默丢失 | `background.js:2155-2156` 非 `OPEN` 直接放弃；`2242-2263` 完成后直接发 `tool_result`；无 ACK/队列/重放 | 待发送队列 + 重连重放 + ACK/幂等 ID |
| 3 | iframe 消息来源不安全 | `downlink.js:29-36` 未校验 `event.origin`，`postMessage` 用 `"*"` | 校验预期来源，收窄 targetOrigin |
| 4 | WebSocket 就绪判断错误 | `downlink.js:72-88` direct carrier 以 `Map.size` 判 opened | 等待 socket `OPEN` 事件 |
| 5 | 会话历史异步竞态 | `sidepanel-app.js:589-633` 快速切换时旧 `loadHistory` 可覆盖新会话 | generation 令牌 / AbortController / sessionId 复核 |
| 6 | 模型菜单异步竞态 | `composer-dock.js:175-228` 刷新未固定 sessionId，迟到响应更新错误菜单 | 记录请求 sessionId，返回后复核 |
| 7 | IME 回车误发送 | Enter 处理未判 `event.isComposing` | 提交前检查 `isComposing` |
| 8 | 附件失败丢失 | 发送前即清空附件，失败无法重试 | 成功后再清空；失败保留重试 |

### P1 — 连接完整性与资源

| # | 问题 | 现状证据 | 建议 |
|---|---|---|---|
| 9 | `stream/error` 未纳入退避重连 | `session-service.js:258-260` 仅 `console.warn` | 去重重连 + 纳入退避阶梯 + 稳定期重置 |
| 10 | 无手动重连与明确错误态 | 状态点存在但无恢复入口 | 增加重连按钮 + 可见错误提示 |
| 11 | 事件窗口无上限 | `session-store.js` 窗口无总量上限（投影历史已有 32 上限） | 窗口/缓冲加条数或字节预算，超限重载 |
| 12 | 自定义远端地址契约冲突 | manifest 仅对 localhost/127.0.0.1 注入 relay；支持 http(s) 远端则失效 | 明确仅本机 DSH，或动态扩展 permissions/中继 |
| 13 | 后台通知可靠性 | MV3 通知仅驻内存 + 15s 轮询，短任务/worker 重启漏通知 | 评估 alarms/持久化 |

### P2 — 性能

| # | 问题 | 现状证据 | 建议 |
|---|---|---|---|
| 14 | 流式逐帧同步渲染 | 每帧同步重建快照并渲染 | 按 animation frame 合并 |
| 15 | 长草稿逐键全文扫描 | `composer-triggers.js` 全文 `[...draft]`；`composer-chips.js` 全文 diff/镜像 | 限定扫描范围 + 无占位符快速路径 |
| 16 | 会话列表线性查找/全量重排 | `session-list-store.js` 多处 `find`/`map`/`sort` | sessionId→索引映射 |
| 17 | 尾节点/工具/上下文每帧重派生 | `chat-renderer.js`、`session-docks.js` | store 缓存标量 |
| 18 | 历史搜索无 debounce | `session-service.js` search | 输入 debounce |
| 19 | Base64 附件内存峰值 | `attachments.js:50-51` 整文件转 Base64 | 分块 / Blob 直传评估 |

### P3 — 功能缺口

| # | 缺口 | 现状证据 |
|---|---|---|
| 20 | jobs 无 UI | `session-store.js` 存 jobs，但无面板/详情 |
| 21 | subagent 操作缺失 | `rpc-methods.js` 已声明 `subagent.list/interrupt`，无调用 |
| 22 | 插件设置只读 | `plugins-pane.js` 以只读为主 |
| 23 | 大会话列表无虚拟化 | 列表一次性渲染 |

### P4 — 视觉对齐

- 用户消息气泡多行左对齐（`232448b`）——当前 `conversation.css` 用户气泡 `min(82%,42rem)` 基本合理，Chrome 侧栏宽度有限，920 宽度参考价值低。

