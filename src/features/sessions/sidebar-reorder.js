// 把一次拖放解析成 insert-before 锚点。
//
// 从 macOS 的 SidebarReorder.swift 照搬。核心取舍:**用 id 当锚点,不用下标**。
//
// 历史浮层只渲染前 MAX_RENDERED_ROWS(500)行,超出的折叠成一行提示。下标是
// 相对"渲染出来的那些行"的,直接拿去改整个列表会对错数组 —— 而 id 在哪个
// 子集里都指同一个会话。宿主的两个排序 RPC(workspace.insertBefore /
// insertSessionBefore)收的也正是 before-id 这种形状,所以这层解析出来的东西
// 可以原样送上去。

/**
 * 解析一次拖放。
 *
 * @param {string} movedId  被拖动的行 id。
 * @param {string|null} overId 落点所在行的 id(拖到列表末尾空白处时为 null)。
 * @param {boolean} after   落在 overId 那一行的下半部分(即插到它**后面**)。
 * @param {string[]} visible 当前渲染出来的行 id,按显示顺序。
 * @param {string[]} full    完整列表的行 id,按显示顺序;visible 是它的前缀。
 * @returns {{movedId: string, beforeId: string|null}|null}
 *          要提交的移动;拖回原位等无效操作返回 null。
 */
export function resolveReorder({ movedId, overId, after = false, visible = [], full = null }) {
  const rows = [...visible];
  const complete = full ?? rows;
  const from = rows.indexOf(movedId);
  if (from === -1) return null;
  // 拖到自己身上不是移动。
  if (overId === movedId) return null;

  // 先算出这一拖之后,列表**应该**长什么样,再从结果里读锚点 ——
  // 直接由 overId/after 推锚点要分四五种边界情况讨论,而"先移动再读邻居"
  // 只有一种。
  const next = rows.filter((id) => id !== movedId);
  let insertAt;
  if (overId === null) {
    insertAt = next.length;                       // 拖到末尾空白处
  } else {
    const overIndex = next.indexOf(overId);
    if (overIndex === -1) return null;
    insertAt = after ? overIndex + 1 : overIndex;
  }
  next.splice(insertAt, 0, movedId);
  // 顺序没变:拖回了原位,不必打扰宿主。
  if (next.every((id, i) => id === rows[i])) return null;

  const landed = next.indexOf(movedId);
  let beforeId;
  if (landed + 1 < next.length) {
    beforeId = next[landed + 1];
  } else if (complete.length > rows.length) {
    // 落在最后一条**渲染出来的**行之后,但后面还有折叠起来的行:
    // 锚点取第一条折叠行 —— 重排一个前缀不会动到它后面的任何东西。
    beforeId = complete[rows.length];
  } else {
    beforeId = null;                              // 真的到末尾了
  }
  return { movedId, beforeId };
}

/**
 * 把一次移动应用到一份 id 顺序上(纯数组操作,给本地账本用)。
 *
 * @param {string[]} order 原顺序。
 * @param {string} movedId 被移动的 id。
 * @param {string|null} beforeId 插到谁前面;null 表示追加到末尾。
 * @returns {string[]} 新顺序。
 */
export function applyMove(order, movedId, beforeId) {
  const next = [...(order ?? [])].filter((id) => id !== movedId);
  const at = beforeId == null ? -1 : next.indexOf(beforeId);
  if (at === -1) next.push(movedId);
  else next.splice(at, 0, movedId);
  return next;
}
