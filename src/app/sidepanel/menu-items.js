// popover 菜单构建(模型/权限/技能/工作目录共用)。
//
// 从 sidepanel-overlays.js 抽出来:那个文件承载的是"历史浮层"这一个界面,
// 而这里是一套**被四个不同菜单复用**的通用渲染器 —— 两者的变更理由不同,
// 合在一处也把那个文件顶过了 400 行的硬上限。
import { escapeHtml } from "../../shared/md-to-html.js";
import { lucideIconSvg } from "../../features/chat/file-icons.js";

// popover 菜单构建(模型/权限/技能共用)。
/// @param onReorder 给出后,标了 draggable 的条目可拖拽重排,回调形如
///        (movedId, beforeId|null)。不给则完全维持原有行为(不加任何属性、不绑事件)。
/// @param selectedIds 一个菜单里有**多根轴**时用它(会话列表的视图选项:分组 + 排序
///        各选一项)。与 selectedId 并存,两者命中任意一个就打勾。
export function renderMenuItems(container, entries, {
  selectedId, selectedIds, onSelect, groupBy, emptyText, onReorder
}) {
  if (!entries.length) {
    container.innerHTML = emptyText
      ? `<div class="menu-empty">${escapeHtml(emptyText)}</div>`
      : "";
    container.onclick = null;
    return;
  }
  const marked = new Set(selectedIds ?? []);
  const isSelected = (id) => id === selectedId || marked.has(id);
  const groups = new Map();
  for (const entry of entries) {
    const key = groupBy ? groupBy(entry) : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  container.innerHTML = [...groups.entries()].map(([group, items]) => (
    (group ? `<div class="menu-group-label">${escapeHtml(group)}</div>` : "")
    + items.map((item) => (
      `<button type="button" class="menu-item${isSelected(item.id) ? " selected" : ""}" data-item-id="${escapeHtml(item.id)}"${onReorder && item.draggable ? ' draggable="true"' : ""}>`
      + (item.icon ? `<span class="menu-item-icon">${lucideIconSvg(item.icon, { size: 14 })}</span>` : "")
      + `<span>${escapeHtml(item.label)}</span>${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}`
      + `</button>`
    )).join("")
  )).join("");
  container.onclick = (event) => {
    const button = event.target.closest("[data-item-id]");
    if (button) onSelect(button.dataset.itemId);
  };
  if (onReorder) mountMenuDrag(container, entries, onReorder);
}

/// 菜单条目的拖拽重排。与历史行同一套手法:落点按上下半区判定,
/// 并且**必须 stopPropagation** —— window 上的 drop-zone 正等着接图片。
function mountMenuDrag(container, entries, onReorder) {
  const draggableIds = new Set(entries.filter((item) => item.draggable).map((item) => item.id));
  let movedId = null;
  const itemOf = (target) => target?.closest?.("[data-item-id]") ?? null;
  const clear = () => {
    for (const el of container.querySelectorAll("[data-item-id]")) {
      el.classList.remove("drop-before", "drop-after", "dragging");
    }
  };
  container.ondragstart = (event) => {
    const item = itemOf(event.target);
    const id = item?.dataset.itemId;
    if (!id || !draggableIds.has(id)) return;
    movedId = id;
    event.stopPropagation();
    item.classList.add("dragging");
    event.dataTransfer?.setData("application/x-dsh-workspace", id);
  };
  container.ondragover = (event) => {
    if (!movedId) return;
    event.stopPropagation();
    event.preventDefault();
    const item = itemOf(event.target);
    clear();
    if (!item || !draggableIds.has(item.dataset.itemId) || item.dataset.itemId === movedId) return;
    const box = item.getBoundingClientRect();
    item.classList.add(event.clientY > box.top + box.height / 2 ? "drop-after" : "drop-before");
  };
  container.ondrop = (event) => {
    if (!movedId) return;
    event.stopPropagation();
    event.preventDefault();
    const item = itemOf(event.target);
    const moved = movedId;
    movedId = null;
    clear();
    const overId = item?.dataset.itemId ?? null;
    if (!overId || !draggableIds.has(overId) || overId === moved) return;
    const box = item.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    // 锚点是"插到谁前面":落在下半区就插到下一个可拖条目之前。
    const ordered = [...draggableIds].filter((id) => id !== moved);
    const overIndex = ordered.indexOf(overId);
    const insertAt = after ? overIndex + 1 : overIndex;
    onReorder(moved, insertAt >= ordered.length ? null : ordered[insertAt]);
  };
  container.ondragend = () => { movedId = null; clear(); };
}
