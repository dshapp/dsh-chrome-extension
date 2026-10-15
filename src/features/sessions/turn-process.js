// Turn process 折叠:把一轮回答之前的思考/工具/旧回复收进一个折叠头。
//
// 逐条移植 Mac SessionStore.rebuildTurnProcessSpecs / isFoldedProcessRow
// (Mac 本身移植 web conversation-nodes/turn-process.ts):
// - 只有已关闭(之后有 turn/end)、正常完成且中途没有插话(steering)的轮才折叠;
//   最后一个 assistant step 已结算、带真实回复文本且不含工具调用时它就是最终回答,
//   回答之前的过程收起;没有这样的回答时整轮都是过程,一直收到 turn/end
//   (web answerAnchorSeq === null);
// - 已关闭的局部窗口也可折叠,从最早的已加载过程行起算(0.2.1);
// - turn/start 之前输入的命令(如 /goal)是用户自己的输入,不算过程;
// - 成员按 **anchor 区间** [processStartSeq, foldEndSeq) 判定,而不是按行的 turn 号:
//   command / retry / compaction 这类行根本没有 turn 号,孤儿结果的 turn 号也可能
//   指向窗口外的更早一轮,但它们都落在区间内,正是读者要求收起的过程证据;
// - 计数只数模型自己做的事:回复消息数 / 工具调用数 / 子代理数。
//
// 输出形态对齐 0.2.1 Mac TurnProcessRow:完成/停止/失败状态 + 成功轮用时。
// 只有成功的最终回答外存在过程或自身 reasoning 时才提供 chevron;正文始终外置。
import { NodeKind, AssistantStatus, anchorSeq, nodeTurn } from "./chat-nodes.js";

/// 不参与折叠、始终独立成行的种类(Mac isFoldedProcessRow 的独立名单 /
/// web TURN_PROCESS_INDEPENDENT_KINDS)。名单之外的种类一律随区间折叠,
/// 这样以后新增的行种类会跟着收起,而不是悄悄逃出折叠组。
export const PROCESS_INDEPENDENT_KINDS = new Set([
  NodeKind.user,
  NodeKind.steering,
  NodeKind.turnTrigger,
  NodeKind.turnProcess,
  NodeKind.turnError,
  NodeKind.turnMaxTokens,
  NodeKind.turnTail
]);

/// 标记过程起点、但不进计数的种类(Mac:.modelRetry, .compaction, .command, .workflowRun, .unknownSurface)。
const PROCESS_EVIDENCE_KINDS = new Set([
  NodeKind.modelRetry,
  NodeKind.compaction,
  NodeKind.command,
  NodeKind.workflowRun,
  NodeKind.unknownSurface
]);

/// 开启新框架的输入:之后的行不能再记到它之前那一轮。
const OPENING_INPUT_KINDS = new Set([NodeKind.user, NodeKind.steering, NodeKind.turnTrigger]);

/// web isSubagentDelegationTool:subagent / subagent_*。
export function isSubagentDelegationTool(name) {
  const value = String(name ?? "");
  return value === "subagent" || value.startsWith("subagent_");
}

/// assistant 块是否是面向用户的回复内容(Mac isReplyBlock / web hasAssistantReplyContent):
/// reasoning 与 tool-call 是过程,不是回答。
function isReplyBlock(block) {
  if (!block) return false;
  switch (block.type) {
    case "text": return Boolean(block.text && block.text.trim());
    case "reasoning":
    case "tool-call":
      return false;
    default:
      return true;
  }
}

function hasReasoning(node) {
  return (node.blocks ?? []).some((block) => block?.type === "reasoning" && Boolean(block.text?.trim()));
}

