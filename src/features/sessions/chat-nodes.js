// 会话节点模型。对齐 macos/Sources/DSHMacKit/Models/ChatNode.swift 的 13 个 case。
//
// 与旧版扁平 items[] 的关键差别:节点由 store 的 keyed contexts 映射materialize 而来,
// 再按 (anchorSeq, id) 全序排序。anchorSeq 上的小数偏移不是随意的——它让同一 seq 上
// 产生的多个节点有确定的相对次序(turnMaxTokens 排在错误之后、turnTail 排在最末)。

/// 节点种类。
export const NodeKind = Object.freeze({
  user: "user",
  steering: "steering",
  // 唤醒本轮的非人类消息(web `turn-trigger`)。其余普通 context 注入不进聊天记录
  // (web contract/chat-visibility.ts isVisibleChatNode),只在 Trajectory 里看。
  turnTrigger: "turnTrigger",
  assistant: "assistant",
  toolCall: "toolCall",
  compaction: "compaction",
  modelRetry: "modelRetry",
  turnError: "turnError",
  turnMaxTokens: "turnMaxTokens",
  command: "command",
  turnProcess: "turnProcess",
  turnTail: "turnTail",
  workflowRun: "workflowRun",
  unknownSurface: "unknownSurface"
});

export const AssistantStatus = Object.freeze({
  running: "running",
  settled: "settled",
  interrupted: "interrupted"
});

export const ToolRowState = Object.freeze({
  running: "running",
  ok: "ok",
  error: "error",
  stopped: "stopped"
});

export const WorkflowStatus = Object.freeze({
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted"
});

export const RetryState = Object.freeze({
  scheduled: "scheduled",
  started: "started",
  cancelled: "cancelled"
});

/// 节点稳定 id。排序时用作 anchorSeq 相同时的 tiebreaker,因此必须是节点身份的纯函数。
export function nodeId(node) {
  switch (node.kind) {
    case NodeKind.user: return `u-${node.messageId}`;
    case NodeKind.steering: return `s-${node.messageId}`;
    case NodeKind.turnTrigger: return `trg-${node.messageId}`;
    case NodeKind.assistant: return `a-${node.turn}:${node.step}`;
    case NodeKind.toolCall: return `t-${node.callId}`;
    case NodeKind.compaction: return `cmp-${node.compactionId}`;
    case NodeKind.modelRetry: return `rty-${node.retryId}`;
    case NodeKind.turnError: return `err-${node.turn}`;
    case NodeKind.turnMaxTokens: return `mt-${node.turn}`;
    case NodeKind.command: return `cmd-${node.commandId}`;
    case NodeKind.turnProcess: return `tp-${node.turn}`;
    case NodeKind.turnTail: return `ttl-${node.turn}`;
    case NodeKind.workflowRun: return `wf-${node.runId}`;
    case NodeKind.unknownSurface: return `unk-${node.seq}`;
    default: return `node-${node.seq ?? 0}`;
  }
}

/// 排序锚点。小数偏移照搬 Mac:同 seq 上 turnMaxTokens 后置 0.05、turnTail 后置 0.1。
export function anchorSeq(node) {
  switch (node.kind) {
    case NodeKind.assistant: return node.firstVisibleSeq ?? node.startSeq;
    case NodeKind.toolCall: return node.startSeq;
    case NodeKind.turnMaxTokens: return node.seq + 0.05;
    // 对齐 web CHAT_SYNTHETIC_SEQ_OFFSETS.processControl = -0.1:折叠头排在首个成员之前。
    case NodeKind.turnProcess: return node.seq - 0.1;
    case NodeKind.turnTail: return node.seq + 0.1;
    case NodeKind.workflowRun: return node.anchorSeq;
    default: return node.seq;
  }
}

/// 该行是否仍在进行中(驱动运行态图标与"停止"语义)。
export function isNodeRunning(node) {
  if (node.kind === NodeKind.assistant) return node.status === AssistantStatus.running;
  if (node.kind === NodeKind.toolCall) return node.result == null;
  return false;
}

/// 该行所属的 turn;返回 null 表示不参与按 turn 的分组(hover 区、turnTail 归并)。
export function nodeTurn(node) {
  switch (node.kind) {
    case NodeKind.assistant:
    case NodeKind.toolCall:
    case NodeKind.turnError:
    case NodeKind.turnMaxTokens:
    case NodeKind.turnProcess:
    case NodeKind.turnTail:
      return node.turn;
    default:
      return null;
  }
}

// ---- 节点工厂 ----

export function userNode({ seq, time, messageId, content }) {
  return { kind: NodeKind.user, seq, time, messageId, content: content ?? [] };
}

export function steeringNode({ seq, time, messageId, content }) {
  return { kind: NodeKind.steering, seq, time, messageId, content: content ?? [] };
}

/// 唤醒本轮的非人类消息(对齐 Mac TurnTriggerNode)。source 决定标题与图标。
export function turnTriggerNode({ seq, time, messageId, content, source }) {
  return { kind: NodeKind.turnTrigger, seq, time, messageId, content: content ?? [], source: source ?? null };
}

/// 按 source.kind 选标题 key 与图标名(web chat/turn-trigger.ts turnTriggerDetails)。
/// 未登记的来源用通用"收到执行请求",不臆造身份。
export function turnTriggerDetails(source) {
  const record = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  switch (record.kind) {
    case "goal": return { title: "message.trigger.goal", icon: "target" };
    case "agent-message": return { title: "message.trigger.agent", icon: "send-horizontal" };
    case "team-message": return { title: "message.trigger.team", icon: "message-circle" };
    case "subagent-settled": return { title: "message.trigger.subagent", icon: "git-fork" };
    case "webhook":
      return record.provider === "github"
        ? { title: "message.trigger.github", icon: "git-branch" }
        : { title: "message.trigger.webhook", icon: "globe" };
    case "schedule": return { title: "message.trigger.schedule", icon: "clock" };
    case "tool-jobs": return { title: "message.trigger.job", icon: "list" };
    case "cordis-host-runner": return { title: "message.trigger.plugin", icon: "puzzle" };
    default: return { title: "message.trigger.request", icon: "layers" };
  }
}

