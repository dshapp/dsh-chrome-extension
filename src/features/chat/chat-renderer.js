// 聊天记录渲染器:按 nodeId 对账 nodes → DOM。
//
// 与旧版按索引对账的关键差别:节点列表来自 store 的全序排序,一次 rebuild 可能在
// **任意位置**插入行(迟到的 tool/result、被抹掉的重试 step、turnTail 回填)。
// 按索引比对遇到首个差异就要截断重建,那会把整段记录重画;按 id 对账则只动真正变了的行。
import { t } from "../../shared/i18n.js";
import { nodeId, NodeKind, isNodeRunning, nodeTurn } from "../sessions/chat-nodes.js";
import { processSpecFor } from "../sessions/turn-process.js";
import { createNodeElement, updateNodeElement, closeTurnStatPopover } from "./node-views.js";
import { closeCardDetail } from "./card-detail.js";
import { toolRowModel } from "./tool-row-model.js";

export function createChatRenderer(container, { onFork, getContext } = {}) {
  // id → { element, node }
  let rendered = new Map();
  let typingEl = null;
  let typingTimer = null;
  let typingStartedAt = null;
  // Turn process 展开态(turn 集合)与当前渲染用的折叠规格。
  // 默认收起;同一会话内切换后保持,换会话 reset 时清空。
  const openProcessTurns = new Set();
  let processSpecs = new Map();

  // ---- turn hover(对齐 Mac TurnHoverState) ----
  // 页脚操作行只在指针落在**该轮**上时浮现:该轮的 assistant 正文行或页脚本身。
  // 所有行共用一个 hoveredTurn,离开时延迟 150ms 再清,指针从正文挪到页脚、
  // 或穿过两行之间的空隙时不会闪。显隐只切 class、走 opacity,不改布局。
  const HOVER_CLOSE_DELAY_MS = 150;
  let hoveredTurn = null;
  let hoverCloseTimer = null;

  function applyTurnHover() {
    for (const entry of rendered.values()) {
      if (entry.node.kind !== NodeKind.turnTail) continue;
      entry.element.classList.toggle("turn-hovered", hoveredTurn != null && nodeTurn(entry.node) === hoveredTurn);
    }
  }

  function setHoveredTurn(turn) {
    if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; }
    if (turn == null) {
      if (hoveredTurn == null) return;
      hoverCloseTimer = setTimeout(() => {
        hoverCloseTimer = null;
        hoveredTurn = null;
        applyTurnHover();
      }, HOVER_CLOSE_DELAY_MS);
      return;
    }
    if (hoveredTurn === turn) return;
    hoveredTurn = turn;
    applyTurnHover();
  }

  /// 指针所在的"会揭示页脚"的行(容器的直接子元素,带 data-hover-turn)。
  function hoverTurnOf(target) {
    let row = target instanceof Element ? target : null;
    while (row && row.parentElement !== container) row = row.parentElement;
    const value = row?.dataset.hoverTurn;
    return value == null || value === "" ? null : Number(value);
  }

  container.addEventListener("pointerover", (event) => setHoveredTurn(hoverTurnOf(event.target)));
  container.addEventListener("pointerleave", () => setHoveredTurn(null));

  function context() {
    return { onFork, ...(getContext?.() ?? {}) };
  }

  function render(nodes) {
    const next = new Map();
    const ctx = context();
    processSpecs = new Map();
    for (const node of nodes) {
      if (node.kind === NodeKind.turnProcess) processSpecs.set(node.turn, node);
    }

    // 分叉只允许落在**最后一轮**的 turnTail 上(更早的轮次分叉会切掉后续记录)。
    // 这个判断取自整份列表,不是单个节点的属性,所以要在这里算,并显式带进
    // 该行的渲染上下文——否则一轮结束后新一轮到来时,旧页脚的按钮不会失效。
    let lastTailId = null;
    for (const node of nodes) {
      if (node.kind === NodeKind.turnTail) lastTailId = nodeId(node);
    }

    // 一趟按目标顺序落位:已存在则(必要时)更新并移动,不存在则新建。
    let cursor = container.firstElementChild;
    for (const node of nodes) {
      const id = nodeId(node);
      // 同一 id 在一趟里出现两次时只认第一份。第二份会把第一份挤出 next,
      // 而清理只遍历 next 之外的旧条目 —— 被挤出的那个元素就永远留在 DOM 里,
      // 每渲染一次多攒一份(症状:同一条消息重复 N 遍)。
      if (next.has(id)) continue;
      const previous = rendered.get(id);
      let element;
      // turnTail 的分叉可用性依赖"我是不是最后一轮"——这不是节点自身的数据,
      // 节点引用不变它也可能翻转,所以单独比对,变了就强制重建这一行。
      const isLastTurn = node.kind === NodeKind.turnTail ? id === lastTailId : true;
      // 产出/present 词表是节点之外的数据:revision 变了也要重建这一行,否则迟到的
      // present/落定结果落在页脚上时不会补画。
      const deliverablesRev = node.kind === NodeKind.turnTail ? (ctx.deliverablesRevision ?? null) : null;
      const tailFlipped = previous != null
        && (previous.isLastTurn !== isLastTurn || previous.deliverablesRev !== deliverablesRev);
      let nodeCtx = node.kind === NodeKind.turnTail
        ? { ...ctx, isLastTurn, deliverablesRevision: deliverablesRev }
        : ctx;
      if (node.kind === NodeKind.turnProcess) {
        nodeCtx = {
          ...ctx,
          processOpen: openProcessTurns.has(node.turn),
          onToggleProcess: toggleTurnProcess
        };
      }

      if (previous) {
        element = previous.element;
        // 引用未变说明这一行的数据没动过,跳过更新(store 每次 rebuild 会重建
        // 变化节点的对象,未变的节点保持同一引用)。例外:流式中的 assistant step
        // 由 live 旁路就地追加 blocks,引用不变,必须每帧对账,否则正文/思考停在首帧。
        const streaming = node.kind === NodeKind.assistant && isNodeRunning(node);
        if ((previous.node !== node || tailFlipped || streaming) && !updateNodeElement(element, node, nodeCtx)) {
          const replacement = createNodeElement(node, nodeCtx);
          if (replacement) {
            // 被替换的正好是 cursor 时先把 cursor 让开:replaceWith 会让旧元素
            // 脱离容器,再拿它当 insertBefore 的锚点会抛 NotFoundError,
            // 整趟渲染断在半路(next 未回写 → 已插入的元素成为无人认领的孤儿)。
            if (cursor === element) cursor = element.nextElementSibling;
            element.dispose?.();
            element.replaceWith(replacement);
            element = replacement;
          }
        }
      } else {
        element = createNodeElement(node, nodeCtx);
        if (!element) continue;   // 该节点这一版不渲染(如无指标的 turnTail)
      }

      if (element === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        // 锚点必须仍在容器里,否则退化为 append。
        if (cursor && cursor.parentNode !== container) cursor = null;
        container.insertBefore(element, cursor);
      }
      // turn rail 的滚动定位与阅读位置上报依赖 nodeId → 元素,这里显式挂上。
      element.dataset.nodeId = id;
      // 会揭示本轮页脚的行:assistant 正文与页脚本身(同 Mac 的 onHover 挂点)。
      const hoverTurn = node.kind === NodeKind.assistant || node.kind === NodeKind.turnTail ? nodeTurn(node) : null;
      if (hoverTurn != null) element.dataset.hoverTurn = String(hoverTurn);
      else delete element.dataset.hoverTurn;
      next.set(id, { element, node, isLastTurn, deliverablesRev });
    }

    // 目标里没有的行删掉(重试抹除、历史重载)。
    for (const [id, entry] of rendered) {
      if (!next.has(id)) {
        entry.element.dispose?.();
        entry.element.remove();
      }
    }
    rendered = next;
    applyProcessVisibility();
    // 新建/替换的页脚元素不带 hover 态,按当前 hoveredTurn 补上。
    applyTurnHover();

    // indicator 始终贴底。
    if (typingEl && typingEl.parentNode === container && typingEl !== container.lastElementChild) {
      container.append(typingEl);
    }
  }

  // ---- turn process 折叠 ----

  /// 折叠头是成员行的开关;成员行用 hidden 隐藏(保留在 DOM,便于后续查找)。
  /// 成员按 anchor 区间归属(对齐 Mac isFoldedProcessRow):命令/压缩/重试行没有 turn 号,
  /// 孤儿结果的 turn 号可能指向窗口外的更早一轮,它们照样随所在区间一起收起。
  function applyProcessVisibility() {
    for (const entry of rendered.values()) {
      const spec = processSpecFor(entry.node, processSpecs);
      entry.element.hidden = spec ? !openProcessTurns.has(spec.turn) : false;
      if (entry.node.kind === NodeKind.assistant) {
        const own = processSpecs.get(entry.node.turn);
        const hideReasoning = own?.inlineReasoning && own.answerStep === entry.node.step && !openProcessTurns.has(own.turn);
        for (const part of entry.element.querySelectorAll(".thinking-bubble")) part.hidden = Boolean(hideReasoning);
      }
    }
  }

  function toggleTurnProcess(turn) {
    if (openProcessTurns.has(turn)) openProcessTurns.delete(turn);
    else openProcessTurns.add(turn);
    const open = openProcessTurns.has(turn);
    for (const entry of rendered.values()) {
      const node = entry.node;
      if (node.kind === NodeKind.turnProcess && node.turn === turn) {
        entry.element.dataset.open = open ? "true" : "false";
        entry.element.setAttribute("aria-expanded", String(open));
        entry.element.title = open ? t("process.collapse") : t("process.expand");
      }
    }
    applyProcessVisibility();
  }

  // ---- 等待指示 ----
  // 用时取本轮 turn/start 的时间(对齐 Mac runningStartTime = turnStartTimes[currentTurn]):
  // 进出思考态、切会话、指示器重建都不归零;还没有 turn/start 时不显示用时。

  function paintTypingTime() {
    const timeEl = typingEl?.querySelector(".typing-time");
    if (!timeEl) return;
    if (typingStartedAt == null) { timeEl.textContent = ""; return; }
    // 与 web/Mac 一致:下限 1 秒。
    const sec = Math.max(1, Math.floor((Date.now() - typingStartedAt) / 1000));
    timeEl.textContent = ` · ${sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60 ? ` ${sec % 60}s` : ""}`}`;
  }

  function mountTyping(thinking, label, startedAt) {
    setTyping(false);
    typingStartedAt = startedAt ?? null;
    typingEl = document.createElement("div");
    typingEl.className = thinking ? "typing-indicator thinking" : "typing-indicator";
    const dots = thinking ? "" : '<div class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></div>';
    typingEl.innerHTML = `${dots}<span class="typing-label" role="status" aria-live="polite"></span><span class="typing-time" aria-hidden="true"></span>`;
    typingEl.querySelector(".typing-label").textContent = label;
    paintTypingTime();
    typingTimer = setInterval(paintTypingTime, 1000);
    container.append(typingEl);
  }

  /// startedAt:本轮 turn/start 的时间戳(ms),来自快照的 runningStartTime。
  function setTyping(active, label, startedAt = null) {
    if (!active) {
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      typingEl?.remove();
      typingEl = null;
      return;
    }
    const text = label || t("working");
    // 已有一个 working 指示 → 原地改文案与起点。
    if (typingEl && !typingEl.classList.contains("thinking")) {
      const labelEl = typingEl.querySelector(".typing-label");
      if (labelEl) labelEl.textContent = text;
      typingStartedAt = startedAt ?? null;
      paintTypingTime();
      if (typingEl.parentNode !== container || typingEl !== container.lastElementChild) container.append(typingEl);
      return;
    }
    mountTyping(false, text, startedAt);
  }

  function setThinking(thinking, startedAt = null) {
    if (!thinking) {
      if (typingEl?.classList.contains("thinking")) setTyping(false);
      for (const node of container.querySelectorAll(".typing-indicator.thinking")) node.remove();
      return;
    }
    mountTyping(true, `${t("thinking")} …`, startedAt);
  }

  function reset() {
    // 详情弹窗是全局单例:换会话/清空记录时必须关掉,否则它会停在上一个会话的卡片上。
    closeCardDetail();
    closeTurnStatPopover();
    for (const entry of rendered.values()) entry.element.dispose?.();
    rendered = new Map();
    if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; }
    hoveredTurn = null;
    openProcessTurns.clear();
    processSpecs = new Map();
    container.replaceChildren();
    setTyping(false);
  }

  return {
    render, setTyping, setThinking, reset,
    get count() { return rendered.size; },
    /// turn rail 用:按 nodeId 取当前渲染的元素,滚过去/上报阅读位置。
    elementById(id) { return rendered.get(id)?.element ?? null; }
  };
}

/// 从快照派生"agent 正在做什么"的细分文案。
/// 返回 null 表示不展示 working 指示(空闲,或正处于 isThinking 覆盖的思考态)。
export function agentStatusLabel(snapshot, { awaitingTurnStart = false } = {}) {
  if (awaitingTurnStart) return t("statusPreparing");
  if (!snapshot.running) return null;
  const nodes = snapshot.nodes ?? [];
  const last = snapshot.lastNode ?? nodes[nodes.length - 1];
  // 唤醒本轮的通知与用户消息同级:刚开轮、模型还没出字。
  if (!last || last.kind === NodeKind.user || last.kind === NodeKind.turnTrigger) return t("statusWaitingModel");

  // 有任何工具在跑就报它——工具行本身有运行态图标,这里给出同样的文案,
  // 方便该行滚出可视区时仍能确认状态。优先读 store 缓存的标量,避免每帧
  // 复制整个 nodes 数组反向扫描。
  const runningTool = snapshot.runningTool
    ?? [...nodes].reverse().find((n) => n.kind === NodeKind.toolCall && n.result == null);
  if (runningTool) return runningTool.preparing ? t("tool.preparing") : toolRowModel(runningTool).summary || t("working");

  if (last.kind === NodeKind.assistant) {
    if (isThinking(snapshot)) return null;    // 交给 setThinking
    if (isNodeRunning(last)) return t("statusGenerating");
    return t("statusProcessing");             // step 已结算,等下一步
  }
  return t("working");
}

/// 最后一个 assistant step 正在流式输出 reasoning 时,显示"思考中"。
export function isThinking(snapshot) {
  if (!snapshot.running) return false;
  const nodes = snapshot.nodes ?? [];
  const last = snapshot.lastNode ?? nodes[nodes.length - 1];
  if (last?.kind !== NodeKind.assistant || !isNodeRunning(last)) return false;
  // 末块是 reasoning 且还没有任何文本产出 = 正在思考。
  const blocks = (last.blocks ?? []).filter(Boolean);
  const tail = blocks[blocks.length - 1];
  return tail?.type === "reasoning" && !blocks.some((b) => b.type === "text" && b.text);
}
