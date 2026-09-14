# Chrome 扩展聊天记录区 vs Web 逻辑 / Mac 交互 差异对照

对照口径（用户要求）:
- **逻辑**以 `/Users/user/dshapp/deepseek-harness/apps/web` + `packages/client/*` 为准。
- **交互**以 `/Users/user/dshapp/dsh-macapp/Sources` 为准。
- 本文件只列差异，不改代码。扩展路径相对 `/Users/user/dshapp/dsh-chrome-extension`。

现有基础：扩展的节点模型已刻意对齐 Mac（`src/features/sessions/chat-nodes.js:1` 注明对齐 ChatNode.swift 13 case），
本轮问题主要在**流式/滚动/交付物逻辑**与**若干 Mac 交互细节**未对齐。

---

## 实施状态（本轮完成）

P0–P2 全部差异已按口径修复。验证:
- `npx vitest run`：96 files / 1319 tests 全绿。
- `npm test`（bridge node:test）：101 全绿。
- `chrome-extension-local-dev` 端到端 smoke：真实 Chrome 重载 DSH 扩展
  `hjgcllfkbkhmggdopnfhhmaiaedacnpg`，侧栏页面模块全部 200、无新增 console 错误；
  ⌘F 打开查找条并聚焦、命中计数 `1/2` 与 `mark.find-hit.current` 正确、Esc 关闭并清除标记。

| 项 | 状态 | 主要落点 |
| --- | --- | --- |
| P0-1 流式 revision/index 校验 + rebaseline | ✅ | `session-store.js` `assistantRevision` |
| P0-2 增量 markdown（冻结前缀 + streaming 标志） | ✅ | `incremental-markdown.js`、`chat-view.js` |
| P0-3 尾部跟随（Mac send-pin 语义） | ✅ | `tail-follow.js`、`sidepanel-app.js` |
| P0-4 产出/present 渲染 + 正文 mention 可点 | ✅ | `node-views.js`、`turn-deliverables.js` |
| P0-5 AUTH 脱敏 | ✅ | `session-store.js` `failureText` |
| P0-6 Turn process 折叠 | ✅ | `turn-process.js`、`chat-renderer.js` |
| P1-7 Markdown 补齐（del/task/hr/对齐/h1–h4） | ✅ | `md-to-html.js` |
| P1-8 未知块 JsonBlock | ✅ | `node-views.js` `updateUnknownBlock` |
| P1-9 用户附件卡 / rest JSON / 引用 chip | ✅ | `user-content.js`、`references.js`、`node-views.js` |
| P1-10 错误/重试/maxTokens 详情与倒计时 | ✅ | `node-views.js` |
| P1-11 turnTail 动作（Mac 口径） | ✅ | `node-views.js`、`conversation.css` |
| P1-12 工具行路径可点 | ✅ | `node-views.js`、`tools.css` |
| P1-13 turn rail active 随滚动 | ✅ | `turn-rail-view.js`、`sidepanel-app.js` |
| P1-14 连续图片成组 | ✅ | `node-views.js`、`conversation.css` |
| P1-15 思考摘要剥离 `**` | ✅ | `node-views.js` `thinkingSummary` |
| P2-16 ⌘F 会话内查找 | ✅ | `find-in-chat.js`、`index.html`、`sidepanel-app.js` |
| P2-17 代码高亮视口门控 | ✅ | `code-highlight.js` |
| P2 杂项（字素簇折叠/分片、复制反馈 1000ms + 去重） | ✅ | `long-message.js`、`copy-feedback.js` |

## 补充修复：产物卡片与 PTC 子调用

用户在真实会话里看不到 present 交付卡。复现(用真实会话
`~/.dsh/sessions/--Users-user-dshapp-dsh-chrome-extension--/session-3577ff06-…`
回放进 store + jsdom 渲染)后定位到两个根因:

1. **PTC 子调用整段丢失(正确性)**
   - 会话格式 v3 起，`run_code` 的子调用事件名是 `tool/ptc-dispatch-start` /
     `tool/ptc-dispatch`；扩展的 `EVT` 只认旧名 `tool/code-dispatch*`。
   - 后果:所有嵌套 `read`/`write`/`edit`/`bash` 调用都不入 store —— 聊天记录里
     只剩 `run_code` 一行，且"本轮产出"永远为空。
   - 修复:`rpc-methods.js` 同时登记新旧两组名；`session-store.js` route 合并到同一处理。
