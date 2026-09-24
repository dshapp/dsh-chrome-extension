// 会话列表的"按住期间不重画"。
//
// 列表每次重画都是整块 innerHTML,流式会话期间一秒好几次。两种交互经不起
// 节点在手底下被换掉:
//
// - **按下**:mousedown 与 mouseup 落在新旧两份节点上,浏览器就把 click 派发到
//   它们的公共祖先 <ul> —— 分组标题、会话行统统"点了没反应"。松手后放到下一个
//   任务再画:click 与 pointerup 在同一个任务里派发,同步重画会赶在 click 之前
//   把目标换掉,等于没修。
// - **拖拽**:被拖的节点一旦被换掉,dragend 落在游离节点上、冒不到列表,拖拽状态
//   卡死;落点提示也会随每帧重画闪没。所以整个拖拽期间都不重画。
//
// 两个原因各自一个标记:拖拽开始时浏览器会发 pointercancel,不能让它提前放行。

/**
 * @param {Element} list 会被整块重画的列表容器。
 * @param {(options: {resetSelection: boolean}) => void} repaint 放行后补画一次。
 * @returns {{ held: () => boolean, defer: (options?: {resetSelection?: boolean}) => void }}
 */
export function createRepaintHold(list, repaint) {
  let pointerHeld = false;
  let dragHeld = false;
  let pending = null;
  const held = () => pointerHeld || dragHeld;

  function flush() {
    if (held() || !pending) return;
    const options = pending;
    pending = null;
    setTimeout(() => repaint(options), 0);
  }
  const releasePointer = () => { if (pointerHeld) { pointerHeld = false; flush(); } };
  const releaseDrag = () => { if (dragHeld) { dragHeld = false; flush(); } };

  list.addEventListener("pointerdown", (event) => { if (event.button === 0) pointerHeld = true; });
  list.addEventListener("dragstart", () => { dragHeld = true; });
  // 挂在 window 捕获阶段:松手可能在列表外,而 history-drag 在列表上
  // stopPropagation 了拖拽事件。
  for (const type of ["pointerup", "pointercancel", "blur"]) window.addEventListener(type, releasePointer, true);
  for (const type of ["dragend", "drop", "blur"]) window.addEventListener(type, releaseDrag, true);

  return {
    held,
    /// 攒一次重画;多次合并,只要有一次要求 resetSelection 就保留。
    defer({ resetSelection = false } = {}) {
      pending = { resetSelection: resetSelection || Boolean(pending?.resetSelection) };
    }
  };
}
