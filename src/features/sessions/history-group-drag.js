// 历史列表的分组拖拽:拖动工作区的分组标题,上下调整分组顺序。
//
// 对齐 macOS SidebarRoot 的 WorkspaceGroupDrag / WorkspaceSection:
//
// - **只有标题能拖**。整组(含会话行)可拖的话,行自己的拖拽重排就被抢走了 ——
//   Mac 那边正是因为 `.draggable()` 盖住整个 Section 吞掉了行的点击,才收回到
//   只挂在标题上。
// - **只有真实 workspace 参与**。置顶区与「未分组」桶不是 workspace,宿主的
//   workspace/insertBefore 也不认它们;但把组拖到「未分组」上面等于"移到最后",
//   这里照收,提交成 before = null(Mac 让最后一个标题的下沿承担这个落点)。
// - **落点按整组算**,不是只认标题:组展开时标题只是一条细线,用户往往把它
//   扔在组内的会话行上。落在组的上半 = 插到它前面,下半 = 插到它后面。
// - 顺序写宿主(workspace/insertBefore),乐观更新与失败回滚由 workspace
//   service 负责 —— 纯本地重排会被 workspace/follow 的下一份 baseline 打回原形。
//
// 与 history-drag.js 一样,每个处理函数都 stopPropagation:window 上的
// attachments drop-zone 会把冒上去的 dragover 当成"拖进了文件"。

import { resolveReorder } from "./sidebar-reorder.js";

const GROUP_DRAG_MIME = "application/x-dsh-workspace";
const HEADER_SELECTOR = '.history-group[data-group-kind="workspace"]';
const MARKER_CLASSES = ["group-drop-before", "group-drop-after", "group-dragging"];

/**
 * 给会话列表挂上分组拖拽。
 *
 * @param {Element} list 承载分组标题与会话行的 <ul>。
 * @param {object} options
 * @param {() => boolean} options.enabled 当前是否允许拖分组(单列表 / 搜索态下关掉)。
 * @param {(movedId: string, beforeId: string|null) => void} options.onDrop
 *        落下时回调:把 movedId 插到 beforeId 之前,null = 移到最后。
 * @returns {() => void} 卸载函数。
 */
export function mountHistoryGroupDrag(list, { enabled, onDrop }) {
  if (!list) return () => {};
  let draggingId = null;

  const workspaceIds = () => [...list.querySelectorAll(HEADER_SELECTOR)].map((node) => node.dataset.groupId);
  const blockOf = (groupId) => [...list.querySelectorAll(`[data-group-id="${CSS.escape(groupId)}"]`)];

  function clearMarkers() {
    for (const node of list.querySelectorAll(MARKER_CLASSES.map((name) => `.${name}`).join(","))) {
      node.classList.remove(...MARKER_CLASSES);
    }
  }

  /// 指针下面是哪个落点:{ overId, after, marker, markerClass };不接受时返回 null。
  function targetAt(event) {
    const node = event.target?.closest?.("[data-group-id]");
    if (!node || !list.contains(node)) return null;
    const groupId = node.dataset.groupId;
    const header = list.querySelector(`.history-group[data-group-id="${CSS.escape(groupId)}"]`);
    if (!header) return null;
    const kind = header.dataset.groupKind;
    // 「未分组」永远排在所有 workspace 之后:落在它上面 = 移到最后。
    if (kind === "ungrouped") return { overId: null, after: false, marker: header, markerClass: "group-drop-before" };
    if (kind !== "workspace") return null;
    const block = blockOf(groupId);
    const top = block[0].getBoundingClientRect().top;
    const bottom = block[block.length - 1].getBoundingClientRect().bottom;
    const after = event.clientY > (top + bottom) / 2;
    return after
      ? { overId: groupId, after, marker: block[block.length - 1], markerClass: "group-drop-after" }
      : { overId: groupId, after, marker: header, markerClass: "group-drop-before" };
  }

  function onDragStart(event) {
    const header = event.target?.closest?.(HEADER_SELECTOR);
    if (!header || !enabled()) return;
    draggingId = header.dataset.groupId || null;
    if (!draggingId) return;
    event.stopPropagation();
    header.classList.add("group-dragging");
    event.dataTransfer?.setData(GROUP_DRAG_MIME, draggingId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(event) {
    if (!draggingId) return;
    event.stopPropagation();
    event.preventDefault();
    clearMarkers();
    blockOf(draggingId)[0]?.classList.add("group-dragging");
    const target = targetAt(event);
    if (event.dataTransfer) event.dataTransfer.dropEffect = target ? "move" : "none";
    // 落在自己身上不给提示:松手不会有任何变化。
    if (!target || target.overId === draggingId) return;
    target.marker.classList.add(target.markerClass);
  }

  function handleDrop(event) {
    if (!draggingId) return;
    event.stopPropagation();
    event.preventDefault();
    const moved = draggingId;
    draggingId = null;
    const target = targetAt(event);
    clearMarkers();
    if (!target) return;
    const move = resolveReorder({ movedId: moved, overId: target.overId, after: target.after, visible: workspaceIds() });
    if (move) onDrop(move.movedId, move.beforeId);
  }

  function onDragEnd(event) {
    if (!draggingId) return;
    event.stopPropagation();
    draggingId = null;
    clearMarkers();
  }

  function onDragLeave(event) {
    if (!draggingId) return;
    event.stopPropagation();
    if (!list.contains(event.relatedTarget)) clearMarkers();
  }

  list.addEventListener("dragstart", onDragStart);
  list.addEventListener("dragover", onDragOver);
  list.addEventListener("drop", handleDrop);
  list.addEventListener("dragend", onDragEnd);
  list.addEventListener("dragleave", onDragLeave);
  return () => {
    list.removeEventListener("dragstart", onDragStart);
    list.removeEventListener("dragover", onDragOver);
    list.removeEventListener("drop", handleDrop);
    list.removeEventListener("dragend", onDragEnd);
    list.removeEventListener("dragleave", onDragLeave);
  };
}
