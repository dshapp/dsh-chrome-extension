// 会话事件归并器。对齐 macos/Sources/DSHMacKit/State/SessionStore.swift。
//
// 架构要点(与旧 runtime-store 的根本差别):事件不是 append 进一个数组,而是折进一张
// **keyed contexts 映射**,再 materialize 成按 (anchorSeq, id) 全序排序的节点列表。
// 这样才能表达 Mac 的这些语义:
//   - tool/result 迟到、乱序、甚至 callId 缺失(回退到最近未结算的调用)
//   - llm/retry 抹掉失败的 assistant step(blocks 清空 → 该行消失)
//   - turn/end 回填 turnTail 的 usage/TTFT/吞吐,并把仍在 running 的 step 标记为 interrupted
//   - 未结算的 tool call 在其 turn 关闭后冻结为 interrupted
// append-only 数组无法在不重排的前提下做到以上任何一条。

import {
  NodeKind, AssistantStatus, RetryState, WorkflowStatus,
  nodeId, anchorSeq, assistantNode, assistantVisible, toolCallNode, toolResult,
  userNode, steeringNode, contextNode, compactionNode, modelRetryNode,
  turnErrorNode, turnMaxTokensNode, commandNode, turnProcessNode, turnTailNode, workflowRunNode,
  unknownSurfaceNode, toAssistantBlock, emptyBlockFor
} from "./chat-nodes.js";
import { EVT } from "../../platform/dsh/rpc-methods.js";
import { t } from "../../shared/i18n.js";
import { expandAssistantStream } from "./assistant-stream.js";
import { mergeTurnRailItems, clipTurnPreview, TurnRailPreview } from "./turn-rail.js";
import { producedPath, presentedFiles } from "./turn-deliverables.js";
import { buildTurnProcessSpecs } from "./turn-process.js";
import { projectReferenceLabels } from "./references.js";
import { assembleTrajectory } from "../trajectory/trajectory-model.js";
import { getLang } from "../../shared/i18n.js";

/// 单个 assistant step 最多寻址的块索引。远高于真实回复的块数,远低于会造成问题的分配量。
const MAX_BLOCK_INDEX = 1024;
/// 工具调用嵌套深度上限。防御 parentCallId 成环或超长链导致的爆栈。
const MAX_NESTING_DEPTH = 16;
/// 每个 projection key 保留的版本数(重连对齐需要"不晚于基线的最新版本")。
const MAX_PROJECTION_VERSIONS = 32;
/// 事件窗口条数上限。超限时截断最旧事件并标记,由 service 从历史重载恢复完整窗口。
const MAX_WINDOW_EVENTS = 20000;

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
  return typeof value === "string" ? value : null;
}

