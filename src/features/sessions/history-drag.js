// 历史列表的行拖拽。
//
// 单独成模块有两个原因:sidepanel-overlays.js 已经 409 行,再塞进去会撞上
// 工程约束的行数上限;而且拖拽是一套完整的、可独立测试的交互(拖起—经过—落下),
// 和浮层的渲染/筛选/键盘导航没有共享状态。
//
// 一个必须处理的冲突:attachments/drop-zone.js 在 window 上监听 dragover 用来
// 接收拖入的图片,而且会 preventDefault 把它吞掉。行内拖拽的事件如果冒泡上去,
// 会被当成"用户拖着文件进来了",于是整个侧栏亮起蓝色的落图提示。所以本模块的
// 每个处理函数都 stopPropagation —— 这是最容易踩、也最难查的一个坑。

const DRAG_MIME = "application/x-dsh-session";

/**
 * 给会话列表挂上拖拽重排。
 *
 * **一次拖拽不跨组。** 列表现在分成置顶区、各 workspace 组与未分组桶,每组的
 * 顺序写进不同的账本(置顶账本 / 宿主 insertSessionBefore / 浏览器本地手动序)。
 * 跨组落下没有"要写哪本"的答案,所以直接不接受 —— 与 Mac 的 `.onMove` 只在
 * 同一个 ForEach 内生效是同一条规矩。
 *
 * @param {Element} list 承载 .history-item 行的 <ul>。
 * @param {object} options
 * @param {(groupId: string|null) => boolean} options.enabled 这一组当前是否允许拖拽
 *        (状态排序档要关掉,置顶区例外)。
 * @param {() => string[]} options.visibleIds 当前渲染出来的行 id,按显示顺序。
 * @param {(movedId: string, overId: string|null, after: boolean, groupId: string|null) => void} options.onDrop
 *        落下时回调,由调用方去解析锚点并提交。
 * @returns {() => void} 卸载函数。
 */
export function mountHistoryDrag(list, { enabled, visibleIds, onDrop }) {
  if (!list) return () => {};
  let draggingId = null;
  let draggingGroupId = null;

  /// 事件发生在哪一行上。行内的按钮(分叉/重命名/归档)也要能命中所属的行。
  const rowOf = (target) => target?.closest?.(".history-item") ?? null;

  /// 清掉所有落点提示。行是每次 render 重建的,所以这里按类名扫,
  /// 不缓存元素引用 —— 缓存的那个可能已经被换掉了。
  function clearMarkers() {
    for (const row of list.querySelectorAll(".history-item")) {
      row.classList.remove("drop-before", "drop-after", "dragging");
    }
  }

  function onDragStart(event) {
    const row = rowOf(event.target);
    if (!row) return;
    if (!enabled(row.dataset.groupId ?? null)) return;
    draggingId = row.dataset.sessionId || null;
    draggingGroupId = row.dataset.groupId ?? null;
    if (!draggingId) return;
    event.stopPropagation();
    row.classList.add("dragging");
    // 必须写点数据,否则 Firefox/部分 Chrome 版本不认这是一次有效拖拽。
    // 用私有 MIME 而不是 text/plain:这样拖到别处(输入框、地址栏)不会
    // 意外粘出一串 session id。
    event.dataTransfer?.setData(DRAG_MIME, draggingId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(event) {
    if (!draggingId) return;
    // 关键:不让事件冒到 window —— 那里 drop-zone 正等着接收拖入的图片。
    event.stopPropagation();
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const row = rowOf(event.target);
    clearMarkers();
    list.querySelector(`.history-item[data-session-id="${CSS.escape(draggingId)}"]`)?.classList.add("dragging");
    if (!row || row.dataset.sessionId === draggingId) return;
    // 跨组不给落点提示:那条线会让人以为松手能把会话搬到别的工作区里去。
    if ((row.dataset.groupId ?? null) !== draggingGroupId) return;
    // 落在行的上半还是下半,决定插到它前面还是后面。
    const box = row.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    row.classList.add(after ? "drop-after" : "drop-before");
  }

  /// 提交一次落下。只在被拖的行确实还在当前可见集合里时才上报 ——
  /// 拖拽过程中列表可能被后台帧重画过。
  function commit(movedId, overId, after, groupId) {
    if (visibleIds().includes(movedId)) onDrop(movedId, overId, after, groupId);
  }

  function handleDrop(event) {
    if (!draggingId) return;
    event.stopPropagation();
    event.preventDefault();
    const row = rowOf(event.target);
    const moved = draggingId;
    const group = draggingGroupId;
    draggingId = null;
    draggingGroupId = null;
    clearMarkers();
    // 落在列表空白处 = 移到本组末尾。
    if (!row) { commit(moved, null, false, group); return; }
    // 跨组落下不提交(见函数头的说明)。
    if ((row.dataset.groupId ?? null) !== group) return;
    const overId = row.dataset.sessionId || null;
    if (!overId || overId === moved) return;
    const box = row.getBoundingClientRect();
    commit(moved, overId, event.clientY > box.top + box.height / 2, group);
  }

  function onDragEnd(event) {
    event.stopPropagation();
    draggingId = null;
    draggingGroupId = null;
    clearMarkers();
  }

  list.addEventListener("dragstart", onDragStart);
  list.addEventListener("dragover", onDragOver);
  list.addEventListener("drop", handleDrop);
  list.addEventListener("dragend", onDragEnd);
  // 拖出列表范围时也要把提示清掉,否则残留一条蓝线。
  list.addEventListener("dragleave", (event) => {
    event.stopPropagation();
    if (!list.contains(event.relatedTarget)) clearMarkers();
  });

  return () => {
    list.removeEventListener("dragstart", onDragStart);
    list.removeEventListener("dragover", onDragOver);
    list.removeEventListener("drop", handleDrop);
    list.removeEventListener("dragend", onDragEnd);
  };
}
