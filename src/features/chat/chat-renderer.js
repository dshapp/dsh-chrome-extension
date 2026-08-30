// 聊天记录渲染器:按 nodeId 对账 nodes → DOM。
//
// 与旧版按索引对账的关键差别:节点列表来自 store 的全序排序,一次 rebuild 可能在
// **任意位置**插入行(迟到的 tool/result、被抹掉的重试 step、turnTail 回填)。
// 按索引比对遇到首个差异就要截断重建,那会把整段记录重画;按 id 对账则只动真正变了的行。
import { t } from "../../shared/i18n.js";
import { nodeId, NodeKind, isNodeRunning } from "../sessions/chat-nodes.js";
import { createNodeElement, updateNodeElement } from "./node-views.js";
import { closeCardDetail } from "./card-detail.js";
import { toolRowModel } from "./tool-row-model.js";

export function createChatRenderer(container, { onFork, getContext } = {}) {
  // id → { element, node }
  let rendered = new Map();
  let typingEl = null;
  let typingTimer = null;
  let typingStartTs = 0;

  function context() {
    return { onFork, ...(getContext?.() ?? {}) };
  }

  function render(nodes) {
    const next = new Map();
    const ctx = context();

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
      const tailFlipped = previous != null && previous.isLastTurn !== isLastTurn;
      const nodeCtx = node.kind === NodeKind.turnTail ? { ...ctx, isLastTurn } : ctx;

      if (previous) {
        element = previous.element;
        // 引用未变说明这一行的数据没动过,跳过更新(store 每次 rebuild 会重建
        // 变化节点的对象,未变的节点保持同一引用)。
        if ((previous.node !== node || tailFlipped) && !updateNodeElement(element, node, nodeCtx)) {
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
      next.set(id, { element, node, isLastTurn });
    }

    // 目标里没有的行删掉(重试抹除、历史重载)。
    for (const [id, entry] of rendered) {
      if (!next.has(id)) {
        entry.element.dispose?.();
        entry.element.remove();
      }
    }
    rendered = next;

    // indicator 始终贴底。
    if (typingEl && typingEl.parentNode === container && typingEl !== container.lastElementChild) {
      container.append(typingEl);
    }
  }

  // ---- 等待指示 ----

  function setTyping(active, label) {
    if (!active) {
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      typingEl?.remove();
      typingEl = null;
      return;
    }
    const text = label || t("working");
    // 已有一个 working 指示 → 原地改文案,计时保持连续。
    if (typingEl && !typingEl.classList.contains("thinking")) {
      const labelEl = typingEl.querySelector(".typing-label");
      if (labelEl) labelEl.textContent = text;
      if (typingEl.parentNode !== container || typingEl !== container.lastElementChild) container.append(typingEl);
      return;
    }
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    typingEl?.remove();
    typingStartTs = Date.now();
    typingEl = document.createElement("div");
    typingEl.className = "typing-indicator";
    typingEl.innerHTML = '<div class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></div><span class="typing-label" role="status" aria-live="polite"></span><span class="typing-time" aria-hidden="true"></span>';
    typingEl.querySelector(".typing-label").textContent = text;
    const timeEl = typingEl.querySelector(".typing-time");
    const tick = () => {
      const sec = Math.floor((Date.now() - typingStartTs) / 1000);
      timeEl.textContent = sec > 0
        ? ` · ${sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60 ? ` ${sec % 60}s` : ""}`}`
        : "";
    };
    tick();
    typingTimer = setInterval(tick, 1000);
    container.append(typingEl);
  }

  function setThinking(thinking) {
    if (!thinking) {
      if (typingEl?.classList.contains("thinking")) setTyping(false);
      for (const node of container.querySelectorAll(".typing-indicator.thinking")) node.remove();
      return;
    }
    setTyping(false);
    typingEl = document.createElement("div");
    typingEl.className = "typing-indicator thinking";
    typingEl.innerHTML = `<span class="typing-label" role="status" aria-live="polite">${t("thinking")} …</span>`;
    container.append(typingEl);
  }

  function reset() {
    // 详情弹窗是全局单例:换会话/清空记录时必须关掉,否则它会停在上一个会话的卡片上。
    closeCardDetail();
    for (const entry of rendered.values()) entry.element.dispose?.();
    rendered = new Map();
    container.replaceChildren();
    setTyping(false);
  }

  return { render, setTyping, setThinking, reset, get count() { return rendered.size; } };
}

/// 从快照派生"agent 正在做什么"的细分文案。
/// 返回 null 表示不展示 working 指示(空闲,或正处于 isThinking 覆盖的思考态)。
export function agentStatusLabel(snapshot, { awaitingTurnStart = false } = {}) {
  if (awaitingTurnStart) return t("statusPreparing");
  if (!snapshot.running) return null;
  const nodes = snapshot.nodes ?? [];
  const last = nodes[nodes.length - 1];
  if (!last || last.kind === NodeKind.user) return t("statusWaitingModel");

  // 有任何工具在跑就报它——工具行本身有运行态图标,这里给出同样的文案,
  // 方便该行滚出可视区时仍能确认状态。
  const runningTool = [...nodes].reverse().find((n) => n.kind === NodeKind.toolCall && n.result == null);
  if (runningTool) return toolRowModel(runningTool).summary || t("working");

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
  const last = nodes[nodes.length - 1];
  if (last?.kind !== NodeKind.assistant || !isNodeRunning(last)) return false;
  // 末块是 reasoning 且还没有任何文本产出 = 正在思考。
  const blocks = (last.blocks ?? []).filter(Boolean);
  const tail = blocks[blocks.length - 1];
  return tail?.type === "reasoning" && !blocks.some((b) => b.type === "text" && b.text);
}
