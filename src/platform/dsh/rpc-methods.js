// DSH RPC 方法名与参数键的唯一事实源。对齐 macos/Sources/DSHMacKit/Networking/RPCMethods.swift。
// 散落的字符串字面量是漂移的温床:方法名写错只在运行时炸,且错误信息是 "unknown method"。
// 这里集中一份,调用方从常量取。

export const RPC = Object.freeze({
  // ---- session 生命周期 ----
  sessionList: "session/list",
  sessionSearch: "session/search",
  sessionCreate: "session/create",
  sessionPage: "session/page",
  sessionRename: "session/rename",
  sessionFork: "session/fork",
  sessionCancel: "session/cancel",
  // ---- 发送 / 队列 ----
  sessionPrompt: "session/prompt",
  sessionUpdateQueue: "session/updateQueue",
  sessionAttachment: "session/attachment",
  // ---- 模型 ----
  sessionModels: "session/modelCatalog",
  sessionSelectModel: "session/selectModel",
  sessionCanOpenWorkspacePath: "session/canOpenWorkspacePath",
  llmProviders: "llm/listProviders",
  llmConfigurableProviders: "llm/listConfigurableProviders",
  // ---- workspace ----
  workspaceCreate: "workspace/create",
  workspaceRename: "workspace/rename",
  workspaceDelete: "workspace/delete",
  // 0.1.7:首次使用的默认工作区 {request:{directoryName,title}}。仅注册表与会话历史都为空时
  // 建 <Documents>/deepseek-harness/<directoryName>;已有默认则返回它;首次使用结束后 ok 但无 value。
  workspaceInitializeDefault: "workspace/initializeDefault",
  // 0.1.7:有活在跑的会话会被拒成 workspace/session-active,带 stopActivity:true 重试即先停再归档。
  workspaceArchiveSession: "workspace/archiveSession",
  // 0.1.6+:取消归档,回包是完整的归档集合 {archivedSessionIds}。
  workspaceUnarchiveSession: "workspace/unarchiveSession",
  // 0.1.7 起置顶由宿主保存(注册表级,最近置顶的在前),workspace/follow 以 pinned 帧广播。
  workspacePinSession: "workspace/pinSession",
  workspaceUnpinSession: "workspace/unpinSession",
  // 排序:beforeXxxId 省略即追加到末尾。前者排工作区本身,后者排某个工作区内的会话。
  workspaceInsertBefore: "workspace/insertBefore",
  workspaceInsertSessionBefore: "workspace/insertSessionBefore",
  // ---- host ----
  hostOpenPath: "session/openWorkspacePath",
  // ---- 命令 / 技能 ----
  commandsList: "commands/list",
  commandsExecute: "commands/execute",
  skillList: "skills/list",
  // ---- agent preset ----
  // 0.1.7 预设改为在配置文件里声明:read/copy/deletePreset 与打开预设目录的端点
  // 全部删除,只剩列表与选择;默认预设写 agent-preset-registry.selectedDefault。
  agentPresetList: "agentPresets/list",
  agentPresetSelect: "agentPresets/select",
  // ---- goal ----
  goalCreate: "goals/create",
  goalClear: "goals/clear",
  goalEdit: "goals/edit",
  goalPause: "goals/pause",
  goalResume: "goals/resume",
  // ---- subagent ----
  // 0.1.7 删了 subagents/list:子代理目录改读父会话的 subagentCatalog 投影
  // (session/projections 不激活父 agent),运行态取子会话 SessionSummary.running。
  sessionProjections: "session/projections",
  subagentPrompt: "subagents/prompt",
  subagentInterrupt: "subagents/interruptByParent",
  // ---- settings ----
  settingsDescribe: "settings/describe",
  settingsUpdate: "settings/update",
  // 有序路径编辑({op:"set"|"unset", path:[...]}),后一个 op 观察到前一个的结果。
  settingsMutate: "settings/mutate",
  // 无参:宿主原生打开用户层 settings.yaml。
  settingsOpenDocument: "settings/openSettingsDocument",
  // ---- 凭证库(API 密钥不写进设置文件) ----
  credentialsDescribe: "credentials/describe",
  credentialsSet: "credentials/set",
  credentialsUnset: "credentials/unset",
  // ---- 后台任务(0.1.7 job/*) ----
  jobKill: "job/kill",
  // ---- 模型发现 ----
  llmDiscoverModels: "llm/discoverModels",
  // ---- 权限预设目录(0.1.6) ----
  // 0.1.6 把可选预设从 permissions 投影里搬到了进程级 RPC:catalog 返回
  // {options:[{value,name}]},变更由 permission-presets/catalog-changed 通知。
  // 0.1.5 没有这个命名空间,调用会以 endpoint-unknown 失败 —— 那时继续用投影
  // 自带的 options(见 session-store 的 mergePermissionSelection)。
  permissionPresetsCatalog: "permissionPresets/catalog",
  // ---- 插件清单(只读)。远端端点只收一个 args 对象,空参也要包装。 ----
  pluginInventoryList: "pluginInventory/list",
  // ---- 插件市场(0.1.6 pluginManager/*)。与 Mac PluginsPage 同一批端点:
  // bundle 列表/启停/卸载、插件行启停、按 spec 检查与安装、取消安装。 ----
  pluginManagerListBundles: "pluginManager/listBundles",
  pluginManagerListPlugins: "pluginManager/listPlugins",
  pluginManagerSetBundleEnabled: "pluginManager/setBundleEnabled",
  pluginManagerSetPluginEnabled: "pluginManager/setPluginEnabled",
  pluginManagerRemoveBundle: "pluginManager/removeBundle",
  pluginManagerInspect: "pluginManager/inspect",
  pluginManagerInstallBundle: "pluginManager/installBundle",
  pluginManagerCancelInstall: "pluginManager/cancelInstall",
  // 0.1.7 安装下载源:宿主配置的首选源/回退/pnpm 自身指向的 URL({registry, fallbackRegistries, resolved}),
  // 以及并行 ping npmjs/npmmirror 取最快者(string | null)。对齐 Mac pluginManagerRegistries / pluginRegistryProbeFastest。
  pluginManagerRegistries: "pluginManager/registries",
  pluginRegistryProbeFastest: "pluginRegistryProbe/fastest"
});