/// 为所有可折叠的已关闭 turn 计算折叠规格。
/// @param {Array} rows 已按 anchor 排好序的节点(不含折叠头自身)。
/// @param {{ hasMore?: boolean, turnClosedAfter?: (seq: number) => boolean }} options
///   hasMore:已加载窗口是否还能向前增长;turnClosedAfter:该 seq 之后是否有 turn/end。
export function buildTurnProcessSpecs(rows, { turnClosedAfter = () => false, turnEnd = () => null, turnStartTime = () => null, turnStartSeq = () => null } = {}) {
  const specs = new Map();

  const byTurn = new Map();
  const order = [];
  // 行按记录顺序到来:最近一个带 turn 号的行打开的那一轮,就是无 turn 行(重试、命令)的归属。
  // 开启新框架的输入(user/steering/turnTrigger)终止这种归属。
  let openTurn = null;
  // 本轮第一个带 turn 号的行之前见到的无 turn 行:它们是最早的过程证据,
  // 折叠组必须从它们开始,否则它们会被晾在折叠头上方。
  let pendingAnchors = [];
  // 输入到来时已经有行的那一轮:同一轮之后若还有 step / 工具,这条输入就是中途插话
  // (web hasInterleavedInput),该轮保持展开。
  let turnBeforeInput = null;

  for (const node of rows) {
    if (OPENING_INPUT_KINDS.has(node.kind)) {
      if (openTurn != null) turnBeforeInput = openTurn;
      openTurn = null;
      pendingAnchors = [];
      continue;
    }
    const owned = nodeTurn(node);
    if (owned != null) {
      if (owned === turnBeforeInput && (node.kind === NodeKind.assistant || node.kind === NodeKind.toolCall)) {
        const steered = byTurn.get(owned);
        if (steered) steered.interleaved = true;
      }
      turnBeforeInput = null;
      openTurn = owned;
    }
    const anchor = anchorSeq(node);
    if (openTurn == null) {
      pendingAnchors.push({ anchor, command: node.kind === NodeKind.command });
      continue;
    }
    let acc = byTurn.get(openTurn);
    if (!acc) {
      acc = { processAnchors: [], lastStep: null, lastAnchor: anchor, messagesByStep: new Map(), toolCalls: 0, subagents: 0, interleaved: false };
      byTurn.set(openTurn, acc);
      order.push(openTurn);
    }
    acc.lastAnchor = anchor;
    if (pendingAnchors.length) {
      // turn/start 之前输入的命令是用户输入,不能把折叠起点拉到 /goal 气泡上方(web 只从 turn/start 起折)。
      const start = turnStartSeq(openTurn);
      for (const pending of pendingAnchors) {
        if (!pending.command || start == null || pending.anchor >= start) acc.processAnchors.push(pending.anchor);
      }
      pendingAnchors = [];
    }
    if (node.kind === NodeKind.assistant) {
      const blocks = node.blocks ?? [];
      const hasReply = blocks.some(isReplyBlock);
      if (hasReply) acc.messagesByStep.set(node.step, (acc.messagesByStep.get(node.step) ?? 0) + 1);
      // 被后续 step 取代的 step 一律是过程,无论它装着什么。
      if (acc.lastStep) acc.processAnchors.push(acc.lastStep.anchor);
      const isAnswer = node.status === AssistantStatus.settled && hasReply
        && !blocks.some((block) => block?.type === "tool-call");
      acc.lastStep = { anchor, step: node.step, isAnswer, reasoning: hasReasoning(node) };
    } else if (node.kind === NodeKind.toolCall && !node.preparing) {
      if (isSubagentDelegationTool(node.name)) acc.subagents += 1;
      else acc.toolCalls += 1;
      acc.processAnchors.push(anchor);
    } else if (PROCESS_EVIDENCE_KINDS.has(node.kind)) {
      // 重试、命令、压缩标记过程从哪里开始,但不进摘要计数。
      acc.processAnchors.push(anchor);
    }
    // turnTail / turnError / turnMaxTokens 留在组外。
  }

  for (const turn of order) {
    const acc = byTurn.get(turn);
    const last = acc?.lastStep;
    const end = turnEnd(turn);
    if (!end && (!last || !turnClosedAfter(Math.floor(last.anchor)))) continue;
    const outcome = end?.reason === "aborted" ? "stopped" : end?.reason === "error" ? "failed" : "completed";
    const answerAnchor = last?.anchor ?? acc.lastAnchor;
    const isAnswer = Boolean(last?.isAnswer);
    // 有最终回答:收起回答之前的过程;没有:整轮都是过程,收到 turn/end 为止。
    const earlier = isAnswer ? acc.processAnchors.filter((seq) => seq < answerAnchor) : acc.processAnchors;
    const external = earlier.length ? Math.min(...earlier) : null;
    const foldEnd = isAnswer ? answerAnchor : end?.seq != null ? end.seq + 0.5 : null;
    const foldable = outcome === "completed" && !acc.interleaved && foldEnd != null
      && (!isAnswer || external != null || last.reasoning);
    const startedAt = turnStartTime(turn);
    let messageCount = 0;
    for (const [step, count] of acc.messagesByStep) if (!foldable || !isAnswer || step < last.step) messageCount += count;
    const processStart = Math.min(external ?? answerAnchor, answerAnchor);
    const spec = {
      turn,
      seq: processStart,
      processStartSeq: processStart,
      answerAnchorSeq: isAnswer ? answerAnchor : null,
      foldEndSeq: foldable ? foldEnd : null,
      answerStep: last?.step ?? null,
      inlineReasoning: Boolean(foldable && isAnswer && last.reasoning),
      outcome,
      durationMs: outcome === "completed" && startedAt != null && end?.time != null
        ? Math.max(0, end.time - startedAt) : null,
      messageCount,
      toolCallCount: acc.toolCalls,
      subagentCount: acc.subagents
    };
    spec.memberCount = rows.reduce((count, node) => count + (isProcessMember(node, spec) ? 1 : 0), 0);
    specs.set(turn, spec);
  }
  return specs;
}

/// 某节点是否落入该折叠窗口(Mac TurnProcessSpec.covers + isFoldedProcessRow 的独立名单)。
/// 按 anchor 判定,不看行自己的 turn 号。
export function isProcessMember(node, spec) {
  if (!spec || spec.foldEndSeq == null) return false;
  if (PROCESS_INDEPENDENT_KINDS.has(node.kind)) return false;
  const anchor = anchorSeq(node);
  return anchor >= spec.processStartSeq && anchor < spec.foldEndSeq;
}

/// 在所有折叠规格里找覆盖该节点的那一个(各轮区间互不重叠,至多一个)。
export function processSpecFor(node, specs) {
  for (const spec of specs.values()) {
    if (isProcessMember(node, spec)) return spec;
  }
  return null;
}
