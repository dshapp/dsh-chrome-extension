// 历史浮层的「排序」控件与行拖拽的接线。
//
// 从 sidepanel-overlays.js 抽出来:那个文件在本次改动前就已经 409 行,
// 排序 + 拖拽再塞进去会把它推到 570 行,远超工程约束的 400 行硬上限。
//
// 这里承担三件互相咬合的事,所以放在同一个模块而不是拆成三个:
// 排序档的选择、它的持久化、以及"拖一下就自动切到手动档"。它们共享同一个
// orderBy 变量,拆开会变成三个模块传来传去地改同一份状态。
import { t } from "../../shared/i18n.js";
import { SessionOrderBy } from "../../features/sessions/session-list-store.js";
import { mountHistoryDrag } from "../../features/sessions/history-drag.js";
import { resolveReorder } from "../../features/sessions/sidebar-reorder.js";
import { renderMenuItems } from "./menu-items.js";
import { lucideIconSvg } from "../../features/chat/file-icons.js";

const ORDER_KEY = "dsh_history_order_by";

async function resolveStorage() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage.local;
  const { chromeShim } = await import("../../platform/storage/chrome-shim.js");
  return chromeShim.storage.local;
}

/**
 * 装上排序切换条与行拖拽。
 *
 * @param {object} options
 * @param {Element} options.popover 历史浮层根节点。
 * @param {Element} options.list 行容器 <ul>。
 * @param {object|null} options.orderStore 手动顺序账本。
 * @param {() => string|null} options.workspaceId 当前工作区(会话排序 RPC 要用)。
 * @param {object} options.workspaces 工作区服务(拿 moveSession)。
 * @param {() => Array} options.visibleRows 当前渲染出来的行(按显示顺序)。
 * @param {() => Array} options.fullRows 过滤后的完整行(可能长于渲染出来的那批)。
 * @param {(opts?: {resetSelection?: boolean}) => void} options.rerender 请求重画。
 * @returns {{orderBy: () => string, isDraggable: () => boolean, ready: Promise<void>}}
 */
export function mountHistoryOrdering({
  popover, list, orderStore, workspaceId, workspaces, visibleRows, fullRows, rerender
}) {
  // 默认 updated —— 那正是这个列表一直以来的行为,老用户不会因为升级看见顺序变了。
  let orderBy = SessionOrderBy.updated;

  const MODES = [SessionOrderBy.updated, SessionOrderBy.manual, SessionOrderBy.status];
  const modeLabel = (mode) => t(`sessions.orderBy${mode[0].toUpperCase()}${mode.slice(1)}`);

  // 触发钮 + popover 菜单。做成下拉而不是三颗并排的药丸:搜索行里已经住着
  // 工作目录 chip 和搜索框,三颗药丸会把这一行挤到换行 —— 下拉只占一颗按钮的宽度,
  // 且与同一行左侧的工作目录 chip 是同一种交互(点开→选一项),视觉上成对。
  const trigger = document.createElement("button");
  trigger.id = "history-order-btn";
  trigger.className = "hdr-btn";
  trigger.type = "button";
  trigger.setAttribute("popovertarget", "history-order-menu");
  const triggerLabel = document.createElement("span");
  triggerLabel.id = "history-order-label";
  // lucide: arrow-up-down —— 表达"换个顺序",比漏斗(筛选)更准确。
  trigger.insertAdjacentHTML("afterbegin", lucideIconSvg("arrow-up-down", { size: 13 }));
  trigger.append(triggerLabel);
  trigger.insertAdjacentHTML("beforeend", lucideIconSvg("chevron-down", { size: 12, className: "dropdown-chevron" }));

  const menu = document.createElement("div");
  menu.id = "history-order-menu";
  menu.setAttribute("popover", "auto");

  // 放到搜索框**右边**:搜索框是 flex:1,把两个控件都放进同一行,
  // 下拉自然落在最右侧。
  const searchWrap = popover.querySelector("#history-search-wrap");
  searchWrap?.append(trigger, menu);

  function choose(mode) {
    menu.hidePopover?.();
    if (orderBy === mode) return;
    orderBy = mode;
    void persist(mode);
    paint();
    // 换了排序,高亮回到第一行 —— 原来的下标指向的已经是别的会话了。
    rerender({ resetSelection: true });
  }

  function paint() {
    trigger.title = t("sessions.orderBy");
    trigger.setAttribute("aria-label", t("sessions.orderBy"));
    triggerLabel.textContent = modeLabel(orderBy);
    renderMenuItems(menu, MODES.map((mode) => ({ id: mode, label: modeLabel(mode) })), {
      selectedId: orderBy,
      onSelect: choose
    });
  }
  paint();

  async function persist(mode) {
    try {
      const area = await resolveStorage();
      await area.set({ [ORDER_KEY]: mode });
    } catch { /* 记不住就下次回到默认档,不影响本次使用 */ }
  }

  // 读回上次选的排序档与手动顺序账本。都是异步的,读到之前列表按默认档显示。
  const ready = (async () => {
    try {
      const area = await resolveStorage();
      const stored = (await area.get([ORDER_KEY]))?.[ORDER_KEY];
      if (stored && Object.values(SessionOrderBy).includes(stored)) {
        orderBy = stored;
        paint();
      }
    } catch { /* 读不到就用默认档 */ }
    await orderStore?.load?.();
    if (popover.classList.contains("open")) rerender();
  })();

  // 行拖拽。状态档下禁用:那个顺序是算出来的,拖了也会被下一次渲染算回去
  //(对齐 macOS 的 .moveDisabled(orderBy == "status"))。
  mountHistoryDrag(list, {
    enabled: () => orderBy !== SessionOrderBy.status,
    visibleIds: () => visibleRows().map((item) => item.sessionId),
    onDrop(movedId, overId, after) {
      const visible = visibleRows().map((item) => item.sessionId);
      // full 传全量:落在最后一条渲染行之后、而后面还有折叠行时,锚点要取
      // 第一条折叠行,而不是当成"移到末尾"。
      const full = fullRows().map((item) => item.sessionId);
      const move = resolveReorder({ movedId, overId, after, visible, full });
      if (!move) return;
      // 拖过之后自然进入手动档 —— 否则用户拖完看不到任何变化,会以为没生效。
      if (orderBy !== SessionOrderBy.manual) {
        orderBy = SessionOrderBy.manual;
        void persist(orderBy);
        paint();
      }
      // 具体 workspace 的手动序属于宿主 sessionIds；只有「全部」/临时目录
      // 才写浏览器本地账本。两份账不能同时写，否则宿主失败回滚后 UI 仍会被
      // 本地旧顺序重新排回去。
      const ws = workspaceId?.();
      if (ws && workspaces?.moveSession) {
        const settled = workspaces.moveSession(ws, move.movedId, move.beforeId);
        rerender(); // service 在第一个 await 前已发布乐观 sessionIds。
        void Promise.resolve(settled).then(() => rerender());
      } else {
        orderStore?.reorder?.(move.movedId, move.beforeId, full);
        rerender();
      }
    }
  });

  return {
    orderBy: () => orderBy,
    isDraggable: () => orderBy !== SessionOrderBy.status,
    ready
  };
}
