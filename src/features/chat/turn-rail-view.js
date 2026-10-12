// 会话 turn 轨道:竖排刻度,每个刻度一轮。读到停在标的上的轮次高亮
// (active),正在分页加载的轮次转圈 (busy),窗口外的轮(只有 turnOutline 投影
// 命名、无锚点行)画成细短刻度。hover/focus 出预览卡(prompt + response)。
// 对齐 web ui-chat/chat/TurnNavigator.tsx 的固定间距刻度与交互。
//
// 轮次多到一列放不下时,轨道不再把刻度挤出屏幕:
// - 外框高度锁在消息区之内(band),刻度在内部 scroller 里滚动(隐藏滚动条);
// - 可滚的一端加渐隐遮罩 + 一枚带"还有 N 轮"计数的翻页按钮,点它整页翻、滚轮也能滚;
// - active 轮出视窗时自动滚回中间(指针在轨道上时不动,免得刻度从手底下溜走);
// - 键盘 ↑/↓/Home/End/PageUp/PageDown 在刻度间移动焦点(roving tabindex,只占一个 Tab 位)。

import { t } from "../../shared/i18n.js";

/// 相邻刻度的固定间距;命中区上下相接,刻度之间没有点不中的缝。
export const TURN_PITCH_PX = 12;
/// 外框离消息区上下缘的留白。
const BAND_INSET_PX = 16;
/// 刻度区可视高度的下限:再矮就没法用了,宁可溢出 band 也保住这几格。
const MIN_VIEW_PX = TURN_PITCH_PX * 4;
/// 判定"在视窗内"时两端让出的渐隐带。
const FADE_PX = 18;
/// 溢出时上下两枚翻页按钮合计占的高度(与 CSS .turn-rail-edge 高度一致)。
const EDGE_EXTENT_PX = 36;

/// 滚动位置决定哪个刻度过亮:取最后一个"顶边已越过视口顶部"的已加载轮。
/// rowTop(anchorRow) 返回该行视口坐标,取不到(null)表示这一轮没有锚点行。
export function resolveActiveTurn(items, hostTop, rowTop) {
  let candidate = null;
  for (const item of items) {
    if (item.anchorRow == null) continue;
    const top = rowTop(item.anchorRow);
    if (top == null) continue;
    if (top <= hostTop + 12) candidate = item.turn;
    else break;
  }
  if (candidate == null) candidate = items.find((i) => i.anchorRow != null)?.turn ?? null;
  return candidate;
}

/// 把 index 号刻度滚进视窗需要的 scrollTop;已在视窗内(扣掉渐隐带)返回 null。
/// 纯函数,便于单测:viewHeight 为 scroller 可视高度,count 为刻度总数。
export function railScrollTarget({ index, count, viewHeight, scrollTop, reveal = "if-needed" }) {
  if (viewHeight <= 0 || index < 0 || index >= count) return null;
  const total = count * TURN_PITCH_PX;
  const max = Math.max(0, total - viewHeight);
  if (max === 0) return null;
  const center = index * TURN_PITCH_PX + TURN_PITCH_PX / 2;
  if (reveal === "if-needed") {
    const fade = Math.min(FADE_PX, viewHeight / 4);
    if (center >= scrollTop + fade && center <= scrollTop + viewHeight - fade) return null;
  }
  const target = Math.max(0, Math.min(max, Math.round(center - viewHeight / 2)));
  return target === Math.round(scrollTop) ? null : target;
}