2. **产出词表只扫 root 节点**
   - `rebuildNodes` 原先只从 `state.nodes` 的 root 工具调用取路径；嵌套调用挂在
     `node.subCalls` 上，即使事件进来了也拿不到。
   - 修复:递归 `subCalls` 收集 `write`/`edit`/`str_replace_editor` 的 settled 路径。
   - 真实会话验证:`producedPathsByTurn` 由全空变为 turn1:1 / turn2:17 / turn3:32 / turn4:3。
3. **产物卡片按 Web/Mac 重做**
   - present 卡(`buildPresentedFiles`):类型徽标 + 文件名 + 描述 + `打开` 按钮，
     单列网格，前 4 张折叠、余量可展开/收起(对齐 web `PresentedFileCard` +
     `Deliverables.module.css` 的窄栏 `@container`)。
   - 产出行(`buildProducedFiles`):chip 前置链接图标 + 文件名，title/aria 保留全路径。
   - i18n 新增 `turn.open` / `turn.openFile` / `turn.collapseAll`。
4. **`system/message` 不再是"未处理的事件"**
   - 它带 `surfaceOp: append`，之前会在每次会话开头画一行
     `未处理的事件:system/message`；Web 把它放在 request/trajectory 视图。现显式忽略。

5. **用户消息里的图片渲染成破图(历史图片只有 attachmentId)**
   - 历史 `user/message` 的 image 块只带 `attachment:{attachmentId,mediaType,name}`，
     没有内联 `data`。扩展直接拼 `data:...;base64,undefined` → 破图 + 控制台
     `ERR_INVALID_URL`。
   - 修复:`splitUserContent` 保留 `attachmentId`;`node-views.js` 新增
     `applyImageSource`(同一 id 只读一次、loading/failed 占位)，通过
     `session-service.readAttachment` 调 `session/attachment` 读回 base64(对齐 web
     `HistoricalImageCache`)。user / assistant / imageGroup / tool-result 四处图片统一走它。
   - 顺带修掉单张 assistant 图片路径:该分支传的是 `{run:[...]}` 包装，
     `block.attachment` 取不到，单图一直 src 为空。
   - 真实会话复核:打开含 `pasted-image-1.png` 的会话，`img.src` 为
     `data:image/webp;base64,…`、`naturalWidth=912`、无 failed/loading，
     控制台不再有 `base64,undefined`。

6. **卡片左侧图标改用 lucide，口径对齐 Web 分类**
   - Web present 卡用 `FileTypeIcon`(自绘类型字形 + 分类配色)、产出 chip 用
     `LinkIcon.classifyLinkPath`(6 类粗分类)；Mac 用系统 `NSWorkspace` 文件图标。
     扩展无法内嵌系统图标，按用户要求取 lucide 线稿。
   - 新增 `src/features/chat/file-icons.js`:
     - `fileTypeKind` 对齐 web `classifyFileType`(code/html/image/markdown/pdf/word/
       excel/ppt/video/audio/other)；
     - `fileTypeIconName` 细分类(present 卡、用户文件卡)：file-code / file-pen /
       file-image / file-type(pdf) / file-text / file-spreadsheet / presentation /
       file-play / music / folder / file；
     - `linkIconName` 粗分类(产出 chip，对齐 `classifyLinkPath`)：markdown/video/other
       退回通用纸页；
     - `lucideIcon` 生成 24×24 stroke 线稿 SVG(`currentColor`,stroke-width 2)；
       路径逐字取自 lucide 仓库，仅内联用到的图标。
   - CSS 增加 `.file-type-*` 分类配色(对齐 web `FileTypeIcon.module.css` 的
     code/绿/琥珀/红/violet)。
   - 真实会话复核:present 卡图标为 20px lucide SVG、产出 chip 13px、用户文件卡同源。

