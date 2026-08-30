// DSH RPC 方法名与参数键的唯一事实源。对齐 macos/Sources/DSHMacKit/Networking/RPCMethods.swift。
// 散落的字符串字面量是漂移的温床:方法名写错只在运行时炸,且错误信息是 "unknown method"。
// 这里集中一份,调用方从常量取。

export const RPC = Object.freeze({
  // ---- session 生命周期 ----
  sessionList: "session.list",
  sessionSearch: "session.search",
  sessionCreate: "session.create",
  sessionHistory: "session.history",
  sessionRename: "session.rename",
  sessionFork: "session.fork",
  sessionCancel: "session.cancel",
  // ---- 发送 / 队列 ----
  sessionPrompt: "session.prompt",
  sessionUpdateQueue: "session.updateQueue",
  sessionAttachment: "session.attachment",
  // ---- 模型 ----
  sessionModels: "session.models",
  sessionSelectModel: "session.selectModel",
  llmProviders: "llm.providers",
  llmModels: "llm.models",
  // ---- workspace ----
  workspaceList: "workspace.list",
  workspaceCreate: "workspace.create",
  workspaceRename: "workspace.rename",
  workspaceDelete: "workspace.delete",
  workspaceArchiveSession: "workspace.archiveSession",
  // ---- host ----
  hostDescribe: "host.describe",
  hostListDirectory: "host.listDirectory",
  hostCreateDirectory: "host.createDirectory",
  hostOpenPath: "host.openPath",
  // ---- 命令 / 技能 ----
  commandsList: "commands/list",
  commandsExecute: "commands/execute",
  skillList: "skill.list",
  // ---- agent preset ----
  agentPresetList: "agentPreset.list",
  agentPresetSelect: "agentPreset.select",
  agentPresetRead: "agentPreset.read",
  agentPresetCopy: "agentPreset.copy",
  agentPresetRemove: "agentPreset.remove",
  agentPresetOpenDocument: "agentPreset.openDocument",
  // ---- goal ----
  goalCreate: "goal.create",
  goalClear: "goal.clear",
  goalEdit: "goal.edit",
  goalPause: "goal.pause",
  goalResume: "goal.resume",
  // ---- subagent ----
  subagentList: "subagent.list",
  subagentHistory: "subagent.history",
  subagentInterrupt: "subagent.interrupt",
  // ---- settings ----
  settingsDescribe: "settings.describe",
  settingsUpdate: "settings.update",
  // 有序路径编辑({op:"set"|"unset", path:[...]}),后一个 op 观察到前一个的结果。
  settingsMutate: "settings.mutate",
  // 无参:宿主原生打开用户层 settings.yaml。
  settingsOpenDocument: "settings.openDocument",
  // ---- 凭证库(API 密钥不写进设置文件) ----
  credentialsDescribe: "credentials.describe",
  credentialsSet: "credentials.set",
  credentialsUnset: "credentials.unset",
  // ---- 模型发现 ----
  llmDiscoverModels: "llm.discoverModels",
  // ---- 插件清单(只读)。远端端点只收一个 args 对象,空参也要包装。 ----
  pluginInventoryList: "pluginInventory/list"
});

/// 下行 mux 帧类型(events.mux)。
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

/// 下行 host 帧类型(events.host)。
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
  userMessage: "user/message",
  turnStart: "turn/start",
  turnEnd: "turn/end",
  stepStart: "step/start",
  stepEnd: "step/end",
  assistantChunk: "assistant/chunk",
  assistantMessage: "assistant/message",
  toolCall: "tool/call",
  toolResult: "tool/result",
  codeDispatchStart: "tool/code-dispatch-start",
  codeDispatch: "tool/code-dispatch",
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
  workflowRunEnd: "tool-workflow/run-end"
});

/// 审批结论。宿主只接受这四个字面量。
export const APPROVAL_OUTCOME = Object.freeze({
  allowedOnce: "allowed-once",
  rejected: "rejected",
  cancelled: "cancelled",
  unavailable: "unavailable"
});
