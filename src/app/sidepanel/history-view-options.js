// 会话抽屉的「视图选项」(分组轴 + 排序轴)、分组折叠态与行拖拽的接线。
//
// 本文件的前身是 history-ordering.js(只有排序一根轴)。对齐 Mac 侧栏之后,
// 分组、折叠、"展开其余 N 个"与拖拽都必须共享同一份状态:拖一下要自动切到
// 手动档、切分组要重画、折叠要持久化 —— 拆成几个模块只会变成互相传状态。
//
// 两根轴与 Mac 的 SidebarViewOptions 同名同义:
//   分组 groupBy: workspace | flat      (默认 workspace)
//   排序 orderBy: manual | updated | status (默认 updated)
import { t } from "../../shared/i18n.js";
import { SessionOrderBy } from "../../features/sessions/session-list-store.js";
import { mountHistoryDrag } from "../../features/sessions/history-drag.js";
import { resolveReorder } from "../../features/sessions/sidebar-reorder.js";
import { renderMenuItems } from "./menu-items.js";
import { lucideIconSvg } from "../../features/chat/file-icons.js";
import { SidebarGroupBy, PINNED_GROUP_ID } from "../../features/sessions/sidebar-sections.js";

const ORDER_KEY = "dsh_history_order_by";
const GROUP_KEY = "dsh_history_group_by";
const COLLAPSED_KEY = "dsh_history_group_collapsed";

async function resolveStorage() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage.local;
  const { chromeShim } = await import("../../platform/storage/chrome-shim.js");
  return chromeShim.storage.local;
}

/**
 * 装上视图选项菜单、分组折叠态与行拖拽。
 *
 * @param {object} options
 * @param {Element} options.list 行容器 `<ul>`。
 * @param {object|null} options.orderStore 手动顺序账本(全部/未分组/单列表用)。
 * @param {object|null} options.pinnedStore 置顶账本。
 * @param {object} options.workspaces 工作区服务(拿 moveSession)。
 * @param {() => Array} options.sections 当前渲染的分区(buildSidebarSections 产物)。
 * @param {(opts?: {resetSelection?: boolean}) => void} options.rerender 请求重画。
 * @param {(() => unknown)|null} [options.onAddWorkspace] 「添加目录」按下时走的那条路径。
 * @returns {object} 视图状态与控制。
 */
