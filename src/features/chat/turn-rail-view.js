// 会话 turn 轨道:竖排刻度,每个刻度一轮。读到停在标的上的轮次高亮
// (active),正在分页加载的轮次转圈 (busy),窗口外的轮(只有 turnOutline 投影
// 命名、无锚点行)画成细短刻度。hover/focus 出预览卡(prompt + response)。
// 对齐 web ui-chat/chat/TurnNavigator.tsx 的固定间距刻度与交互。

import { t } from "../../shared/i18n.js";

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

export function mountTurnRail(container, { onNavigate } = {}) {
  let state = { items: [], activeTurn: null, busyTurn: null };
  let previewEl = null;

  function render() {
    container.replaceChildren();
    const { items, activeTurn, busyTurn } = state;
    if (items.length < 2) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    for (const item of items) {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "turn-tick";
      if (item.turn === activeTurn) tick.classList.add("active");
      if (item.turn === busyTurn) tick.classList.add("busy");
      if (item.anchorRow == null) tick.classList.add("unloaded");
      tick.dataset.turn = String(item.turn);
      tick.setAttribute("aria-label", t(item.anchorRow != null ? "turnNavigation.jump" : "turnNavigation.jumpLoad", { turn: item.turn }));
      if (item.turn === activeTurn) tick.setAttribute("aria-current", "true");
      if (item.turn === busyTurn) tick.setAttribute("aria-busy", "true");
      tick.addEventListener("click", () => onNavigate?.(item));
      tick.addEventListener("mouseenter", () => showPreview(item, tick));
      tick.addEventListener("mouseleave", hidePreview);
      tick.addEventListener("focus", () => showPreview(item, tick));
      tick.addEventListener("blur", hidePreview);
      container.append(tick);
    }
  }

  function showPreview(item, tick) {
    hidePreview();
    previewEl = document.createElement("div");
    previewEl.className = "turn-rail-preview";
    previewEl.setAttribute("role", "tooltip");
    const prompt = document.createElement("div");
    prompt.className = "turn-rail-preview-prompt";
    prompt.textContent = item.prompt || t("turnNavigation.turn", { turn: item.turn });
    previewEl.append(prompt);
    if (item.response) {
      const response = document.createElement("div");
      response.className = "turn-rail-preview-response";
      response.textContent = item.response;
      previewEl.append(response);
    }
    previewEl.style.top = `${tick.offsetTop}px`;
    container.append(previewEl);
  }

  function hidePreview() {
    previewEl?.remove();
    previewEl = null;
  }

  return Object.freeze({
    set(items, activeTurn, busyTurn) {
      const changed = state.items !== items || state.activeTurn !== activeTurn || state.busyTurn !== busyTurn;
      state = { items: Array.isArray(items) ? items : [], activeTurn: activeTurn ?? null, busyTurn: busyTurn ?? null };
      if (changed) render();
    },
    reset() {
      state = { items: [], activeTurn: null, busyTurn: null };
      hidePreview();
      container.replaceChildren();
      container.hidden = true;
    }
  });
}