export const STREAM = Object.freeze({
  events: "$events",
  workspaces: "workspace/follow",
  control: "session/control",
  // 0.1.7:每会话一条后台任务名册流,帧 {type:"rows", jobs} 整组替换。
  jobs: "job/list",
  // 0.1.7:单个任务的输出观测流 {request:{sessionId?, jobId, from?}}。帧 opened{job,from}
  // → output{chunks:[{text,gapBefore?}], next, lossy?}* → 终态 status{job} 后正常关闭。
  jobFollow: "job/follow",
  follow: "session/follow"
});

/// session/follow 与 session/control 的逻辑流帧类型。
export const MUX = Object.freeze({
  sessionEvent: "session/event",
  sessionSubscribed: "session/subscribed",
  sessionProjection: "session/projection",
  approvalRequested: "approval/requested",
  approvalResolved: "approval/resolved",
  questionRequested: "question/requested",
  questionResolved: "question/resolved",
  streamError: "stream/error"
});

/// `$events` 事件折算后的宿主通知类型。
export const HOST = Object.freeze({
  sessionAdded: "host/session-added",
  sessionRemoved: "host/session-removed",
  sessionStatus: "host/session-status",
  agentError: "host/agent-error",
  workspaceChanged: "host/workspace-changed",
  workspaceRemoved: "host/workspace-removed",
  workspaceOrderChanged: "host/workspace-order-changed",
  archivedSessionsChanged: "host/archived-sessions-changed",
  // 0.1.6 新转发的宿主事件折算成两条内部通知(见 session-service 的 $events emit):
  // 权限目录失效要重拉 catalog;插件启停/装载变更要让已打开的插件页重读清单。
  permissionCatalogChanged: "host/permission-catalog-changed",
  pluginManagerChanged: "host/plugin-manager-changed",
  remoteEvent: "host/remote-event",
  streamError: "stream/error"
});

/// SessionEvent.type 全集。session-store 的 switch 以此为准;
/// 不在表内的 type 走 unknownSurface 兜底行,而非静默丢弃。
export const EVT = Object.freeze({
  inboxSpliced: "agent/inbox/spliced",
  requestHeader: "request/header",
  // system/message 属于 Web 的 request/trajectory 视图,不进主聊天记录:
  // 不显式忽略会在每次会话开头画一行"未处理的事件:system/message"。
  systemMessage: "system/message",
  userMessage: "user/message",
  turnStart: "turn/start",
  turnEnd: "turn/end",
  stepStart: "step/start",
  stepEnd: "step/end",
  assistantChunk: "assistant/chunk",
  assistantMessage: "assistant/message",
  assistantAttempt: "assistant/attempt",
  toolCall: "tool/call",
  toolResult: "tool/result",
  // 会话格式 v3 起改名为 ptc-dispatch(Code Dispatch 的旧名只出现在历史会话里),
  // 两个都收,否则 run_code 下的所有子调用在扩展里整段消失。
  codeDispatchStart: "tool/code-dispatch-start",
  codeDispatch: "tool/code-dispatch",
  ptcDispatchStart: "tool/ptc-dispatch-start",
  ptcDispatch: "tool/ptc-dispatch",
  llmRetry: "llm/retry",
  llmRetryStarted: "llm/retry-started",
  compactionStart: "compaction/start",
  compactionSummary: "compaction/summary",
  compactionEnd: "compaction/end",
  compactionPrune: "compaction/prune",
  commandRun: "command/run",
  commandDone: "command/done",
  sessionTitle: "session/title",
  workflowRunStart: "tool-workflow/run-start",
  workflowAgentStart: "tool-workflow/agent-start",
  workflowAgentEnd: "tool-workflow/agent-end",
  workflowRunEnd: "tool-workflow/run-end",
  deliverablesPresented: "deliverables/presented",
  // workspace-changes 插件的"本轮改动文件"公告:只带 turn,摘要与逐文件对比
  // 要按这条事件自己的 seq 去宿主 /api/changes.* 读(见 features/changes)。
  workspaceChanges: "workspace/changes"
});

/// 审批结论。宿主只接受这四个字面量。
export const APPROVAL_OUTCOME = Object.freeze({
  allowedOnce: "allowed-once",
  rejected: "rejected",
  cancelled: "cancelled",
  unavailable: "unavailable"
});
