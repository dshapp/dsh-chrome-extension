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
  workspaceArchiveSession: "workspace/archiveSession",
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
  agentPresetList: "agentPresets/list",
  agentPresetSelect: "agentPresets/select",
  agentPresetRead: "agentPresets/read",
  agentPresetCopy: "agentPresets/copy",
  agentPresetRemove: "agentPresets/deletePreset",
  agentPresetOpenDocument: "settings/openAgentPresetDirectory",
  // ---- goal ----
  goalCreate: "goals/create",
  goalClear: "goals/clear",
  goalEdit: "goals/edit",
  goalPause: "goals/pause",
  goalResume: "goals/resume",
  // ---- subagent ----
  subagentList: "subagents/list",
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
  // ---- 模型发现 ----
  llmDiscoverModels: "llm/discoverModels",
  // ---- 插件清单(只读)。远端端点只收一个 args 对象,空参也要包装。 ----
  pluginInventoryList: "pluginInventory/list"
});

export const STREAM = Object.freeze({
  events: "$events",
  workspaces: "workspace/follow",
  control: "session/control",
  follow: "session/follow"
});

/// session/follow 与 session/control 的逻辑流帧类型。
export const MUX = Object.freeze({
  sessionEvent: "session/event",
  sessionSubscribed: "session/subscribed",
  sessionQueue: "session/queue",
  sessionJobs: "session/jobs",
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
  deliverablesPresented: "deliverables/presented"
});

/// 审批结论。宿主只接受这四个字面量。
export const APPROVAL_OUTCOME = Object.freeze({
  allowedOnce: "allowed-once",
  rejected: "rejected",
  cancelled: "cancelled",
  unavailable: "unavailable"
});