export function createSessionStore() {
  let state = blank();

  function blank() {
    return {
      sessionId: null,
      title: "",
      cwd: null,
      blank: true,
      running: false,
      // follow 流的终态错误(如宿主 resume 失败)。非空即表示这一代会话的历史
      // 不可用,由视图层取代"正在加载对话…"。见 setHistoryError。
      historyError: null,
      currentTurn: 0,
      lastSeq: -1,
      // 按 seq 升序去重的原始事件窗口。乱序到达的事件插回它应有的位置并重折,
      // 而不是丢弃——丢弃会永久丢失这条事件承载的状态(见 applyEvent)。
      window: [],
      // 窗口曾因超限被截断(replayWindow 完整性受损),需从历史重载恢复。
      windowTruncated: false,
      // keyed contexts:key → context 记录
      contexts: new Map(),
      // "turn:step" → step/start 事件时间(TTFT 的分发边界)
      stepStartTimes: new Map(),
      // turn → turn/start seq(turn rail 的分页目标;turnTail 的 seq 会被 turn/end 覆盖,不能复用)。
      turnStartSeqs: new Map(),
      // 已排序的 turn/end 边界,供二分查找"某 seq 之后的第一个 turn 关闭点"
      turnEndBoundaries: [],
      // inbox 拼接状态:target → messageId[]
      inboxByTarget: new Map(),
      // 被 next-step 消费掉的 steering 消息 id
      claimedSteeringIds: new Set(),
      activeSteps: new Set(),
      // projections
      projections: new Map(),       // key → { value, seq }
      projectionHistory: new Map(), // key → Map(seq → value)
      // turnOutline 投影(整本日志的轮次阶梯:turn / turn/start seq / 有界预览)。
      turnOutline: [],
      todos: [],
      goal: null,
      tokenUsage: null,
      permissions: null,
      modelSelection: null,
      planMode: null,
      // 上下文压力:{ pressureTokens, projectedTokens, contextWindow }
      contextPressure: null,
      contextBreakdown: null,
      // 会话统计:{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
      sessionStats: null,
      // live 旁路(DSH 1.5)进行中的 attempt:{ attemptId, turn, step, startedAfterSeq }。
      // presentation-only,不进 durable 窗口、不参与 gap 检测与重放。
      liveAttempt: null,
      // 图片附件限制,composer 用它在本地拦截超限文件
      imageLimits: null,
      // 子代理信息(subagent 地址/父会话),决定 composer 是否只读
      subagent: null,
      agentPreset: null,
      // 交互
      queue: [],
      jobs: [],
      pendingApproval: null,
      pendingQuestion: null,
      // materialize 结果
      nodes: [],
      nodesDirty: true,
      // 轨迹台账是免观察派生:窗口变脏时按需装配,不进 snapshot() 的热路径。
      // 缓存同时记住装配时的语言 —— 切语言后文案要跟着变。
      trajectoryDirty: true,
      trajectory: null,
      trajectoryLang: null,
      // 本轮产出词表(turn → 产出路径,首见顺序去重)与 present 交付清单(turn → 声明)。
      // 两者都是免观察派生,回合尾行先于迟到的 present/落定结果渲染后会停留在空状态;
      // deliverablesRevision 在词表实际变化时递增,尾行读它即可重渲染(对齐 mac 5af61e6)。
      producedPathsByTurn: new Map(),
      presentedByTurn: new Map(),
      deliverablesRevision: 0,
      // Turn process 折叠规格(turn → spec),渲染层用它判断成员与折叠头文案。
      turnProcessByTurn: new Map(),
      // turn rail(投影 + 加载窗口锚点合并后的阶梯)。
      turnRail: []
    };
  }

  // ---- turn/end 边界索引 ----

  function recordTurnEndBoundary(seq, time) {
    const list = state.turnEndBoundaries;
    const last = list[list.length - 1];
    if (last && last.seq >= seq) {
      if (list.some((b) => b.seq === seq)) return;
      const at = list.findIndex((b) => b.seq > seq);
      list.splice(at === -1 ? list.length : at, 0, { seq, time });
      return;
    }
    list.push({ seq, time });
  }

  /// anchorSeq 之后的第一个 turn/end 边界。二分:每次 rebuild 时每个未结算调用都会问。
  function turnEndBoundaryAfter(anchor) {
    const list = state.turnEndBoundaries;
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = low + ((high - low) >> 1);
      if (list[mid].seq > anchor) high = mid; else low = mid + 1;
    }
    return low < list.length ? list[low] : null;
  }

  // ---- 事件入口 ----

  /// 二分定位 seq 应插入的位置(第一个 >= seq 的下标)。
  function partitionIndex(seq) {
    let low = 0;
    let high = state.window.length;
    while (low < high) {
      const mid = low + ((high - low) >> 1);
      if (state.window[mid].event.seq >= seq) high = mid; else low = mid + 1;
    }
    return low;
  }

  /// 这条事件是否会改变**更早**事件的投影 —— 那正是向前折叠无法表达的情况。
  ///
  /// agent/inbox/spliced 认领 steering 消息 id,会把它到达之前就已投影的用户消息重新分类;
  /// compaction 事件会遮蔽更早的面;带 surfaceOp 的事件是替换而非追加,被替换的内容必须重新推导。
  /// 其余每一条 —— chunk、message、工具调用与结果、turn/step 边界 —— 只写自己那个 contexts key。
  function requiresFullReplay(event) {
    if (event.surfaceOp != null) return true;
    switch (event.type) {
      case EVT.inboxSpliced:
      case EVT.compactionStart:
      case EVT.compactionSummary:
      case EVT.compactionEnd:
      case EVT.compactionPrune:
        return true;
      default:
        return false;
    }
  }

  /// 从零重折整个窗口。乱序到达、或到达了会改写历史投影的事件时走这条路。
  function replayWindow() {
    const saved = {
      sessionId: state.sessionId, cwd: state.cwd, queue: state.queue, jobs: state.jobs,
      pendingApproval: state.pendingApproval, pendingQuestion: state.pendingQuestion,
      projections: state.projections, projectionHistory: state.projectionHistory,
      window: state.window
    };
    const keptTitle = state.title;
    state = blank();
    Object.assign(state, saved);
    state.title = keptTitle;
    // 投影派生值要按保留下来的 projections 重新解码。
    for (const [key, entry] of state.projections) decodeProjection(key, entry.value);
    for (const { event, view } of state.window) {
      state.lastSeq = Math.max(state.lastSeq, Number.isInteger(event.seq) ? event.seq : state.lastSeq);
      route(event, view);
    }
    state.nodesDirty = true;
    state.trajectoryDirty = true;
  }

  function applyEvent(event, view) {
    if (!event || typeof event.type !== "string") return;
    const seq = Number.isInteger(event.seq) ? event.seq : state.lastSeq + 1;

    // 负 seq 是本地合成事件(如 host/agent-error),不进窗口,直接折叠。
    if (seq < 0) {
      state.nodesDirty = true;
      route(event, view);
      return;
    }

    const index = partitionIndex(seq);
    const duplicate = index < state.window.length && state.window[index].event.seq === seq;
    if (duplicate) {
      // 同 seq 重复投递:携带 view 的那份更丰富,保留它;否则原样跳过。
      const existing = state.window[index];
      if (!view || existing.view) return;
      state.window[index] = { event, view };
      replayWindow();
      return;
    }

    const extendsTail = index === state.window.length;
    state.window.splice(index, 0, { event, view });

    // 窗口超限:截断最旧事件(已折叠的 nodes 不受影响),并标记需重载 ——
    // replayWindow 依赖完整窗口,截断后重折结果不再可靠。
    if (state.window.length > MAX_WINDOW_EVENTS) {
      state.window.splice(0, state.window.length - MAX_WINDOW_EVENTS);
      state.windowTruncated = true;
    }

    // 只有能延长尾部、且不改写历史投影的事件才允许向前折叠;
    // 其余一律重折整个窗口,让结果与按序重放完全一致。
    if (!extendsTail || requiresFullReplay(event)) {
      replayWindow();
      return;
    }
    state.lastSeq = Math.max(state.lastSeq, seq);
    state.nodesDirty = true;
    state.trajectoryDirty = true;
    route(event, view);
  }

  function route(event, view) {
    switch (event.type) {
      case EVT.inboxSpliced: return applyInboxSplice(event);
      case EVT.userMessage: return applyUserMessage(event);
      case EVT.assistantChunk: return applyAssistantChunk(event);
      case EVT.assistantMessage: return applyAssistantMessage(event);
      case EVT.assistantAttempt: return applyAssistantAttempt(event);
      case EVT.toolCall: return applyToolCall(event, view);
      case EVT.toolResult: return applyToolResult(event, view);
      case EVT.codeDispatchStart:
      case EVT.ptcDispatchStart: return applySubcallStart(event);
      case EVT.codeDispatch:
      case EVT.ptcDispatch: return applySubcallEnd(event);
      case EVT.turnStart: return applyTurnStart(event);
      case EVT.turnEnd: return applyTurnEnd(event);
      case EVT.stepStart: return applyStepStart(event);
      case EVT.stepEnd: return applyStepEnd(event);
      case EVT.compactionStart:
      case EVT.compactionSummary:
      case EVT.compactionEnd:
      case EVT.compactionPrune: return applyCompaction(event);
      case EVT.llmRetry:
      case EVT.llmRetryStarted: return applyRetry(event);
      case EVT.commandRun:
      case EVT.commandDone: return applyCommand(event);
      case EVT.workflowRunStart:
      case EVT.workflowAgentStart:
      case EVT.workflowAgentEnd:
      case EVT.workflowRunEnd: return applyWorkflow(event);
      case EVT.sessionTitle: return applyTitle(event);
      // present 工具的交付清单(web ui-deliverables):它不带 surfaceOp,不产生自己的一行,
      // 只为回合尾行的交付卡与 mention 词表供数据。
      case EVT.deliverablesPresented: return applyPresented(event);
      // request/header、system/message 与 step 边界一样不产生行,但也不是"未知":
      // system/message 属于 Web 的 request/trajectory 视图,主记录里不该有行。
      case EVT.systemMessage:
      case EVT.requestHeader: return;
      default:
        // Web 的会话投影只认领对白事件:system/* 与 request/* 属于
        // request/trajectory 等旁路视图,任何变体都不该在主记录里长行。
        // 只对这两个命名空间做前缀屏蔽,别处的未知 append 事件仍保留兜底行。
        if (isNonTranscriptType(event.type)) return;
        return applyUnknownSurface(event);
    }
  }

  /// system/* 与 request/* 事件在主聊天记录里永不占位(对齐 Web 的会话投影)。
  function isNonTranscriptType(type) {
    return typeof type === "string" && (type.startsWith("system/") || type.startsWith("request/"));
  }

  /// 没有任何定义认领的 **append 面**:保留一个可见行,而不是从记录里消失。
  ///
  /// 必须以 surfaceOp=append 为门槛。没有这道门槛,像 sandbox/mode、approval/policy、
  /// permission/preset 这类纯记账事件(它们从不进入模型可见面)也会长出行来,
  /// 把记录塞满用户根本不该看到的噪音。replace 面是替换语义,同样不成行。
  function applyUnknownSurface(event) {
    if (!isAppendSurface(event)) return;
    state.contexts.set(`unknown:${event.seq}`, {
      type: "unknown",
      node: unknownSurfaceNode({ seq: event.seq, time: event.time, type: event.type, data: event.data ?? null })
    });
  }

  function isReplacementSurface(event) {
    const op = isObject(event.surfaceOp) ? event.surfaceOp.op : null;
    return op === "replace";
  }

  /// 事件是否以自己的日志位置进入了模型可见面(surfaceOp 为裸字符串 "append",
  /// 或 { op: "append" })。
  function isAppendSurface(event) {
    const surfaceOp = event.surfaceOp;
    if (surfaceOp === "append") return true;
    return isObject(surfaceOp) && surfaceOp.op === "append";
  }

  // ---- user / steering / context ----

  function applyInboxSplice(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const target = str(d.target);
    const start = num(d.start);
    if (target == null || start == null || !Array.isArray(d.inserted)) return;
    const pending = state.inboxByTarget.get(target) ?? [];
    const boundedStart = Math.min(Math.max(start, 0), pending.length);
    const requested = Math.max(num(d.removedCount) ?? 0, 0);
    const removalCount = Math.min(requested, pending.length - boundedStart);
    const removed = pending.slice(boundedStart, boundedStart + removalCount);
    const insertedIds = d.inserted.map((item) => (isObject(item) ? str(item.id) : null)).filter(Boolean);
    pending.splice(boundedStart, removalCount, ...insertedIds);
    state.inboxByTarget.set(target, pending);
    for (const id of insertedIds) state.claimedSteeringIds.delete(id);
    // next-step 队列被消费(非取消)= 这些消息以 steering 身份进入了本轮。
    if (target === "next-step" && str(d.outcome) !== "canceled") {
      for (const id of removed) state.claimedSteeringIds.add(id);
    }
  }

  function decodeMessage(data) {
    if (!isObject(data)) return null;
    const message = isObject(data.message) ? data.message : data;
    const id = str(message.id);
    if (id == null) return null;
    const source = isObject(message.source) ? message.source : null;
    return {
      id,
      content: Array.isArray(message.content) ? message.content : [],
      source,
      sourceKind: source ? str(source.kind) : null,
      sourcePlugin: source ? str(source.plugin) : null
    };
  }

  function applyUserMessage(event) {
    const msg = decodeMessage(event.data);
    if (!msg) return;
    // replace 面属于 compaction 节点,不在这里成行。
    if (isReplacementSurface(event)) return;
    // compact 插件产生的消息归 compaction 节点。
    if (msg.sourcePlugin === "compact") return;

    let kind;
    if (msg.sourceKind === "user") {
      kind = state.claimedSteeringIds.has(msg.id) ? NodeKind.steering : NodeKind.user;
    } else {
      kind = NodeKind.context;
    }

    const base = { seq: event.seq, time: event.time, messageId: msg.id, content: msg.content };
    let node;
    if (kind === NodeKind.steering) {
      node = steeringNode(base);
    } else if (kind === NodeKind.context) {
      const prov = contextProvenance(msg.source);
      node = contextNode({ ...base, source: msg.source, provenanceLabel: prov.label, provenanceRole: prov.role });
    } else {
      node = userNode(base);
    }
    state.contexts.set(`${kind}:${msg.id}`, { type: "finalized", node });
  }

  /// context 行的来源标签:插件名 / 工具名 / 泛化 "context"。
  function contextProvenance(source) {
    if (!isObject(source)) return { label: null, role: "context" };
    const plugin = str(source.plugin);
    const tool = str(source.tool);
    const kind = str(source.kind) ?? "context";
    return { label: plugin ?? tool ?? null, role: kind };
  }

  // ---- assistant 流式 ----

  function decodeChunk(data) {
    if (!isObject(data)) return null;
    const chunk = isObject(data.chunk) ? data.chunk : null;
    if (!chunk) return null;
    return {
      turn: num(data.turn) ?? 0,
      step: num(data.step) ?? 0,
      chunkType: str(chunk.type) ?? "",
      index: num(chunk.index),
      text: str(chunk.text),
      blockType: str(chunk.blockType),
      id: str(chunk.id),
      name: str(chunk.name),
      argumentsDelta: str(chunk.argumentsDelta),
      block: isObject(chunk.block) ? chunk.block : null,
      usage: isObject(chunk.usage) ? chunk.usage : (isObject(data.usage) ? data.usage : null)
    };
  }

  function assistantKey(turn, step) {
    return `assistant-step:${turn}:${step}`;
  }

  function applyAssistantChunk(event) {
    const chunk = decodeChunk(event.data);
    if (!chunk) return;
    const key = assistantKey(chunk.turn, chunk.step);
    const existing = state.contexts.get(key);
    const node = existing?.type === "assistant"
      ? existing.node
      : assistantNode({ turn: chunk.turn, step: chunk.step, startSeq: event.seq, time: event.time });
    node.time = event.time;
    if (node.stepStartTime == null) {
      node.stepStartTime = state.stepStartTimes.get(`${chunk.turn}:${chunk.step}`) ?? null;
    }
    applyStreamChunk(chunk, event.seq, node);
    state.contexts.set(key, { type: "assistant", node });
  }

  /// 已开始的块槽位。负索引会向后下标越界,单靠上界判断挡不住。
  function startedBlockSlot(index, count) {
    if (index == null || index < 0 || index >= count) return null;
    return index;
  }

  /// block-start 可以把 blocks growth 到的槽位。上限防止一个畸形 chunk 申请任意多槽位。
  function growableBlockSlot(index) {
    if (index < 0 || index > MAX_BLOCK_INDEX) return null;
    return index;
  }

  function stampFirstToken(node, text) {
    if (node.firstTokenTime == null && text) node.firstTokenTime = node.time;
  }

  function applyStreamChunk(chunk, eventSeq, node) {
    switch (chunk.chunkType) {
      case "block-start": {
        const idx = growableBlockSlot(chunk.index ?? 0);
        if (idx == null) break;
        while (node.blocks.length <= idx) node.blocks.push(null);
        node.blocks[idx] = emptyBlockFor(chunk.blockType);
        break;
      }
      case "text-delta": {
        const idx = startedBlockSlot(chunk.index, node.blocks.length);
        if (idx != null) {
          const slot = node.blocks[idx];
          if (slot?.type === "text") slot.text += chunk.text ?? "";
          else node.blocks[idx] = { type: "text", text: chunk.text ?? "" };
        }
        if (node.firstVisibleSeq == null && chunk.text) node.firstVisibleSeq = eventSeq;
        stampFirstToken(node, chunk.text);
        break;
      }
      case "reasoning-delta": {
        const idx = startedBlockSlot(chunk.index, node.blocks.length);
        if (idx != null) {
          const slot = node.blocks[idx];
          if (slot?.type === "reasoning") slot.text += chunk.text ?? "";
          else node.blocks[idx] = { type: "reasoning", text: chunk.text ?? "" };
        }
        stampFirstToken(node, chunk.text);
        break;
      }
      case "tool-call-delta": {
        const idx = startedBlockSlot(chunk.index, node.blocks.length);
        if (idx != null) {
          const slot = node.blocks[idx];
          if (slot?.type === "tool-call") {
            slot.argsRaw += chunk.argumentsDelta ?? "";
            if (chunk.name) slot.name = chunk.name;
          } else {
            node.blocks[idx] = {
              type: "tool-call", callId: chunk.id ?? "", name: chunk.name ?? "",
              argsRaw: chunk.argumentsDelta ?? ""
            };
          }
        }
        stampFirstToken(node, chunk.argumentsDelta);
        break;
      }
      case "block-end": {
        const idx = startedBlockSlot(chunk.index, node.blocks.length);
        if (idx != null && chunk.block) node.blocks[idx] = toAssistantBlock(chunk.block);
        break;
      }
      case "usage":
        if (chunk.usage) node.usage = chunk.usage;
        break;
      default:
        break;
    }
  }

  function applyAssistantMessage(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const message = isObject(d.message) ? d.message : null;
    if (!message) return;
    const turn = num(d.turn) ?? 0;
    const step = num(d.step) ?? 0;
    const key = assistantKey(turn, step);
    const existing = state.contexts.get(key);
    const node = existing?.type === "assistant"
      ? existing.node
      : assistantNode({ turn, step, startSeq: event.seq, time: event.time });
    if (node.stepStartTime == null) {
      node.stepStartTime = state.stepStartTimes.get(`${turn}:${step}`) ?? null;
    }
    // 结算时间推进到 assistant/message 的事件时间。turnTail 的解码墙钟按
    // (完成时间 − 首 token 时间) 计算,而"完成时间"对已结算的 step 定义为本事件的时间;
    // 不推进就会拿最后一个 chunk 的时间当完成时间,把解码窗口算短(常常算成 0)。
    node.time = event.time;
    const interrupted = Boolean(d.interrupted ?? message.interrupted);
    // 被取消而定稿的 step 结算为 interrupted:记录完整,但它是个前缀,
    // 所以该行保留"已停止"的观感,而不是读作一个完成的回答。
    node.status = interrupted ? AssistantStatus.interrupted : AssistantStatus.settled;
    node.interrupted = interrupted;
    node.blocks = (Array.isArray(message.content) ? message.content : []).map(toAssistantBlock);
    node.messageId = str(message.id);
    node.provider = str(d.provider ?? message.provider);
    node.model = str(d.model ?? message.model);
    const usage = isObject(d.usage) ? d.usage : (isObject(message.usage) ? message.usage : null);
    if (usage) node.usage = usage;
    state.contexts.set(key, { type: "assistant", node });
  }

  // ---- DSH 1.5 live 旁路与 attempt 结算 ----

  /// 折叠一条 live 旁路 token(进程内 assistant side channel)。
  ///
  /// 帧不携带会话 seq(presentation-only),归属 attempt 的 turn/step 在 start 帧
  /// 捕获,startedAfterSeq 是 attempt 开始时 durable cursor 的位置。最终的
  /// assistant/message 会覆写这里画出的内容,所以丢帧/畸形帧至多留下陈旧残片。
  function applyAssistantLiveChunk(turn, step, startedAfterSeq, time, rawChunk) {
    const chunk = decodeChunk({ turn, step, chunk: rawChunk });
    if (!chunk) return;
    const key = assistantKey(turn, step);
    const existing = state.contexts.get(key);
    const node = existing?.type === "assistant"
      ? existing.node
      : assistantNode({ turn, step, startSeq: startedAfterSeq, time });
    node.time = time;
    if (node.stepStartTime == null) {
      node.stepStartTime = state.stepStartTimes.get(`${turn}:${step}`) ?? null;
    }
    applyStreamChunk(chunk, startedAfterSeq, node);
    state.contexts.set(key, { type: "assistant", node });
  }

  /// 把一条 attempt 的紧凑 stream 重放进它所属的 step。
  ///
  /// 用于重连 baseline(离开期间到达的 token)与 assistant/attempt 结算
  /// (失败/取消的 attempt 唯一留下的 durable 记录)。
  function applyAssistantStreamRecords(turn, step, startSeq, stream) {
    const chunks = expandAssistantStream(stream);
    if (!chunks.length) return;
    for (const { time, chunk } of chunks) {
      applyAssistantLiveChunk(turn, step, startSeq, time, chunk);
    }
  }

  /// 结算一条没有提交任何可见消息的 attempt(DSH 1.5 新增)。
  ///
  /// assistant/attempt 保留失败、重试、取消或流错误掉的 attempt,而不伪造
  /// 模型可见的历史。该 step 保留旁路画过的内容并停止 running。
  function applyAssistantAttempt(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const turn = num(d.turn) ?? 0;
    const step = num(d.step) ?? 0;
    const key = assistantKey(turn, step);
    let node;
    const existing = state.contexts.get(key);
    if (existing?.type === "assistant") {
      node = existing.node;
    } else {
      node = assistantNode({ turn, step, startSeq: event.seq, time: event.time });
      state.contexts.set(key, { type: "assistant", node });
      // 冷历史/离屏期间结算:没有 live 帧画过这一步,从内嵌 stream 恢复。
      applyAssistantStreamRecords(turn, step, event.seq, d.stream);
      const rebuilt = state.contexts.get(key);
      if (rebuilt?.type === "assistant") node = rebuilt.node;
    }
    if (node.stepStartTime == null) {
      node.stepStartTime = state.stepStartTimes.get(`${turn}:${step}`) ?? null;
    }
    node.time = event.time;
    node.status = AssistantStatus.interrupted;
    node.interrupted = true;
    state.contexts.set(key, { type: "assistant", node });
  }

  /// 应用一条 live 旁路帧(start/chunk/end)。
  function applyAssistantStreamFrame(frame) {
    if (!frame || typeof frame.type !== "string" || typeof frame.attemptId !== "string") return;
    switch (frame.type) {
      case "start": {
        state.liveAttempt = {
          attemptId: frame.attemptId,
          turn: num(frame.turn) ?? 0,
          step: num(frame.step) ?? 0,
          startedAfterSeq: num(frame.startedAfterSeq) ?? 0
        };
        break;
      }
      case "chunk": {
        // 从未见过 start(帧缺口,或 follow 在 attempt 中段打开而没有 baseline)
        // 时没有 step 可寻址,durable settlement 会补上内容。
        const attempt = state.liveAttempt;
        if (!attempt || attempt.attemptId !== frame.attemptId) return;
        applyAssistantLiveChunk(attempt.turn, attempt.step, attempt.startedAfterSeq,
          num(frame.time) ?? 0, frame.chunk);
        state.nodesDirty = true;
        break;
      }
      case "end": {
        if (state.liveAttempt?.attemptId === frame.attemptId) state.liveAttempt = null;
        break;
      }
      default:
        break;
    }
  }

  /// 重连快照时从 baseline 恢复被打断的 attempt。
  function applyAssistantStreamBaseline(baseline) {
    const attempt = baseline?.activeAttempt;
    if (!attempt) {
      state.liveAttempt = null;
      return;
    }
    const turn = num(attempt.turn) ?? 0;
    const step = num(attempt.step) ?? 0;
    const startedAfterSeq = num(attempt.startedAfterSeq) ?? 0;
    state.liveAttempt = { attemptId: attempt.attemptId, turn, step, startedAfterSeq };
    applyAssistantStreamRecords(turn, step, startedAfterSeq, attempt.stream);
    state.nodesDirty = true;
  }

  // ---- 工具调用 ----

  function toolKey(callId) {
    return `tool-call:${callId}`;
  }

  function applyToolCall(event, view) {
    const d = event.data;
    if (!isObject(d)) return;
    const rawId = str(d.callId) ?? "";
    const callId = rawId === "" ? `seq-${event.seq}` : rawId;
    const callView = view?.for === "call" ? view.view : null;
    state.contexts.set(toolKey(callId), {
      type: "toolCall",
      node: toolCallNode({
        callId,
        name: str(d.name) ?? "",
        argsRaw: str(d.arguments) ?? "",
        turn: num(d.turn) ?? state.currentTurn,
        step: num(d.step) ?? 0,
        startSeq: event.seq,
        time: event.time,
        callView
      })
    });
  }

  function applyToolResult(event, view) {
    const d = event.data;
    if (!isObject(d)) return;
    // tool/result 的载荷可能把块包在 message.content 里(旧形状),也可能直接给 content。
    let content = Array.isArray(d.content) ? d.content : null;
    let isError = d.isError;
    let callId = str(d.callId) ?? "";
    if (content == null && isObject(d.message) && Array.isArray(d.message.content)) {
      const block = d.message.content.find((b) => isObject(b) && b.type === "tool-result");
      if (block) {
        content = Array.isArray(block.content) ? block.content : [];
        isError = block.isError;
        if (callId === "") callId = str(block.toolCallId) ?? "";
      }
    }
    const result = toolResult({
      seq: event.seq,
      time: event.time,
      content: content ?? [],
      isError,
      error: isObject(d.error) ? d.error : null,
      meta: isObject(d.meta) ? d.meta : null,
      resultView: view?.for === "result" ? view.view : null
    });

    // callId 缺失:回退到 startSeq 最大的未结算调用。
    let key = null;
    if (callId === "") {
      let best = null;
      for (const [k, ctx] of state.contexts) {
        if (ctx.type !== "toolCall" || ctx.node.result != null) continue;
        if (best == null || ctx.node.startSeq > best.seq) best = { key: k, seq: ctx.node.startSeq };
      }
      key = best?.key ?? null;
    } else {
      key = toolKey(callId);
    }

    const ctx = key ? state.contexts.get(key) : null;
    if (ctx?.type === "toolCall") {
      ctx.node.result = result;
      if (view?.for === "call") ctx.node.callView = view.view;
      return;
    }
    // 孤儿结果:没有对应调用,仍然保留一行,不静默丢弃。
    const orphanId = callId === "" ? `orphan-${event.seq}` : callId;
    const orphan = toolCallNode({
      callId: orphanId, name: "orphan-result", argsRaw: "",
      turn: num(d.turn) ?? state.currentTurn, step: num(d.step) ?? 0,
      startSeq: event.seq, time: event.time,
      callView: view?.for === "call" ? view.view : null
    });
    orphan.result = result;
    state.contexts.set(toolKey(orphanId), { type: "toolCall", node: orphan });
  }

  // ---- 工具子调用(run_code 的 code-dispatch 嵌套) ----

  function decodeDispatch(data) {
    if (!isObject(data)) return null;
    const subCallId = str(data.subCallId);
    if (subCallId == null) return null;
    return {
      subCallId,
      rootCallId: str(data.rootCallId),
      parentCallId: str(data.parentCallId),
      name: str(data.name) ?? "",
      args: data.arguments,
      content: Array.isArray(data.content) ? data.content : [],
      isError: Boolean(data.isError)
    };
  }

  function jsonString(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return ""; }
  }

  function toolNodeById(callId) {
    const ctx = callId ? state.contexts.get(toolKey(callId)) : null;
    return ctx?.type === "toolCall" ? ctx.node : null;
  }

  function applySubcallStart(event) {
    const d = decodeDispatch(event.data);
    if (!d) return;
    const root = toolNodeById(d.rootCallId);
    state.contexts.set(toolKey(d.subCallId), {
      type: "toolCall",
      node: toolCallNode({
        callId: d.subCallId, name: d.name, argsRaw: jsonString(d.args),
        turn: root?.turn ?? state.currentTurn,
        step: root?.step ?? Math.max(0, ...state.activeSteps),
        startSeq: event.seq, time: event.time,
        rootCallId: d.rootCallId, parentCallId: d.parentCallId
      })
    });
  }

  function applySubcallEnd(event) {
    const d = decodeDispatch(event.data);
    if (!d) return;
    const key = toolKey(d.subCallId);
    let node = toolNodeById(d.subCallId);
    if (!node) {
      const root = toolNodeById(d.rootCallId);
      node = toolCallNode({
        callId: d.subCallId, name: d.name, argsRaw: jsonString(d.args),
        turn: root?.turn ?? state.currentTurn,
        step: root?.step ?? Math.max(0, ...state.activeSteps),
        startSeq: event.seq, time: event.time,
        rootCallId: d.rootCallId, parentCallId: d.parentCallId
      });
    }
    node.result = toolResult({
      seq: event.seq, time: event.time, content: d.content, isError: d.isError
    });
    state.contexts.set(key, { type: "toolCall", node });
  }

  // ---- turn / step 边界 ----

  function applyTurnStart(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const turn = num(d.turn);
    if (turn == null) return;
    state.currentTurn = turn;
    state.turnStartSeqs.set(turn, event.seq);
    state.running = true;
    const errKey = `turn-error:${turn}`;
    if (!state.contexts.has(errKey)) {
      state.contexts.set(errKey, {
        type: "turnErrorPending",
        pending: { turn, startSeq: event.seq, time: event.time, seq: null, message: null, code: null }
      });
    }
    const tailKey = `turn-tail:${turn}`;
    if (!state.contexts.has(tailKey)) {
      state.contexts.set(tailKey, { type: "turnTail", node: turnTailNode({ turn, seq: event.seq, time: event.time }) });
    }
  }

  function applyStepStart(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const step = num(d.step);
    if (step == null) return;
    state.activeSteps.add(step);
    if (state.currentTurn === 0) return;
    // 记录该 step 的分发边界(TTFT 起点)。assistant context 在首个 chunk 才创建,
    // 所以起点在那里回读;若 context 已存在(乱序/重放)则直接盖上。
    state.stepStartTimes.set(`${state.currentTurn}:${step}`, event.time);
    const ctx = state.contexts.get(assistantKey(state.currentTurn, step));
    if (ctx?.type === "assistant") ctx.node.stepStartTime = event.time;
  }

  function applyStepEnd(event) {
    const step = isObject(event.data) ? num(event.data.step) : null;
    if (step != null) state.activeSteps.delete(step);
  }

  function applyTurnEnd(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const turn = num(d.turn);
    if (turn == null) return;
    state.activeSteps.clear();
    recordTurnEndBoundary(event.seq, event.time);

    const reason = isObject(d.reason) ? d.reason : null;
    const kind = reason ? str(reason.kind) : null;
    const errKey = `turn-error:${turn}`;

    if (kind === "error") {
      const failure = reason && isObject(reason.error) ? reason.error : null;
      const ctx = state.contexts.get(errKey);
      if (ctx?.type === "turnErrorPending") {
        ctx.pending.message = turnFailureMessage(reason);
        ctx.pending.code = failure ? str(failure.code) : null;
        ctx.pending.seq = event.seq;
      }
    } else if (kind === "max-tokens") {
      state.contexts.set(`turn-max-tokens:${turn}`, {
        type: "turnMaxTokens",
        node: turnMaxTokensNode({ seq: event.seq, time: event.time, turn, step: null })
      });
      state.contexts.delete(errKey);
    } else {
      state.contexts.delete(errKey);
    }

    // turnTail 指标回填。
    const tailCtx = state.contexts.get(`turn-tail:${turn}`);
    if (tailCtx?.type === "turnTail") {
      const tail = tailCtx.node;
      tail.seq = event.seq;
      if (kind === "completed") {
        foldTurnMetrics(tail, turn, event.time);
      }
    }

    state.running = false;
    if (state.currentTurn === turn) state.currentTurn = 0;
    // 本轮仍在 running 的 assistant step 全部标记为 interrupted。
    for (const ctx of state.contexts.values()) {
      if (ctx.type === "assistant" && ctx.node.turn === turn && ctx.node.status === AssistantStatus.running) {
        ctx.node.status = AssistantStatus.interrupted;
        ctx.node.interrupted = true;
      }
    }
  }

  /// 每轮 TTFT / 吞吐折叠:TTFT 取最小 step 的 (首 token − step 起点);
  /// 吞吐把各 step 的输出 token 之和除以解码墙钟之和(只采样同时具备首 token 与产出的 step)。
  function foldTurnMetrics(tail, turn, endTime) {
    let lastAssistant = null;
    let firstStep = null;
    let firstStepTtftMs = null;
    let decodeMs = 0;
    let outputTokens = 0;
    let sampled = false;

    for (const ctx of state.contexts.values()) {
      if (ctx.type !== "assistant" || ctx.node.turn !== turn) continue;
      const s = ctx.node;
      if (lastAssistant == null || s.step > lastAssistant.step) lastAssistant = s;
      if (s.usage) tail.usage = s.usage;

      const ttftMs = (s.stepStartTime != null && s.firstTokenTime != null)
        ? Math.max(0, s.firstTokenTime - s.stepStartTime) : null;
      const stepDecodeMs = s.firstTokenTime != null ? Math.max(0, s.time - s.firstTokenTime) : null;
      const out = s.usage?.outputTokens ?? 0;

      if (firstStep == null || s.step < firstStep) {
        firstStep = s.step;
        firstStepTtftMs = ttftMs;
      }
      if (stepDecodeMs != null && out > 0) {
        decodeMs += stepDecodeMs;
        outputTokens += out;
        sampled = true;
      }
    }

    tail.ttftMs = firstStepTtftMs;
    tail.decodeTokensPerSec = (sampled && decodeMs > 0) ? outputTokens / (decodeMs / 1000) : null;
    if (lastAssistant) {
      tail.messageId = lastAssistant.messageId;
      tail.closingText = (lastAssistant.blocks ?? [])
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("");
      tail.runMs = Math.max(0, endTime - tail.time);
    }
  }

  /// turn/end error 的人读文案:优先结构化 message,回退到 code。
  function turnFailureMessage(reason) {
    const failure = reason && isObject(reason.error) ? reason.error : null;
    if (!failure) return t("failure.modelError");
    return failureText(failure.message, str(failure.code));
  }

  /// AUTH 失败可能携带凭据/服务端诊断,统一换成通用文案
  /// (web `displayFailure` / mac `TurnFailureMessage`:AUTH 一律脱敏)。
  function failureText(message, code) {
    if (code === "AUTH") return t("failure.auth");
    return str(message) || str(code) || t("failure.modelError");
  }

  // ---- compaction ----

  function applyCompaction(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const compactionId = str(d.compactionId);
    if (compactionId == null) return;
    const key = `compaction:${compactionId}`;
    const existing = state.contexts.get(key);
    const node = existing?.type === "compaction"
      ? existing.node
      : compactionNode({ compactionId, seq: event.seq, time: event.time });
    if (event.type === EVT.compactionSummary) {
      if (Array.isArray(d.summary)) {
        const first = d.summary.find((b) => isObject(b) && b.type === "text");
        if (first) node.summary = str(first.text);
      }
      node.summaryEventSeq = event.seq;
      node.shadowedTokenCount = num(d.shadowedTokenCount);
      node.shadowedItemCount = num(d.shadowedItemCount);
    }
    state.contexts.set(key, { type: "compaction", node });
  }

  // ---- llm 重试 ----

  function applyRetry(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const retryId = str(d.retryId);
    if (retryId == null) return;
    const key = `model-retry:${retryId}`;
    const existing = state.contexts.get(key);
    const node = existing?.type === "modelRetry"
      ? existing.node
      : modelRetryNode({ retryId, seq: event.seq, time: event.time });

    if (event.type === EVT.llmRetry) {
      node.retry = num(d.retry) ?? node.retry;
      node.maxRetries = num(d.maxRetries);
      node.delayMs = num(d.delayMs);
      const failure = isObject(d.failure) ? d.failure : null;
      node.failureCode = failure ? str(failure.code) : null;
      node.failureMessage = failure ? failureText(failure.message, node.failureCode) : null;
      node.provider = str(d.provider);
      node.retryState = RetryState.scheduled;
    } else if (event.type === EVT.llmRetryStarted) {
      node.retryState = RetryState.started;
    }
    state.contexts.set(key, { type: "modelRetry", node });

    // 重试隐藏该轮的 turn-error 节点。
    const turn = num(d.turn);
    if (turn != null) state.contexts.delete(`turn-error:${turn}`);

    // 失败的那次流式尝试从记录中移除:blocks 清空 → 该行消失,直到重试产出新内容。
    // firstTokenTime 保留,让重试后的读数仍持有首次尝试的分发→首 token 证据。
    if (event.type === EVT.llmRetry && turn != null) {
      const step = num(d.step);
      if (step != null) {
        const ctx = state.contexts.get(assistantKey(turn, step));
        if (ctx?.type === "assistant") {
          ctx.node.blocks = [];
          ctx.node.status = AssistantStatus.running;
          ctx.node.firstVisibleSeq = null;
          ctx.node.messageId = null;
          ctx.node.usage = null;
        }
      }
    }
  }

  // ---- 宿主命令 ----

  function applyCommand(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const commandId = str(d.commandId);
    if (commandId == null) return;
    const key = `command:${commandId}`;
    const existing = state.contexts.get(key);
    const node = existing?.type === "command"
      ? existing.node
      : commandNode({ commandId, seq: event.seq, time: event.time });
    if (event.type === EVT.commandRun) {
      node.name = str(d.name);
      node.args = str(d.args);
    } else if (event.type === EVT.commandDone) {
      node.outcome = {
        kind: str(d.kind) ?? "success",
        text: str(d.text),
        sourceEventSeq: num(d.sourceEventSeq)
      };
    }
    state.contexts.set(key, { type: "command", node });
  }

  // ---- workflow ----

  function applyWorkflow(event) {
    const d = event.data;
    if (!isObject(d)) return;
    const runId = str(d.runId);
    if (runId == null) return;
    const key = `workflow-run:${runId}`;
    const existing = state.contexts.get(key);
    let run;
    if (existing?.type === "workflowRun") {
      run = existing.run;
    } else if (event.type === EVT.workflowRunStart) {
      run = { runId, name: str(d.name) ?? "workflow", anchorSeq: event.seq, members: [], stopReason: null };
    } else {
      // run-start 落在已加载窗口之外:无法重建身份,丢弃而不是瞎猜名字。
      return;
    }

    switch (event.type) {
      case EVT.workflowAgentStart: {
        const seq = num(d.seq);
        const label = str(d.label);
        const childId = str(d.childId);
        if (seq == null || label == null || childId == null) return;
        run.members.push({ seq, label, phase: str(d.phase), childId, outcome: null });
        break;
      }
      case EVT.workflowAgentEnd: {
        const seq = num(d.seq);
        const outcome = str(d.outcome);
        if (seq == null || outcome == null) return;
        for (const m of run.members) if (m.seq === seq) m.outcome = outcome;
        break;
      }
      case EVT.workflowRunEnd:
        run.stopReason = str(d.stopReason);
        break;
      default:
        break;
    }
    state.contexts.set(key, { type: "workflowRun", run });
  }

  function workflowStatusFromOutcome(outcome) {
    switch (outcome) {
      case "completed": case "ok": case "success": return WorkflowStatus.completed;
      case "failed": case "error": return WorkflowStatus.failed;
      case "cancelled": case "canceled": return WorkflowStatus.cancelled;
      case "interrupted": return WorkflowStatus.interrupted;
      default: return WorkflowStatus.completed;
    }
  }

  function workflowStatusFromStopReason(stopReason) {
    switch (stopReason) {
      case "completed": return WorkflowStatus.completed;
      case "failed": case "error": return WorkflowStatus.failed;
      case "cancelled": case "canceled": return WorkflowStatus.cancelled;
      case "interrupted": return WorkflowStatus.interrupted;
      default: return WorkflowStatus.completed;
    }
  }

  function projectWorkflow(run) {
    // 未收到 run-end 但其 turn 已关闭 = 被打断。
    const interrupted = run.stopReason == null && turnEndBoundaryAfter(run.anchorSeq) != null;
    const order = [];
    const groups = new Map();
    for (const member of run.members) {
      const phaseKey = member.phase == null ? "\u0000none" : `p:${member.phase}`;
      if (!groups.has(phaseKey)) {
        groups.set(phaseKey, { phase: member.phase ?? null, members: [] });
        order.push(phaseKey);
      }
      groups.get(phaseKey).members.push({
        seq: member.seq,
        label: member.label,
        childId: member.childId,
        status: member.outcome != null
          ? workflowStatusFromOutcome(member.outcome)
          : (interrupted ? WorkflowStatus.interrupted : WorkflowStatus.running)
      });
    }
    const status = run.stopReason != null
      ? workflowStatusFromStopReason(run.stopReason)
      : (interrupted ? WorkflowStatus.interrupted : WorkflowStatus.running);
    return workflowRunNode({
      runId: run.runId,
      name: run.name,
      status,
      phases: order.map((k) => ({ key: k, phase: groups.get(k).phase, members: groups.get(k).members })),
      anchorSeq: run.anchorSeq
    });
  }

  // ---- 标题 ----

  function applyTitle(event) {
    const title = isObject(event.data) ? str(event.data.title) : null;
    if (title) state.title = title;
  }

  /// 折叠 `deliverables/presented`:同路径的重复声明覆盖旧声明(以 durable seq/index 定位),
  /// 新路径追加。交付清单变化即递增 revision,供回合尾行重渲染。
  function applyPresented(event) {
    const parsed = presentedFiles(event.seq, event.data);
    if (!parsed) return;
    const files = state.presentedByTurn.get(parsed.turn) ?? [];
    for (const file of parsed.files) {
      const at = files.findIndex((existing) => existing.path === file.path);
      if (at >= 0) files[at] = file; else files.push(file);
    }
    state.presentedByTurn.set(parsed.turn, files);
    state.deliverablesRevision += 1;
  }

  // ---- projections ----

  function applyProjection(key, value, seq) {
    const at = Number.isInteger(seq) ? seq : state.lastSeq;
    let versions = state.projectionHistory.get(key);
    if (!versions) { versions = new Map(); state.projectionHistory.set(key, versions); }
    versions.set(at, value);
    if (versions.size > MAX_PROJECTION_VERSIONS) {
      const retained = [...versions.keys()].sort((a, b) => a - b).slice(-MAX_PROJECTION_VERSIONS);
      const keep = new Set(retained);
      for (const k of [...versions.keys()]) if (!keep.has(k)) versions.delete(k);
    }
    const existing = state.projections.get(key);
    // 同序按后到者胜。宿主不带 seq 时 at 恒等于当前 lastSeq(投影不推进 lastSeq),
    // 严格 `>` 会把每一条正常的后续更新都误判成陈旧帧,投影永远冻在第一版。
    // 真正的乱序帧 seq 严格更小,仍然被挡住。
    if (!existing || at >= existing.seq) {
      state.projections.set(key, { value, seq: at });
      decodeProjection(key, value);
    }
  }

  function decodeProjection(key, value) {
    switch (key) {
      case "title":
        if (typeof value === "string" && value) state.title = value;
        break;
      case "sessionListMetadata":
        if (isObject(value)) state.blank = value.blank ?? state.blank;
        break;
      case "todos":
        state.todos = Array.isArray(value)
          ? value.filter(isObject).map((item) => ({
              id: str(item.id) ?? "",
              content: str(item.content) ?? "",
              status: str(item.status) ?? "pending",
              priority: str(item.priority)
            }))
          : [];
        break;
      case "goal":
        if (value === null) {
          state.goal = null;
        } else if (isObject(value) && "goal" in value) {
          const g = value.goal;
          state.goal = isObject(g) ? {
            id: str(g.id) ?? "",
            revision: num(g.revision) ?? 0,
            objective: str(g.objective) ?? "",
            phase: str(g.phase) ?? "active",
            maxGoalRounds: num(g.maxGoalRounds),
            blockedMessage: isObject(g.blockedReason) ? str(g.blockedReason.message) : null
          } : null;
        }
        break;
      case "tokenUsage":
        state.tokenUsage = isObject(value) ? value : null;
        break;
      case "permissions":
        state.permissions = isObject(value) ? value : null;
        break;
      case "modelSelection":
        state.modelSelection = isObject(value) ? value : null;
        break;
      case "contextPressure":
        state.contextPressure = isObject(value) ? value : null;
        break;
      // 上下文构成(system/tools/messages 的启发式估算),喂详情浮层的分段条与图例。
      case "contextBreakdown":
        state.contextBreakdown = isObject(value) ? value : null;
        break;
      case "sessionStats":
        state.sessionStats = isObject(value) ? value : null;
        break;
      case "imageLimits":
        state.imageLimits = isObject(value) ? value : null;
        break;
      // 整本日志的轮次阶梯(见 turn-rail.js)。投影 value 是 entry 数组(wire view)。
      case "turnOutline":
        state.turnOutline = Array.isArray(value) ? value : [];
        break;
      case "subagent":
        state.subagent = isObject(value) ? value : null;
        break;
      case "plan":
        // 折算目标态:pending 时取反(乐观显示切换中的方向)。
        state.planMode = isObject(value)
          ? (value.pending ? !value.active : Boolean(value.active))
          : null;
        break;
      default:
        break;
    }
  }

  // ---- materialize ----

  /// 比较两个 "turn → [path]" 映射是否逐值相等(用于判定 deliverablesRevision 是否递增)。
  function sameProducedMaps(a, b) {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    for (const [turn, paths] of a) {
      const other = b.get(turn);
      if (!other || paths.length !== other.length) return false;
      for (let i = 0; i < paths.length; i += 1) if (paths[i] !== other[i]) return false;
    }
    return true;
  }

  function rebuildNodes() {
    const built = [];
    const tools = new Map();

    for (const ctx of state.contexts.values()) {
      switch (ctx.type) {
        case "finalized":
        case "unknown":
          built.push(ctx.node);
          break;
        case "assistant":
          if (assistantVisible(ctx.node)) built.push(ctx.node);
          break;
        case "toolCall": {
          const node = ctx.node;
          // 未结算但其 turn 已关闭的调用冻结为 interrupted:该行停在关闭边界上,
          // 带一个合成的 Interrupted 错误结果,而不是永远转圈。
          if (node.result == null) {
            const boundary = turnEndBoundaryAfter(node.startSeq);
            if (boundary) {
              node.result = toolResult({
                seq: boundary.seq, time: boundary.time, content: [], isError: true,
                error: { name: "Interrupted", code: "interrupted" }
              });
            }
          }
          tools.set(node.callId, node);
          break;
        }
        case "compaction":
        case "modelRetry":
        case "turnMaxTokens":
        case "command":
        case "turnTail":
          built.push(ctx.node);
          break;
        case "turnErrorPending":
          if (ctx.pending.message != null) {
            built.push(turnErrorNode({
              seq: ctx.pending.seq ?? ctx.pending.startSeq,
              time: ctx.pending.time,
              turn: ctx.pending.turn,
              step: null,
              message: ctx.pending.message,
              code: ctx.pending.code
            }));
          }
          break;
        case "workflowRun":
          built.push(projectWorkflow(ctx.run));
          break;
        default:
          break;
      }
    }

    // 一趟按 parent 建索引,而不是为每个节点重扫全部工具调用(那是 O(n²))。
    const childrenByParent = new Map();
    for (const tool of tools.values()) {
      const parent = tool.parentCallId;
      if (!parent || !tools.has(parent)) continue;
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(tool);
    }
    for (const list of childrenByParent.values()) list.sort((a, b) => a.startSeq - b.startSeq);

    // visited 拒绝重入 parentCallId 环;depth 另外限制超长无环链。
    function nested(tool, visited, depth) {
      const children = childrenByParent.get(tool.callId);
      if (!children || visited.has(tool.callId) || depth >= MAX_NESTING_DEPTH) return tool;
      const seen = new Set(visited);
      seen.add(tool.callId);
      tool.subCalls = children.map((child) => nested(child, seen, depth + 1));
      return tool;
    }
    for (const tool of tools.values()) {
      if (tool.parentCallId == null || !tools.has(tool.parentCallId)) {
        built.push(nested(tool, new Set(), 0));
      }
    }

    // contexts 是 Map,迭代序不保证语义稳定。只按 anchorSeq 排序会让同锚点的行
    // 在每次 rebuild 间自由排列,churn 掉渲染层的身份复用。id 做 tiebreaker,
    // 使顺序成为状态的全函数。
    const keyed = built.map((node) => ({ anchor: anchorSeq(node), id: nodeId(node), node }));
    keyed.sort((a, b) => (a.anchor - b.anchor) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    state.nodes = keyed.map((k) => k.node);
    // 收尾 assistant:每轮最后一个已结算、带 messageId 的可见 assistant step。
    // 只有它能拿到本轮产出词表、渲染行内 mention(web/Mac 的 closing assistant);
    // 更早的 step 与仍在流式的尾部都不获得。
    const closingByTurn = new Map();
    for (const node of state.nodes) {
      if (node.kind === NodeKind.assistant && node.status !== AssistantStatus.running && node.messageId) {
        closingByTurn.set(node.turn, node);
      }
    }
    for (const node of state.nodes) {
      if (node.kind === NodeKind.assistant) node.closing = closingByTurn.get(node.turn) === node;
    }
    // 本轮产出词表:从 settled 非 error 的变更调用解析参数。词表实际变化时递增 revision,
    // 供回合尾行与 mention 词表重渲染(对齐 mac indexRows)。
    // 递归进 subCalls:本机 DSH 走 PTC(run_code)时 write/edit 都是 root 程序下的
    // tool/ptc-dispatch 子调用,只看 root 会让所有产出文件都消失。
    const producedBefore = state.producedPathsByTurn;
    const nextProduced = new Map();
    const collectProduced = (node) => {
      if (node.result && !node.result.isError) {
        const path = producedPath(node.name, node.argsRaw ?? "");
        if (path) {
          const turn = num(node.turn) ?? 0;
          let list = nextProduced.get(turn);
          if (!list) { list = []; nextProduced.set(turn, list); }
          if (!list.includes(path)) list.push(path);
        }
      }
      for (const child of node.subCalls ?? []) collectProduced(child);
    };
    for (const node of state.nodes) {
      if (node.kind !== NodeKind.toolCall) continue;
      collectProduced(node);
    }
    if (!sameProducedMaps(producedBefore, nextProduced)) {
      state.producedPathsByTurn = nextProduced;
      state.deliverablesRevision += 1;
    }

    // Turn process 折叠头:该轮出现最终回答后,把过程行收进一个折叠头。
    // 折叠头自身 anchor 比首个成员小 0.1(web processControl 偏移),排在成员之前。
    const processSpecs = buildTurnProcessSpecs(state.nodes, state.turnStartSeqs);
    state.turnProcessByTurn = new Map();
    if (processSpecs.size) {
      for (const [turn, spec] of processSpecs) state.turnProcessByTurn.set(turn, spec);
      const withProcess = [...state.nodes, ...[...processSpecs.values()].map((spec) => turnProcessNode(spec))];
      withProcess.sort((a, b) => {
        const delta = anchorSeq(a) - anchorSeq(b);
        if (delta) return delta;
        const idA = nodeId(a);
        const idB = nodeId(b);
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      });
      state.nodes = withProcess;
    }
    // 引用标签:recall 上下文回贴到紧随其前的用户/steering 消息。
    projectReferenceLabels(state.nodes);
    state.nodesDirty = false;
    // 派生缓存:流式期间每帧都要读尾节点与运行中的工具,这里一次性算好,
    // 渲染层就不用每帧复制整个 nodes 数组反向扫描(那是 O(n) 且带分配)。
    state.lastNode = state.nodes[state.nodes.length - 1] ?? null;
    let runningTool = null;
    for (let i = state.nodes.length - 1; i >= 0; i -= 1) {
      const node = state.nodes[i];
      if (node.kind === NodeKind.toolCall && node.result == null) { runningTool = node; break; }
    }
    state.runningTool = runningTool;
    rebuildTurnRail();
  }

  // ---- turn rail ----

  /// 文本块(不占主对话批次的行不参与:turnTail/turnMaxTokens/compaction…)。
  function isTurnAnchorCandidate(node) {
    switch (node.kind) {
      case NodeKind.user:
      case NodeKind.assistant:
      case NodeKind.toolCall:
      case NodeKind.turnError:
      case NodeKind.command:
      case NodeKind.context:
        return true;
      default:
        return false;
    }
  }

  function userTextParts(node) {
    return (node.content ?? [])
      .filter((part) => part && part.type === "text")
      .map((part) => part.text ?? "");
  }

  function assistantTextParts(node) {
    return (node.blocks ?? [])
      .filter((block) => block && block.type === "text")
      .map((block) => block.text ?? "");
  }

  /// 重新合并整本 turnOutline 投影与加载窗口的锚点/预览。
  /// 锚点:每个 turn 区间(turn/start seq → 下一 turn/start seq)内第一个对话行。
  /// 预览:第一个真人 prompt 与最后一个带文本的 assistant 回复(对齐投影的 newest-wins)。
  function rebuildTurnRail() {
    const startSeqs = state.turnStartSeqs;
    const turns = [...startSeqs.keys()].sort((a, b) => a - b);
    const intervals = turns.map((turn, i) => ({
      turn,
      start: startSeqs.get(turn),
      end: i + 1 < turns.length ? startSeqs.get(turns[i + 1]) : Infinity
    }));
    const anchors = new Map();
    const prompts = new Map();
    const responses = new Map();
    let iv = 0;
    for (const node of state.nodes) {
      const seq = node.seq;
      while (iv < intervals.length && seq >= intervals[iv].end) iv += 1;
      if (iv >= intervals.length) break;
      const cur = intervals[iv];
      if (seq < cur.start) continue;
      if (!anchors.has(cur.turn) && isTurnAnchorCandidate(node)) anchors.set(cur.turn, nodeId(node));
      if (!prompts.has(cur.turn) && node.kind === NodeKind.user) {
        const p = clipTurnPreview(userTextParts(node), TurnRailPreview.promptLimit);
        if (p) prompts.set(cur.turn, p);
      }
      if (node.kind === NodeKind.assistant) {
        const r = clipTurnPreview(assistantTextParts(node), TurnRailPreview.responseLimit);
        if (r) responses.set(cur.turn, r);
      }
    }
    state.turnRail = mergeTurnRailItems(state.turnOutline, anchors, (turn) => ({
      prompt: prompts.get(turn) ?? "",
      response: responses.get(turn) ?? ""
    }));
  }

  // ---- 轨迹台账 ----

  /// 免观察的轨迹快照。装配成本只在窗口真正变脏(或语言切换)时付一次。
  function trajectorySnapshot() {
    const lang = getLang();
    if (!state.trajectoryDirty && state.trajectory && state.trajectoryLang === lang) {
      return state.trajectory;
    }
    state.trajectory = assembleTrajectory(state.window);
    state.trajectoryDirty = false;
    state.trajectoryLang = lang;
    return state.trajectory;
  }

  /// 往前追加更早的一页历史。现有所有入口都是 reset + 全量重放,无法增量前扩;
  /// 这里按 seq 归并进窗口后只重折一次,既保住节点模型,也保住轨迹窗口。
  function prependEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const existing = state.window;
    const firstSeq = existing.length ? existing[0].event.seq : Number.POSITIVE_INFINITY;
    const known = new Set(existing.map((entry) => entry.event.seq));
    const fresh = entries.filter((entry) => {
      const seq = entry?.event?.seq;
      return Number.isInteger(seq) && seq < firstSeq && !known.has(seq);
    });
    if (fresh.length === 0) return false;
    fresh.sort((left, right) => left.event.seq - right.event.seq);
    const merged = [...fresh, ...existing];
    if (merged.length > MAX_WINDOW_EVENTS) {
      merged.splice(0, merged.length - MAX_WINDOW_EVENTS);
      state.windowTruncated = true;
    }
    state.window = merged;
    replayWindow();
    return true;
  }

  // ---- 对外快照 ----

  function snapshot() {
    if (state.nodesDirty) rebuildNodes();
    return {
      sessionId: state.sessionId,
      title: state.title,
      cwd: state.cwd,
      blank: state.blank,
      running: state.running,
      historyError: state.historyError,
      currentTurn: state.currentTurn,
      lastSeq: state.lastSeq,
      nodes: state.nodes,
      lastNode: state.lastNode ?? null,
      runningTool: state.runningTool ?? null,
      turnRail: state.turnRail,
      todos: state.todos,
      goal: state.goal,
      tokenUsage: state.tokenUsage,
      permissions: state.permissions,
      modelSelection: state.modelSelection,
      planMode: state.planMode,
      contextPressure: state.contextPressure,
      contextBreakdown: state.contextBreakdown,
      sessionStats: state.sessionStats,
      imageLimits: state.imageLimits,
      subagent: state.subagent,
      agentPreset: state.agentPreset,
      queue: state.queue,
      jobs: state.jobs,
      pendingApproval: state.pendingApproval,
      pendingQuestion: state.pendingQuestion,
      producedPathsByTurn: state.producedPathsByTurn,
      presentedByTurn: state.presentedByTurn,
      deliverablesRevision: state.deliverablesRevision,
      turnProcessByTurn: state.turnProcessByTurn
    };
  }

  return {
    reset(sessionId) {
      state = blank();
      state.sessionId = sessionId ?? null;
    },
    applyEvent,
    applyProjection,
    applyAssistantStreamFrame,
    applyAssistantStreamBaseline,
    setQueue(items) { state.queue = Array.isArray(items) ? items : []; },
    setJobs(jobs) { state.jobs = Array.isArray(jobs) ? jobs : []; },
    setApproval(approval) { state.pendingApproval = approval ?? null; },
    setQuestion(question) { state.pendingQuestion = question ?? null; },
    setRunning(running) { state.running = Boolean(running); },
    /// 某轮的变更工具产出路径(首见顺序)。渲染回合尾行与 mention 词表用。
    producedPaths(turn) { return state.producedPathsByTurn.get(turn) ?? []; },
    /// 某轮的 present 交付声明(首见路径顺序)。
    presentedFiles(turn) { return state.presentedByTurn.get(turn) ?? []; },
    /// follow 流失败的落地点:对齐 Mac StreamCoordinator 的 failEventStream。
    /// 同时清掉 running —— 流已经死了,再没有 turn/end 会来把转圈停下。
    setHistoryError(message) {
      state.historyError = message ? String(message) : null;
      if (state.historyError) state.running = false;
    },
    setCwd(cwd) { state.cwd = cwd ?? null; },
    // RPC 写回没有 projection seq，只更新派生标题，不能伪造一个无限大的
    // projection 版本；否则宿主后续真实 title 投影会被永久判成旧帧。
    setTitle(title) { if (typeof title === "string" && title) state.title = title; },
    setAgentPreset(preset) { state.agentPreset = preset ?? null; },
    /// 工具调用查找:审批卡要靠它拿到 bash 的 command。
    toolCall(callId) {
      const ctx = state.contexts.get(toolKey(callId));
      return ctx?.type === "toolCall" ? ctx.node : null;
    },
    getSnapshot: snapshot,
    getTrajectory: trajectorySnapshot,
    prependEntries,
    get windowTruncated() { return state.windowTruncated === true; },
    clearWindowTruncated() { state.windowTruncated = false; }
  };
}
