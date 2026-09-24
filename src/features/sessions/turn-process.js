// Turn process 折叠:把一轮回答之前的思考/工具/旧回复收进一个折叠头。
//
// 判定对齐 web conversation-nodes/turn-process.ts:
// - 折叠头只在出现"最终回答"之后才有意义(processWindowReady 要求 answerAnchorSeq 非空);
// - 成员 = 同轮、anchorSeq ∈ [processStartSeq, answerAnchorSeq) 且不属于独立种类;
// - 计数分"回复消息数 / 工具调用数 / 子代理数",子代理按工具名识别。
//
// 输出形态对齐 Mac TurnProcessRow:chevron + "N tool calls · N messages · N subagents";
// 三项皆 0 时退化为 "Thought for a while"(由渲染层处理)。
import { NodeKind, anchorSeq, nodeTurn, assistantHasVisibleContent } from "./chat-nodes.js";

/// 不参与折叠、始终独立成行的种类(web TURN_PROCESS_INDEPENDENT_KINDS / process-groups.ts INDEPENDENT)。
/// turnTrigger 与 user/steering 同级:它说明谁唤醒了本轮,是回答的框架而不是过程证据,
/// 不能被折进它自己开启的过程组(对齐 Mac 267bcde isProcessMember)。
export const PROCESS_INDEPENDENT_KINDS = new Set([
  NodeKind.user,
  NodeKind.steering,
  NodeKind.turnTrigger,
  NodeKind.turnProcess,
  NodeKind.turnError,
  NodeKind.turnMaxTokens,
  NodeKind.turnTail
]);

/// web isSubagentDelegationTool:subagent / subagent_*。
export function isSubagentDelegationTool(name) {
  const value = String(name ?? "");
  return value === "subagent" || value.startsWith("subagent_");
}

function assistantHasText(node) {
  return (node.blocks ?? []).some((block) => block?.type === "text" && block.text);
}

function assistantHasToolCall(node) {
  return (node.blocks ?? []).some((block) => block?.type === "tool-call");
}

/// 该 assistant step 是否是"承载回答"的最终步:已结算、有文本、且不含工具调用。
/// 对齐 web latestAnswer 的判定(blocks 全为回答内容)。
function isFinalAnswer(node) {
  return node.kind === NodeKind.assistant
    && node.status !== "running"
    && node.messageId != null
    && assistantHasText(node)
    && !assistantHasToolCall(node);
}

function nodeSeq(node) {
  return node.kind === NodeKind.assistant
    ? (node.firstVisibleSeq ?? node.startSeq)
    : (node.startSeq ?? node.seq);
}

/// 单个 turn 的折叠规格;没有证据或没有最终回答时返回 null。
function turnSpec(turn, nodes, turnStartSeq) {
  const owned = nodes.filter((node) => nodeTurn(node) === turn);
  // 证据看"是否有可见内容"(含 reasoning);回复计数看"是否承载文本"。
  const visibleAssistants = owned
    .filter((node) => node.kind === NodeKind.assistant && assistantHasVisibleContent(node))
    .sort((a, b) => a.step - b.step);
  const replyAssistants = visibleAssistants.filter(assistantHasText);
  const tools = owned.filter((node) => node.kind === NodeKind.toolCall);

  const evidenceSeqs = [
    ...tools.map(nodeSeq),
    ...visibleAssistants.map(nodeSeq)
  ].filter((seq) => Number.isFinite(seq));
  if (!evidenceSeqs.length) return null;

  const answer = [...visibleAssistants].reverse().find(isFinalAnswer);
  if (!answer) return null;

  const answerSeq = nodeSeq(answer);
  const earlierAssistantSeqs = visibleAssistants.filter((n) => n.step < answer.step).map(nodeSeq);
  const externalSeqs = [
    ...(turnStartSeq != null ? [] : tools.map(nodeSeq)),
    ...earlierAssistantSeqs
  ].filter((seq) => Number.isFinite(seq));

  let toolCallCount = 0;
  let subagentCount = 0;
  for (const tool of tools) {
    // 嵌套子调用不进记录流,也不计入折叠头的计数(与可见行一致)。
    if (tool.parentCallId != null) continue;
    if (isSubagentDelegationTool(tool.name)) subagentCount += 1;
    else toolCallCount += 1;
  }
  const messageCount = replyAssistants.filter((n) => n.step < answer.step).length;

  return {
    turn,
    seq: Math.min(...evidenceSeqs),
    controlAnchorSeq: Math.min(...evidenceSeqs),
    processStartSeq: turnStartSeq ?? (externalSeqs.length ? Math.min(...externalSeqs) : answerSeq),
    answerAnchorSeq: answerSeq,
    answerStep: answer.step,
    inlineReasoning: (answer.blocks ?? []).some((block) => block?.type === "reasoning" && block.text),
    messageCount,
    toolCallCount,
    subagentCount
  };
}

/// 为所有已出现最终回答的 turn 计算折叠规格。
/// @param {Array} nodes 已 materialize 的节点(不含折叠头自身)。
/// @param {Map<number, number>} turnStartSeqs turn → turn/start seq。
export function buildTurnProcessSpecs(nodes, turnStartSeqs = new Map()) {
  const turns = new Set();
  for (const node of nodes) {
    const turn = nodeTurn(node);
    if (turn != null) turns.add(turn);
  }
  const specs = new Map();
  for (const turn of turns) {
    const spec = turnSpec(turn, nodes, turnStartSeqs.get(turn) ?? null);
    if (!spec) continue;
    // 没有可折叠成员时折叠头不该占行(web foldable 的等价判定)。
    spec.memberCount = nodes.reduce((count, node) => count + (isProcessMember(node, spec) ? 1 : 0), 0);
    specs.set(turn, spec);
  }
  return specs;
}

/// 某节点是否落入折叠窗口(web ChatNodeSeat 的 processMember 判定)。
export function isProcessMember(node, spec) {
  if (!spec || spec.answerAnchorSeq == null) return false;
  if (PROCESS_INDEPENDENT_KINDS.has(node.kind)) return false;
  if (nodeTurn(node) !== spec.turn) return false;
  const anchor = anchorSeq(node);
  return anchor >= spec.processStartSeq && anchor < spec.answerAnchorSeq;
}