7. **后台任务从上下文浮层移到 header chip(位置对齐 Mac/web)**
   - 原来后台任务明细被塞进底栏"上下文统计"药丸的 popover(`stats-jobs` 段),
     位置和职责都不对。
   - Web `ui-jobs JobListAction` / Mac `JobListAction` 都是会话工具栏入口(紧挨
     子代理入口):有任务才出现,触发钮只报计数,明细在独立浮层里。
   - 新增 `src/features/docks/job-list.js`(header chip + 明细 popover):
     - 计数对齐 web `countLabel`:有 running/stopping 时报活动数并点一颗活动点,
       否则报总数(`jobs.countLive*/countIdle*`);无任务整颗 chip 隐藏。
     - 明细排序对齐 web `ordered`:活动在前按开始升序,已结束按结束降序,
       同毫秒回退开始时间。
     - 行:状态点(running 脉冲 / stopping·killed 琥珀 / completed 绿 / failed 红)
       + 类型 + 标签 + 详情(无详情回退状态词)+ 耗时(至多两级单位,活动行每秒刷新)。
     - 点行进 `openCardDetail` 详情表(类型/ID/状态/开始/结束/耗时/详情),对齐
       Mac `CardDetailSheet` 的 backgroundJob。
   - `session-docks.js` 的 stats popover 删掉 jobs 段,药丸是否显示只看上下文/统计。
   - 真实会话复核:chip 显示"2 个后台任务"(无活动点时无脉冲点);点开浮层两行
     (`bash … exit code: 0 / 1分2秒`、`bash … signal: SIGTERM / 59秒`),点行进详情弹窗;
     统计 popover 中已无 jobs 段。

8. **聊天记录顶部的"未处理的事件:system/message"**
   - 根因:扩展对未认领的 `surfaceOp=append` 事件有兜底行(`node.unknown`),
     `system/message` 不在事件表里时就被画成"未处理的事件:system/message"。
     Web 的会话投影只认领对白事件,`system/message` 属于 request/trajectory
     旁路视图,主记录里没有这一行。
   - 修复:`session-store` 在兜底之前先按命名空间屏蔽 —— `system/*` 与
     `request/*` 的**任何**变体都不进主记录(`isNonTranscriptType`),不再只特判
     `system/message`/`request/header` 两条;其它命名空间的未知 append 事件
     仍保留兜底行(不静默丢事件)。
   - 复核:用真实会话日志(含 seq8 `system/message`,`surfaceOp:"append"`)重放,
     `unknownSurface` 节点 0 个;真实 Chrome 打开该会话,顶栏无 unknown 行,
     第一条是 turn-process。

9. **交付卡点击没反应 + 缺"在文件夹中显示"**
   - 根因:present/产出里的 path 是**工作区相对路径**(如 `dsh-present-demo.txt`),
     而宿主 `session/openWorkspacePath` 按**宿主进程 cwd** 解析。实测相对路径会
     `open AGENTS.md` → `/Users/user/AGENTS.md does not exist`,失败又被
     `.catch(() => {})` 吞掉,表现为"点了没反应"。
   - 修复:
     - `createTurnTailNode` 统一先按会话 cwd 把路径补成绝对
       (`resolveToolPath`),产出 chip / present 卡 / 行内 mention 三处共用。
     - `workspace-service.revealPath(path)` → `{ path, action: "reveal" }`,
       对齐 web `PresentedFileCard` 的 `PresentedAction 'reveal'`。
     - 交付卡拆成主按钮「打开」+ chevron 菜单(web PresentedFileCard 的 split):
       「用默认应用打开」/「在 Finder 中显示」(Windows 平台文案切 Explorer)。
     - `getContext` 的打开/揭示失败改成 toast,不再静默吞。
   - 复核:真实 Chrome 新会话让模型 present `dsh-present-demo.txt`,卡片
     chevron 菜单两项、图标齐全,点「在 Finder 中显示」与点卡片均无错误
     toast(宿主接受);RPC 探针确认相对路径失败、绝对路径 + `action:"reveal"`
     返回 `opened:true`。

10. **折叠/展开图标统一成 lucide**
   之前是混用:部分手写 svg、部分字符(`▸/▾`、`⌃/⌄`、`⊞/⊟`)。
   现在全部换成本地内联的 lucide 图标(`file-icons.js` 的 `lucideIcon` /
   `lucideIconSvg`,24×24、stroke=currentColor、stroke-width=2):
   | 位置 | 之前 | 现在 |
   | --- | --- | --- |
   | Turn process 折叠头 | `▸` | `chevron-right`(CSS 展开旋转 90°) |
   | 轨迹工具栏 轮次/调用 | `⊞/⊟` | `plus/minus` |
   | 轨迹单条调用折叠 | `⊞/⊟` | `plus/minus` |
   | Git 当前分支展开 | `▾/▸` | `chevron-down/right` |
   | 子代理目录 disclosure | `▾/▸` | `chevron-down/right` |
   | 待办面板 | `⌃/⌄` | `chevron-up/down` |
   | 设置 → 插件 disclosure | `▾/▸` | `chevron-down/right` |
   | 历史排序下拉指示 | 手写 svg | lucide `chevron-down` / `arrow-up-down` |
   | `index.html` 静态 dropdown-chevron | 已是 lucide 路径但 1.7 描边 | 归一到 2 |
   - 未列入:`chip-icon ›`(命令前缀装饰)、模型行 `›`(跳转编辑)、
     goal `▶`(恢复播放)、快捷键 `⌃`(键盘字形),都不是折叠语义。
   - 复核:真实 Chrome 中轨迹工具栏/单条折叠共 52 个 lucide svg、
     Git 行 chevron、设置插件 caret 均为 lucide(stroke 2);`index.html` 7 处
     dropdown-chevron 描边已归一到 2。