/// 视窗上方/下方被藏起来的刻度数(部分可见的那格算可见)。
export function hiddenTurnCounts({ count, viewHeight, scrollTop }) {
  if (viewHeight <= 0 || count * TURN_PITCH_PX <= viewHeight + 1) return { above: 0, below: 0 };
  const above = Math.max(0, Math.floor((scrollTop + 1) / TURN_PITCH_PX));
  const lastVisible = Math.ceil((scrollTop + viewHeight - 1) / TURN_PITCH_PX) - 1;
  const below = Math.max(0, count - 1 - lastVisible);
  return { above, below };
}

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/// container: 轨道外框(#turn-rail)。band: 轨道要待在其竖向范围内的元素(消息区)。
export function mountTurnRail(container, { onNavigate, band = null } = {}) {
  let state = { items: [], activeTurn: null, busyTurn: null };
  let renderedItems = null;
  let previewEl = null;
  let previewTurn = null;
  let pointerInside = false;
  // 首次布局直接落到 active 轮,不播滚动动画;之后的跟随才平滑。
  let placed = false;
  const ticks = new Map();

  const upButton = edgeButton("up");
  const scroller = document.createElement("div");
  scroller.className = "turn-rail-scroller";
  const downButton = edgeButton("down");
  container.replaceChildren(upButton, scroller, downButton);

  function edgeButton(direction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `turn-rail-edge turn-rail-edge-${direction}`;
    button.tabIndex = -1;
    button.hidden = true;
    const chevron = document.createElement("span");
    chevron.className = "turn-rail-edge-chevron";
    chevron.setAttribute("aria-hidden", "true");
    const count = document.createElement("span");
    count.className = "turn-rail-edge-count";
    button.append(chevron, count);
    button.addEventListener("click", () => {
      const page = Math.max(TURN_PITCH_PX, scroller.clientHeight - TURN_PITCH_PX * 2);
      scroller.scrollBy({ top: direction === "up" ? -page : page, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
    return button;
  }

  container.addEventListener("pointerenter", () => { pointerInside = true; });
  container.addEventListener("pointerleave", () => {
    pointerInside = false;
    hidePreview();
  });
  scroller.addEventListener("scroll", () => {
    updateEdges();
    // 预览卡钉在刻度旁;刻度滚走了,卡片跟着收起,停下后 hover 会再唤出。
    if (previewEl && document.activeElement?.closest?.(".turn-rail-scroller") !== scroller) hidePreview();
    else if (previewEl) positionPreview();
  }, { passive: true });
  scroller.addEventListener("keydown", onKeyDown);

  // 消息区尺寸变化(侧栏拉伸、composer 长高)要重算外框与刻度视窗。
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => layout()) : null;
  if (band && resizeObserver) resizeObserver.observe(band);
  if (typeof window !== "undefined") window.addEventListener("resize", () => layout());

  /// 外框:竖向居中于 band,最高不超过 band 减留白;刻度区据此决定是否需要内部滚动。
  function layout() {
    if (container.hidden) return;
    const rect = band?.getBoundingClientRect?.();
    const content = state.items.length * TURN_PITCH_PX;
    if (rect && rect.height > 0) {
      const available = Math.max(MIN_VIEW_PX, rect.height - BAND_INSET_PX * 2);
      const overflow = content > available;
      // 溢出时两端翻页按钮也要占位,刻度视窗相应让出。
      const view = overflow ? Math.max(MIN_VIEW_PX, available - EDGE_EXTENT_PX) : content;
      scroller.style.maxHeight = `${view}px`;
      container.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
    } else {
      scroller.style.maxHeight = "";
      container.style.top = "";
    }
    updateEdges();
    followActive();
  }

  function overflowing() {
    return scroller.scrollHeight > scroller.clientHeight + 1;
  }

  function updateEdges() {
    const overflow = overflowing();
    container.classList.toggle("overflowing", overflow);
    const { above, below } = hiddenTurnCounts({
      count: state.items.length,
      viewHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop
    });
    // 溢出时两枚按钮都占位(隐藏用 visibility),免得滚到头时刻度区上下跳。
    upButton.hidden = !overflow;
    downButton.hidden = !overflow;
    setEdge(upButton, above, "turnNavigation.moreAbove");
    setEdge(downButton, below, "turnNavigation.moreBelow");
    scroller.classList.toggle("fade-top", above > 0);
    scroller.classList.toggle("fade-bottom", below > 0);
  }

  function setEdge(button, count, key) {
    button.classList.toggle("exhausted", count === 0);
    button.disabled = count === 0;
    button.querySelector(".turn-rail-edge-count").textContent = count > 0 ? String(count) : "";
    const label = t(key, { count });
    button.setAttribute("aria-label", label);
    button.title = count > 0 ? label : "";
  }

  /// active 轮出视窗时滚回中间;指针在轨道上时不动它。
  function followActive({ force = false } = {}) {
    if (container.hidden || (pointerInside && !force)) return;
    const index = state.items.findIndex((i) => i.turn === state.activeTurn);
    if (index < 0) return;
    const viewHeight = scroller.clientHeight;
    if (viewHeight <= 0) return;
    const firstPlacement = !placed;
    const target = railScrollTarget({
      index,
      count: state.items.length,
      viewHeight,
      scrollTop: scroller.scrollTop,
      reveal: firstPlacement ? "always" : "if-needed"
    });
    placed = true;
    if (target == null) return;
    const behavior = firstPlacement || prefersReducedMotion() ? "auto" : "smooth";
    if (behavior === "auto") {
      scroller.scrollTop = target;
      updateEdges();
    } else {
      scroller.scrollTo({ top: target, behavior });
    }
  }

  function buildTicks() {
    const previousScroll = scroller.scrollTop;
    ticks.clear();
    const fragment = document.createDocumentFragment();
    for (const item of state.items) {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "turn-tick";
      tick.dataset.turn = String(item.turn);
      tick.tabIndex = -1;
      tick.addEventListener("click", () => onNavigate?.(item));
      tick.addEventListener("pointerenter", () => showPreview(item, tick));
      tick.addEventListener("focus", () => showPreview(item, tick));
      tick.addEventListener("blur", () => { if (previewTurn === item.turn) hidePreview(); });
      ticks.set(item.turn, { tick, item });
      fragment.append(tick);
    }
    scroller.replaceChildren(fragment);
    // replaceChildren 会把内容瞬间清空,浏览器随之把 scrollTop 夹到 0;还原读者的位置。
    scroller.scrollTop = previousScroll;
    renderedItems = state.items;
  }

  function decorateTicks() {
    const { activeTurn, busyTurn } = state;
    let rovingSet = false;
    for (const { tick, item } of ticks.values()) {
      const active = item.turn === activeTurn;
      const busy = item.turn === busyTurn;
      tick.classList.toggle("active", active);
      tick.classList.toggle("busy", busy);
      tick.classList.toggle("unloaded", item.anchorRow == null);
      tick.classList.toggle("previewing", item.turn === previewTurn && !active);
      tick.setAttribute("aria-label", t(item.anchorRow != null ? "turnNavigation.jump" : "turnNavigation.jumpLoad", { turn: item.turn }));
      if (active) tick.setAttribute("aria-current", "true");
      else tick.removeAttribute("aria-current");
      if (busy) tick.setAttribute("aria-busy", "true");
      else tick.removeAttribute("aria-busy");
      // roving tabindex:Tab 只落在 active 刻度上,其余用方向键走。
      const focusable = active && !rovingSet;
      if (focusable) rovingSet = true;
      if (!scroller.contains(document.activeElement)) tick.tabIndex = focusable ? 0 : -1;
    }
    if (!rovingSet && !scroller.contains(document.activeElement)) {
      const last = [...ticks.values()].at(-1);
      if (last) last.tick.tabIndex = 0;
    }
  }

  function render() {
    const { items } = state;
    if (items.length < 2) {
      hidePreview();
      container.hidden = true;
      return;
    }
    const wasHidden = container.hidden;
    container.hidden = false;
    if (renderedItems !== items) buildTicks();
    decorateTicks();
    if (wasHidden) placed = false;
    layout();
    if (previewEl && previewTurn != null) {
      const entry = ticks.get(previewTurn);
      if (entry) fillPreview(entry.item);
      else hidePreview();
    }
  }

  function onKeyDown(event) {
    const current = event.target.closest?.(".turn-tick");
    if (!current) return;
    const list = [...ticks.values()].map((entry) => entry.tick);
    const index = list.indexOf(current);
    if (index < 0) return;
    const page = Math.max(1, Math.floor(scroller.clientHeight / TURN_PITCH_PX) - 1);
    let next = null;
    switch (event.key) {
      case "ArrowUp": next = index - 1; break;
      case "ArrowDown": next = index + 1; break;
      case "PageUp": next = index - page; break;
      case "PageDown": next = index + page; break;
      case "Home": next = 0; break;
      case "End": next = list.length - 1; break;
      default: return;
    }
    event.preventDefault();
    next = Math.max(0, Math.min(list.length - 1, next));
    const target = list[next];
    current.tabIndex = -1;
    target.tabIndex = 0;
    target.focus({ preventScroll: true });
    const scrollTop = railScrollTarget({ index: next, count: list.length, viewHeight: scroller.clientHeight, scrollTop: scroller.scrollTop });
    if (scrollTop != null) {
      scroller.scrollTop = scrollTop;
      updateEdges();
      positionPreview();
    }
  }

  function fillPreview(item) {
    const meta = document.createElement("div");
    meta.className = "turn-rail-preview-meta";
    const lastTurn = state.items.at(-1)?.turn ?? item.turn;
    meta.textContent = t("turnNavigation.position", { turn: item.turn, total: lastTurn });
    const prompt = document.createElement("div");
    prompt.className = "turn-rail-preview-prompt";
    prompt.textContent = item.prompt || t("turnNavigation.turn", { turn: item.turn });
    const parts = [meta, prompt];
    if (item.response) {
      const response = document.createElement("div");
      response.className = "turn-rail-preview-response";
      response.textContent = item.response;
      parts.push(response);
    }
    previewEl.replaceChildren(...parts);
  }

  function showPreview(item, tick) {
    if (!previewEl) {
      previewEl = document.createElement("div");
      previewEl.className = "turn-rail-preview";
      previewEl.setAttribute("role", "tooltip");
      container.append(previewEl);
    }
    const previous = previewTurn != null ? ticks.get(previewTurn)?.tick : null;
    previous?.classList.remove("previewing");
    previewTurn = item.turn;
    if (item.turn !== state.activeTurn) tick.classList.add("previewing");
    fillPreview(item);
    positionPreview();
  }

  /// 预览卡挂在外框上(不在 scroller 里,不会被裁掉),竖向跟刻度中心对齐并夹在视口内。
  function positionPreview() {
    if (!previewEl || previewTurn == null) return;
    const tick = ticks.get(previewTurn)?.tick;
    if (!tick) return;
    const frame = container.getBoundingClientRect();
    const tickRect = tick.getBoundingClientRect();
    const height = previewEl.offsetHeight || 0;
    const center = tickRect.top + tickRect.height / 2;
    const viewport = typeof window !== "undefined" ? window.innerHeight : Infinity;
    const top = Math.max(8, Math.min(viewport - height - 8, center - height / 2));
    previewEl.style.top = `${Math.round(top - frame.top)}px`;
  }

  function hidePreview() {
    if (previewTurn != null) ticks.get(previewTurn)?.tick.classList.remove("previewing");
    previewEl?.remove();
    previewEl = null;
    previewTurn = null;
  }

  return Object.freeze({
    set(items, activeTurn, busyTurn) {
      const next = { items: Array.isArray(items) ? items : [], activeTurn: activeTurn ?? null, busyTurn: busyTurn ?? null };
      const changed = state.items !== next.items || state.activeTurn !== next.activeTurn || state.busyTurn !== next.busyTurn;
      state = next;
      if (changed) render();
    },
    /// 外部布局变化(如轨迹面板开合)后手动重排。
    relayout() { layout(); },
    reset() {
      state = { items: [], activeTurn: null, busyTurn: null };
      hidePreview();
      ticks.clear();
      renderedItems = null;
      placed = false;
      scroller.replaceChildren();
      scroller.scrollTop = 0;
      container.hidden = true;
    }
  });
}