/// assistant step。blocks 是稀疏槽位数组(索引由 wire 的 chunk.index 指定),
/// 未开始的槽位为 null——不能压缩,否则后续 delta 的 index 会错位。
export function assistantNode({ turn, step, startSeq, time }) {
  return {
    kind: NodeKind.assistant,
    turn, step, startSeq, time,
    firstVisibleSeq: null,
    status: AssistantStatus.running,
    blocks: [],
    usage: null,
    messageId: null,
    provider: null,
    model: null,
    interrupted: false,
    stepStartTime: null,
    firstTokenTime: null
  };
}

/// assistant step 是否有可见内容。
/// 重试会把 blocks 清空,该行随即从记录中消失,直到重试产出新内容。
export function assistantHasVisibleContent(node) {
  return (node.blocks ?? []).some((block) => {
    if (!block) return false;
    if (block.type === "text" || block.type === "reasoning") return Boolean(block.text);
    // 尚未拿到 id 的 tool-call 槽位还不是一个可展示的调用。
    if (block.type === "tool-call") return Boolean(block.callId);
    return true;
  });
}

/// 该 step 是否投影出一行。被打断的 step 即使没有可见内容也要成行:
/// "已停止"的观感正是这一行存在的意义,压掉它就抹去了本轮被取消的唯一证据。
export function assistantVisible(node) {
  return assistantHasVisibleContent(node) || node.interrupted;
}

export function toolCallNode({ callId, name, argsRaw, turn, step, startSeq, time, rootCallId, parentCallId, callView }) {
  return {
    kind: NodeKind.toolCall,
    callId, name, argsRaw: argsRaw ?? "", turn, step, startSeq, time,
    rootCallId: rootCallId ?? null,
    parentCallId: parentCallId ?? null,
    result: null,
    callView: callView ?? null,
    subCalls: []
  };
}

export function toolResult({ seq, time, content, isError, error, meta, resultView }) {
  return {
    seq, time,
    content: content ?? [],
    isError: Boolean(isError),
    error: error ?? null,
    meta: meta ?? null,
    resultView: resultView ?? null
  };
}

export function compactionNode({ compactionId, seq, time }) {
  return {
    kind: NodeKind.compaction, compactionId, seq, time,
    summary: null, summaryEventSeq: null,
    shadowedItemCount: null, shadowedTokenCount: null
  };
}

export function modelRetryNode({ retryId, seq, time }) {
  return {
    kind: NodeKind.modelRetry, retryId, seq, time,
    retryState: RetryState.scheduled, retry: 1, maxRetries: null, delayMs: null,
    failureMessage: null, failureCode: null, provider: null
  };
}

export function turnErrorNode({ seq, time, turn, step, message, code }) {
  return { kind: NodeKind.turnError, seq, time, turn, step: step ?? null, message, code: code ?? null };
}

export function turnMaxTokensNode({ seq, time, turn, step }) {
  return { kind: NodeKind.turnMaxTokens, seq, time, turn, step: step ?? null };
}

export function commandNode({ commandId, seq, time }) {
  return { kind: NodeKind.command, commandId, seq, time, name: null, args: null, outcome: null };
}

/// Turn 折叠头(web turn-process / mac TurnProcessRow)。
export function turnProcessNode(spec) {
  return { kind: NodeKind.turnProcess, ...spec };
}

export function turnTailNode({ turn, seq, time }) {
  return {
    kind: NodeKind.turnTail, turn, seq, time,
    usage: null, ttftMs: null, decodeTokensPerSec: null,
    closingText: null, messageId: null, runMs: null
  };
}

export function workflowRunNode({ runId, name, status, phases, anchorSeq: anchor }) {
  return { kind: NodeKind.workflowRun, runId, name, status, phases, anchorSeq: anchor };
}

export function unknownSurfaceNode({ seq, time, type, data }) {
  return { kind: NodeKind.unknownSurface, seq, time, type, data };
}

// ---- 内容块辅助 ----

/// wire 内容块 → assistant 显示块。tool-result 块不入 assistant 行(它归工具行)。
export function toAssistantBlock(block) {
  if (!block || typeof block !== "object") return { type: "other", value: block };
  switch (block.type) {
    case "text": return { type: "text", text: block.text ?? "" };
    case "reasoning": return { type: "reasoning", text: block.text ?? "" };
    case "image": return { type: "image", attachment: block.attachment ?? null };
    case "tool-call": return { type: "tool-call", callId: block.id ?? "", name: block.name ?? "", argsRaw: block.arguments ?? "" };
    case "tool-result": return { type: "other", value: null };
    default: return { type: "other", value: block };
  }
}

/// 内容块数组 → 纯文本。图片折成占位符,其余非文本块折成 JSON。
export function blocksToText(blocks) {
  return (blocks ?? [])
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return "[image]";
      return "";
    })
    .join("\n")
    .trim();
}

/// 空块槽位(block-start 用)。
export function emptyBlockFor(blockType) {
  switch (blockType) {
    case "text": return { type: "text", text: "" };
    case "reasoning": return { type: "reasoning", text: "" };
    case "tool-call": return { type: "tool-call", callId: "", name: "", argsRaw: "" };
    case "image": return { type: "image", attachment: null };
    default: return { type: "other", value: null };
  }
}