11. **icon 全量清点:非 lucide 字形一律替换**
   把散落的 Unicode 字形和自建 svg 全部换成 `file-icons.js` 里的 lucide 原始路径
   (24×24、stroke=currentColor、stroke-width=2),不再有 1.7/1.6 的自定义描边。
   - 文本字形:复制 `⧉`→`copy`/`check`,删除 `🗑`→`trash-2`,关闭 `×/✕`→`x`,
     保存 `✓`→`check`,继续 `▶`→`play`,暂停 `⏸`→`pause`,编辑 `✎`→`pencil`,
     目标 `◎`→`target`,弃用 `⑂`→`git-fork`,归档 `🗄`→`archive`,重命名 →`pencil-line`,
     思考 `✨`→`sparkles`,超限 `⚠`→`triangle-alert`,命令前缀 `›`→`chevron-right`,
     提问箭头 `→`→`arrow-right`,待办 `☑/◐/☐`→`circle-check/circle-dot/circle`,
     引用胶囊 `🔗/📄/📁/✨`→`link/file/folder/sparkles`,发送 `＋/■/↑`→
     `plus/square/arrow-up`,toast `!/✓/i`→`circle-alert/check/info`。
   - 自建 svg:`history-icons.js`、`queue-panel.js`、`chat-view.js` 的局部 lucide
     注册表统一走共享表;`tool-presentation.js` 描边归一到 2;git 的 worktree/branch
     图标用 `layers`/`git-branch`;设置页 iconButton 新增 `icon` 参数,
     删除/编辑/查看/移除分别用 `trash-2/chevron-right/search/x`。
   - `index.html` 静态字形:查找上下 `↑/↓`→`chevron-up/down`,各处 `×`→`x`,
     加号 `＋`→`plus`,发送 `↑`→`arrow-up`,设置返回 `←`→`arrow-left`;
     菜单选中勾 `✓` 改成 lucide check 的 CSS mask。
   - 有意保留:统计行的 `↑1.2K`/`↓340`(token 方向文字,与 Mac/Web 读数一致)、
     快捷键 `⌘⌃⌥⇧` 字形、元素拾取器里的 `宽×高`(尺寸分隔符),都不是图标语义。
   - 复核:真实 Chrome 侧栏 1529 个 svg 的 `stroke-width` 全部为 2;新建/打开目录/
     设置/加号/发送/元素选取/模型 chevron 均有 svg;`.act-btn` 全带图标;
     Turn process chevron、37 个思考 sparkles、工作目录菜单的 plus、模型页的
     `chevron-right`+`trash-2` 均在位。

端到端复核(真实 Chrome，扩展 `hjgcllfkbkhmggdopnfhhmaiaedacnpg`):新建会话让模型
`write` + `present`，回合结束后侧栏实测 `.turn-present-card` ≥ 1、
`.turn-produce-chip` ≥ 1，卡片结构为 `TXT | 文件名 | 描述 | 打开`，
且 `未处理的事件:system/message` 消失。

### 与 Web 的已知有意差异（待补，不影响本轮验收）
- `skillNames` 投影：`projectUserText` 只装饰调用方给出的已加载 skill 名。扩展暂未从
  slash-entry 分组投影 skill 名，因此正文里的 `/name` 保持纯文本（不会被误装饰）。

---

## P0 — 正确性 / 安全，必须先修