export function mountHistoryViewOptions({
  list, orderStore, pinnedStore, workspaces, sections, rerender, onAddWorkspace = null
}) {
  // 默认档与 Mac 一致:按工作区分组、最近更新优先。
  let orderBy = SessionOrderBy.updated;
  let groupBy = SidebarGroupBy.workspace;
  /// 折叠起来的分组(持久化)。
  let collapsed = new Set();
  /// 点过「展开其余 N 个」的分组。与 Mac 的 showAll 一样只活在本次挂载里 ——
  /// 重新打开侧栏时回到 5 行的紧凑视图。
  const expanded = new Set();

  const ORDER_MODES = [SessionOrderBy.manual, SessionOrderBy.updated, SessionOrderBy.status];
  const GROUP_MODES = [SidebarGroupBy.workspace, SidebarGroupBy.flat];
  const orderLabel = (mode) => t(`sessions.orderBy${mode[0].toUpperCase()}${mode.slice(1)}`);
  const groupLabel = (mode) => t(`sessions.groupBy${mode[0].toUpperCase()}${mode.slice(1)}`);

  // 触发钮 + popover 菜单。一颗按钮里装两根轴(与 Mac 的 arrow.up.arrow.down
  // 菜单同形):分区标题那一行宽度有限,两颗并排的下拉会把标题挤没。
  const trigger = document.createElement("button");
  trigger.id = "history-view-btn";
  trigger.className = "hdr-btn";
  trigger.type = "button";
  trigger.setAttribute("popovertarget", "history-view-menu");
  trigger.insertAdjacentHTML("afterbegin", lucideIconSvg("arrow-up-down", { size: 14 }));

  const menu = document.createElement("div");
  menu.id = "history-view-menu";
  menu.setAttribute("popover", "auto");

  // 「添加目录」:与视图选项同住分区标题行(对齐 Mac 的 folder.badge.plus),
  // 同样是常驻节点 —— 每次重画后被搬回去,而不是跟着 innerHTML 重建。
  const addWorkspace = document.createElement("button");
  addWorkspace.id = "history-add-workspace";
  addWorkspace.className = "hdr-btn";
  addWorkspace.type = "button";
  addWorkspace.innerHTML = lucideIconSvg("folder-plus", { size: 14 });
  addWorkspace.addEventListener("click", () => { void onAddWorkspace?.(); });

  // 菜单开着时到来的重画请求先攒着。列表是整块 innerHTML 重建的,而菜单是
  // 分区标题行的子节点 —— 重建会把这个 popover 从 top layer 里摘下来,用户
  // 正在选的那张菜单就当场消失了(流式会话每帧都会触发一次重画)。
  let pendingRepaint = null;
  function menuIsOpen() {
    try { return menu.matches(":popover-open"); } catch { return false; }
  }
  menu.addEventListener("toggle", (event) => {
    if (event.newState !== "closed" || !pendingRepaint) return;
    const options = pendingRepaint;
    pendingRepaint = null;
    rerender(options);
  });

  function choose(id) {
    menu.hidePopover?.();
    const [axis, value] = String(id).split(":");
    if (axis === "group") {
      if (groupBy === value) return;
      groupBy = value;
      void persist({ [GROUP_KEY]: value });
    } else if (axis === "order") {
      if (orderBy === value) return;
      orderBy = value;
      void persist({ [ORDER_KEY]: value });
    } else return;
    paint();
    // 换了视图,高亮回到第一行 —— 原来的下标指向的已经是别的会话了。
    rerender({ resetSelection: true });
  }

  function paint() {
    const label = t("sessions.viewOptions");
    trigger.title = label;
    trigger.setAttribute("aria-label", label);
    addWorkspace.title = t("workspace.add");
    addWorkspace.setAttribute("aria-label", t("workspace.add"));
    renderMenuItems(menu, [
      ...GROUP_MODES.map((mode) => ({ id: `group:${mode}`, label: groupLabel(mode), group: t("sessions.groupBy") })),
      ...ORDER_MODES.map((mode) => ({ id: `order:${mode}`, label: orderLabel(mode), group: t("sessions.orderBy") }))
    ], {
      selectedIds: [`group:${groupBy}`, `order:${orderBy}`],
      groupBy: (entry) => entry.group,
      onSelect: choose
    });
  }
  paint();

  async function persist(patch) {
    try {
      const area = await resolveStorage();
      await area.set(patch);
    } catch { /* 记不住就下次回到默认档,不影响本次使用 */ }
  }

  function persistCollapsed() {
    void persist({ [COLLAPSED_KEY]: [...collapsed] });
  }

  // 读回上次的两根轴与折叠态,以及手动顺序/置顶账本。都是异步的,
  // 读到之前列表按默认档显示。
  const ready = (async () => {
    try {
      const area = await resolveStorage();
      const stored = await area.get([ORDER_KEY, GROUP_KEY, COLLAPSED_KEY]);
      const order = stored?.[ORDER_KEY];
      if (order && Object.values(SessionOrderBy).includes(order)) orderBy = order;
      const group = stored?.[GROUP_KEY];
      if (group && Object.values(SidebarGroupBy).includes(group)) groupBy = group;
      const folded = stored?.[COLLAPSED_KEY];
      if (Array.isArray(folded)) collapsed = new Set(folded.filter((id) => typeof id === "string"));
      paint();
    } catch { /* 读不到就用默认档 */ }
    await Promise.all([orderStore?.load?.(), pinnedStore?.load?.()]);
    rerender();
  })();

  /// 一次落下该写进哪本账:置顶区写置顶账本,真实工作区写宿主的
  /// insertSessionBefore,未分组/单列表写浏览器本地的手动序账本。
  function commitMove(groupId, movedId, beforeId) {
    const section = (sections() ?? []).find((item) => item.id === groupId);
    if (!section) return;
    if (section.kind === "pinned") {
      // 置顶区的顺序不受排序档影响(它是用户手摆的),所以这里不切档。
      pinnedStore?.reorder?.(movedId, beforeId);
      rerender();
      return;
    }
    // 拖过之后自然进入手动档 —— 否则用户拖完看不到任何变化,会以为没生效。
    if (orderBy !== SessionOrderBy.manual) {
      orderBy = SessionOrderBy.manual;
      void persist({ [ORDER_KEY]: orderBy });
      paint();
    }
    if (section.kind === "workspace" && section.workspaceId && workspaces?.moveSession) {
      const settled = workspaces.moveSession(section.workspaceId, movedId, beforeId);
      rerender(); // service 在第一个 await 前已发布乐观 sessionIds。
      void Promise.resolve(settled).then(() => rerender());
      return;
    }
    orderStore?.reorder?.(movedId, beforeId, section.allIds);
    rerender();
  }

  // 行拖拽。状态档下禁用:那个顺序是算出来的,拖了也会被下一次渲染算回去
  //(对齐 macOS 的 .moveDisabled(orderBy == "status"))。置顶区例外 ——
  // 它本来就不按排序档排,状态档下照样可以手摆。
  mountHistoryDrag(list, {
    enabled: (groupId) => groupId === PINNED_GROUP_ID || orderBy !== SessionOrderBy.status,
    visibleIds: () => [...list.querySelectorAll(".history-item")].map((row) => row.dataset.sessionId),
    onDrop(movedId, overId, after, groupId) {
      const section = (sections() ?? []).find((item) => item.id === groupId);
      if (!section) return;
      const visible = section.rows.map((item) => item.sessionId);
      // full 传全量:落在最后一条渲染行之后、而后面还有折叠行时,锚点要取
      // 第一条折叠行,而不是当成"移到末尾"。
      const move = resolveReorder({ movedId, overId, after, visible, full: section.allIds });
      if (!move) return;
      commitMove(groupId, move.movedId, move.beforeId);
    }
  });

  return {
    orderBy: () => orderBy,
    groupBy: () => groupBy,
    /// 状态档下不让拖(置顶区在 mountHistoryDrag 的 enabled 里单独放行)。
    isDraggable: () => orderBy !== SessionOrderBy.status,
    collapsedIds: () => [...collapsed],
    expandedIds: () => [...expanded],
    /// 折叠/展开一个分组。折叠态持久化(Mac 的 per-workspace UserDefaults 单元)。
    toggleCollapsed(groupId) {
      if (!groupId) return;
      if (collapsed.has(groupId)) collapsed.delete(groupId);
      else collapsed.add(groupId);
      persistCollapsed();
      rerender();
    },
    /// 「展开其余 N 个」/「收起」。
    toggleExpanded(groupId) {
      if (!groupId) return;
      if (expanded.has(groupId)) expanded.delete(groupId);
      else expanded.add(groupId);
      rerender();
    },
    /// 每次重画后把常驻的触发钮搬回分区标题行(搬而不是重建:popover 的
    /// 锚点与事件绑定都挂在这两个节点上)。
    mountInto(host) {
      if (!host) return;
      host.append(trigger, menu, addWorkspace);
    },
    /// 视图选项菜单是否正开着。开着时调用方应改为 deferRepaint(见上面的说明)。
    isMenuOpen: menuIsOpen,
    deferRepaint(options) { pendingRepaint = options ?? pendingRepaint ?? {}; },
    relabel: paint,
    ready
  };
}