### P0-1 assistant 流式帧无 revision/index 校验，丢帧静默丢正文
- 扩展：`session-store.js:598-627` `applyAssistantStreamFrame` 只比对 `attemptId`；`ok`/`chunk` 无 `revision`、无 `index===nextIndex` 校验，无 rebaseline。丢 start 帧 → 该 attempt 全部 chunk 被静默丢弃；丢中间帧 → 内容缺口永久保留到 settle。`applyAssistantStreamBaseline:630-642` 也只重放，无代数概念。
- Web：传输层 `packages/client/connection/src/client/transport.ts:178-216` 强制 revision 严格 +1；折叠层 `session-controller/src/client/sessions/assistant-stream.ts:139,166` 在 index 不连续/重复/不匹配时返回 `'rebaseline'`，由 `session.ts:681 queueMicrotask(events.restart())` 重拉快照。契约：`packages/api/session-controller/src/client/contract/types.ts:456-526`。
- Mac：同样缺（PARITY-ACTIONS B1 已定级 P0），两实现都缺，但口径是"逻辑跟 Web"。
- 建议：给 `applyAssistantStreamFrame` 加 `liveAttempt.revision` 与 `nextIndex`，不连续即清 attempt 并触发一次 follow 重开/baseline。

### P0-2 流式 Markdown 每帧全量重解析，且更新时丢了 streaming 标志
- 扩展：`node-views.js:222-253` `updateAssistantNode` 每帧 `turn.replaceChildren()` + `renderMarkdownInto`（`chat-view.js:104`）整段 `mdToHtml`。长回答总工作量随长度平方增长（注释 `node-views.js:177-182` 自认靠 20000 折叠封顶）。且更新走 `createAgentText` 调 `renderMarkdownInto(body,text)` 未传 `streaming`，`code-highlight.js:60-72` 的"跳过未闭合末块"在流式更新里失效，代码着色随字符跳变。
- Web：`ui-primitives/src/markdown/incremental.ts:38` `UNSTABLE_TAIL_BLOCKS=2`，冻结已完成顶层块、只重解析尾部（`incremental.ts:310-359`）；`MarkdownText.tsx:65-180` 缓存冻结元素；`assembly.ts:130-147` 约每 3 帧发布一次。
- 建议：引入增量解析（冻结前缀 + 尾部重解析，块 key 用源偏移），并给流式更新传 `streaming:true`。

### P0-3 滚动跟随过简：无"发送即锁尾"、无滚动锚定/位置保存
- 扩展：`sidepanel-app.js:749-753` `autoScroll` 每快照只测"距底 <120px 就贴底"。无：发送时强制可见自己的消息、turn 内持续 pin、向上滚动的释放判定、prepend(加载更早)时的滚动锚定、切会话的位置保存/恢复、从阅读行反推 active turn。
- Web：`ui-chat/src/client/chat/ChatView.tsx:19` `FOLLOW_THRESHOLD=24`；`:522-537` 新 user/steering/submission 强制 `toBottom`；`:502-520` prepend 锚定；`:466-497` 恢复保存位置；`:549-577` 只在读者滚动时改所有权。
- Mac：`Models/TranscriptTailFollow.swift:5-11,49-60` —— **发送即 pin 整轮**，仅"轮结束"或"读者向上滚 >24pt"释放；`runningChanged(false)` 只 arm 不释放（:75-118）。
- 结论：交互口径=Mac，应采用 send-pin 语义。
- 建议：移植 `TranscriptTailFollow` 语义（发送 pin；offset 高水位判定释放；turn 停止确认；会话切换释放）。

### P0-4 本轮产出/present 已算出却不渲染；正文 mention 不可点
- 扩展：store 已维护 `producedPathsByTurn`（`session-store.js:1346-1363`）与 `presentedByTurn`（`applyPresented:1137-1150`），并随快照导出（`:1476-1479,1497-1499`）；`turn-deliverables.js` 的 `producedPath/presentedFiles/resolveMention` 已就绪。但 `node-views.js:575-610 createTurnTailNode` 只渲染 ttft/tok·s/runtime/tokens 文本 + 复制/分叉/时间，**完全不读 produced/presented**；markdown 行内 code 也无 mention 解析（全仓 `openFile/fileMentions` 命中 0）。
- Web：`conversation-nodes/turn-tail.ts` + `ui-deliverables/src/client/index.ts:61-76`；`render.tsx:292-322` 行内 code mention → button。
- Mac：`Components/Conversation/Docks.swift:782-906` ProducedFilesRow（6 个槽 + "+N"）+ `:908-1016` present 交付卡；`Models/TurnDeliverables.swift:63-124`；`MessageItems.swift:499-508` mention 预览。
- 建议：turnTail 增"产出"chip 行与 present 卡；assistant 行内 code 走 `resolveMention`。

### P0-5 AUTH 失败信息未脱敏
- 扩展：`session-store.js:930-934 turnFailureMessage` 直接返回 `failure.message`，`applyRetry:978` 也直存 `failure.message`。
- Web：`conversation-nodes/event-projection.ts:151-162 displayFailure`，`code==='AUTH'` 时 message 置空，UI 用 `message.failure.auth`。
- Mac：`Models/TurnFailureMessage.swift:6-18` 同样 redact。
- 建议：AUTH 一律替换为本地化通用文案。

### P0-6 缺 Turn process 折叠
- 扩展：全仓无 `turnProcess`（grep 0）。settle 后思考/工具/重试/旧回复全部平铺在记录里。
- Web：`ui-chat/src/client/conversation-nodes/turn-process.ts` + `chat/TurnProcessNodeView.tsx:7-59`；折叠成员保留在 DOM（`hidden="until-found"`）以便 ⌘F。
- Mac：`Components/Conversation/TurnProcessRow.swift:29-101` —— chevron + "N tool calls · N messages · N subagents"（空 → "Thought for a while"）；`SessionStore.swift:2030-2065` 折叠逻辑。
- 建议：按 Mac 输出形态做折叠控件（整行可点，Enter/Space 切换）。

---

## P1 — 信息量 / 体验差距

### P1-7 Markdown 语法只覆盖 CommonMark 子集
- 扩展：`src/shared/md-to-html.js` 正则实现。缺：删除线、任务列表、`---` 分隔线、嵌套/松散列表、表格对齐（`:--:`）、宽表处理、引用式链接/脚注、h1/h2（`:170` 直接映射成 h3–h6）、软换行、CJK 加粗（`cjkFriendlyStrong`）。
- Web：`ui-primitives/src/markdown/parse.ts:26-44`（mdast + GFM + math）、`render.tsx:264-517`。
- 建议：换 mdast/markdown-it 级别解析器；至少补删除线、任务列表、hr、对齐、h1/h2。

### P1-8 未知 assistant 块被静默吞掉
- 扩展：`chat-nodes.js:229-239 toAssistantBlock` 未知类型 → `{type:'other'}`；`node-views.js:226-239` 只渲染 reasoning/text/image，`other` 直接消失。
- Web：`MessageItem.tsx:375-387` JsonBlock；Mac：`MessageItems.swift:578` UnknownBlockRow。
- 建议：`other` 渲染成 JSON 折叠行。

### P1-9 用户消息丢文件附件/rest 块，无 @/ 引用 chip
- 扩展：`node-views.js:125-145 createUserNode` 只取 image + text，`file`/rest 块无输出；也没有 `referenceLabels/skillNames` chip 与 reference summary（grep 0）。
- Web：`MessageItem.tsx:156-229`（file 卡 + `projectUserText` + JsonBlock rest）；Mac：`MessageItems.swift:269-365` chip 投影。
- 建议：补 file 卡、rest JSON、引用 chip 投影。

### P1-10 错误/重试/max-tokens 的信息量不足
- 扩展：`createTurnErrorNode:536-542` 直接内联 message+code、无详情弹窗；`createModelRetryNode:506-534` 无倒计时、无耗尽后详情；`createTurnMaxTokensNode:544` 只有标题。
- Web：`MessageItem.tsx:58-154`（retry 250ms 倒计时、AUTH 文案、maxTokens hint）；Mac：`MessageItems.swift:930-1144`（三种颜色、耗尽详情 sheet、hint sheet）。
- 建议：retry 加倒计时；error/maxTokens 加详情入口。

### P1-11 turnTail 动作呈现与 Mac 不一致
- 扩展：`createTurnTailNode:575-610` + CSS —— 所有轮次都 hover 才显形；fork 仅"最后一轮"可用（`:597`），无 in-flight、无失败 toast；指标是纯文本。
- Mac：`MessageItems.swift:1264-1268` 最新轮次常显、其余 hover；fork 对每个完成轮都可用 + `ProgressView` + 失败 toast（`:1330-1369`）；usage/time 是点击弹层 pill（`:1370-1395`）。
- Web：`TurnTailNodeView.tsx:41` `data-actions-reveal=always|hover`；fork 在尾节点非最后时 dim。
- 建议：最新轮常显；fork 放开到每个完成轮并补 in-flight/失败反馈；指标改 pill+弹层。

### P1-12 工具行路径不可打开、整行可点
- 扩展：`updateToolNode:294-335` 整个 header 是 button，`model.filePath` 只加 `.path` class 无行为；无 openFile/open-in-app。
- Mac：`ToolRow.swift:395-414` 摘要路径是 `Link`（相对 cwd 解析，点击 QuickLook），且只有 glyph+summary 的 ink 可点（`:440-471`）。
- Web：`GenericToolCard.tsx:42-54` 路径链接即交互。
- 建议：read/write/edit 的路径改可点（走扩展已有的 open-in-app/host 能力），点击热区收敛到 ink。

### P1-13 turn rail 的 active 不随滚动
- 扩展：`sidepanel-app.js:167-170` 只在首个快照/点击时定 active，滚动不更新。
- Web：`ChatView.tsx:347-374 syncActiveTurn` 用"阅读行"（头部 + min(96, 20% 高)）反推 active turn。
- 建议：滚动时按阅读行更新 active。

### P1-14 连续图片未成组
- 扩展：`updateAssistantNode:232-237` 与 user 消息都逐张 `<img>`。
- Web：`MessageItem.tsx:190-214`/Mac `MessageItems.swift:448-454,522-574` 连续 image 块合成 gallery。
- 建议：相邻 image 块合并成组。

### P1-15 思考摘要算法二选一未定（冲突项）
- 扩展：`thinkingSummary:274-277` 取首个非空行；不剥离 `**`。
- Web：`ReasoningRow.tsx:30` 流式中取**末行**、settle 后取首行，且 `.replaceAll('**','')`；running 仅最后一个 reasoning 块。
- Mac：`ThinkNode.swift:72-77` 恒取首行、无流式预览。
- 裁决：交互口径=Mac → 保留"首行 + 弹窗"，但应补 `.replaceAll('**','')`；是否要"流式中末行"需产品明确。

---

## P2 — 低频 / 性能

- **P2-16 ⌘F 会话内查找缺失**：Mac `ChatFindBar.swift` / Web ChatView 查找；扩展无。
- **P2-17 代码高亮无视口门控**：Web `useViewportHighlighting.ts`；Mac onGeometryChange；扩展 `code-highlight.js` 全量着色。
- **P2-18 assistant 折叠阈值 20000 为自造**：Web 无此折叠（靠增量解析），扩展靠它封顶；P0-2 修好后可放宽或去掉。
- **P2-19 未知 surface/turn-error 无 detail**：`createUnknownNode` 有弹窗、turn-error 无；Web/Mac error 都可展开。
- **P2-20 长文本按 UTF-16 码元切**（`long-message.js:35`）：Mac 按 grapheme cluster 且尽量词边界回退。次要。
- **P2-21 复制反馈 1200ms**（`chat-view.js:41`/`node-views.js:38`）vs Mac 1000ms。次要。

---

## 冲突裁决（逻辑=Web × 交互=Mac 的取舍）

| 项 | Web 逻辑 | Mac 交互 | 采纳 |
|---|---|---|---|
| 工具卡展开 | 行内展开 | modal sheet | Mac（现状已对） |
| 思考行 | 行内 DisclosureRow | 首行 + sheet | Mac（现状已对） |
| 聊天虚拟化 | 不虚拟化 | List 虚拟化 | Web（现状已对，聊天别虚拟化） |
| fork 可用性 | 仅尾节点 | 每个完成轮 | Mac |
| 滚动跟随 | 阈值 + 锚定 | 发送即 pin | Mac |
| turn-process 折叠 | 有（hidden=until-found 保 ⌘F） | 有（移除行） | 逻辑按 Web 的判定、形态按 Mac |

---

## 建议实施顺序

1. **第一批（正确性/安全）**：P0-1 帧校验、P0-3 发送 pin 跟随、P0-4 产出/present/mention、P0-5 AUTH 脱敏。
2. **第二批（核心体验/性能）**：P0-2 增量 Markdown、P0-6 turn-process 折叠、P1-7 Markdown 语法补齐。
3. **第三批（交互对齐 Mac）**：P1-11 turnTail、P1-12 工具路径、P1-13 rail active、P1-8/P1-9/P1-10/P1-14。
4. **第四批**：P2 项。
