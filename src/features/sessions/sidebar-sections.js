// 侧栏会话列表的分区派生:置顶区 + (按工作区分组 | 单列表)。
//
// 纯函数,不碰 DOM、不读 storage —— 视图层(session-drawer-view.js)只负责把
// 这里算出来的 sections 画出来,快捷键与拖拽都读同一份 renderedIds。
//
// 规则逐条对齐 macOS 的 SidebarRoot(SessionTreeView / FlatSessionList /
// WorkspaceSection / PinnedSessionList):
//
// 1. **可见性**(Mac `sessionVisible`):子代理会话不进列表、归档行不进列表,
//    空白(blank)行只有在它就是当前会话时才出现 —— 否则每建一个新会话都会
//    在列表里留下一行"什么都没发生过"的幽灵。
// 2. **置顶优先于分组**:置顶是用户明确摆出来的安排,所以它排在两种分组模式
//    之上,并且被置顶的行不再出现在下面的分组里(否则同一行会出现两次)。
// 3. **折叠组只画前 5 行**(Mac `collapsedGroupRowLimit`),其余折进
//    「展开其余 N 个会话」。
// 4. **组内排序**:updated → 时间倒序;status → 注意力档位;manual → 真实
//    workspace 用宿主给的 sessionIds 顺序(那就是它的手动序),未分组/单列表
//    用浏览器本地账本。
//
// 分组本身不参与排序档:orderBy 只决定**组内**的行怎么排(Mac 的取舍)。

/// 折叠状态下每个分组最多画几行(Mac SessionQuickSwitch.collapsedGroupRowLimit)。
export const COLLAPSED_GROUP_ROW_LIMIT = 5;

/// 单列表模式一次最多画几行。Mac 的单列表不截断 —— 那是一个会自己虚拟化的
/// 原生 List;这里每次重画都是整块 innerHTML,上千行会让流式输出期间的每一帧
/// 都重建上千个节点。超出的部分报一行"继续输入以筛选",与搜索结果同一条规矩。
export const FLAT_ROW_LIMIT = 500;

/// 不属于任何 workspace 的那一桶。id 同时用作折叠状态的 key,所以取一个
/// 不可能与 workspaceId 撞车的名字。
export const UNGROUPED_GROUP_ID = "__ungrouped__";
/// 置顶区与单列表模式各自的组 id。行拖拽按组 id 判定"能不能落在这里"。
export const PINNED_GROUP_ID = "__pinned__";
export const FLAT_GROUP_ID = "__flat__";

/// 分组轴的两个取值(Mac SidebarViewOptions.groupBy)。
export const SidebarGroupBy = Object.freeze({
  workspace: "workspace",
  flat: "flat"
});

/**
 * 名册里该出现在侧栏的那些行。
 *
 * @param {Array} sessions 全量名册。
 * @param {object} options
 * @param {Set<string>|Array<string>} options.archivedIds 已归档的会话。
 * @param {string|null} options.activeSessionId 当前打开的会话(决定唯一可见的空白行)。
 * @returns {Array} 可见行(保持传入顺序)。
 */
export function visibleSessions(sessions, { archivedIds = [], activeSessionId = null } = {}) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? []);
  return (sessions ?? []).filter((item) => item
    && item.origin !== "subagent"
    && !archived.has(item.sessionId)
    && (!item.blank || item.sessionId === activeSessionId));
}

/// 默认排序器:没有注入 listStore.sortBy 时(测试/极早首帧)按时间倒序。
function defaultSort(rows) {
  return [...rows].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

/**
 * 把可见名册切成侧栏要画的那几段。
 *
 * @param {object} options
 * @param {Array} options.sessions 全量名册(未过滤)。
 * @param {Array} options.workspaces 宿主的 workspace 列表(含 sessionIds / title / path)。
 * @param {Array<string>} options.archivedIds 已归档会话 id。
 * @param {Array<string>} options.pinnedIds 置顶账本(按置顶顺序)。
 * @param {string} options.groupBy SidebarGroupBy 之一。
 * @param {string} options.orderBy SessionOrderBy 之一。
 * @param {Array<string>} options.collapsedGroupIds 已折叠的分组。
 * @param {Array<string>} options.expandedGroupIds 已「展开其余」的分组。
 * @param {string|null} options.activeSessionId 当前会话。
 * @param {(rows: Array, orderBy: string, workspaceSessionIds: Array<string>|null) => Array} [options.sortRows]
 *        组内排序器,通常注入 listStore.sortBy。
 * @param {number} [options.rowLimit] 折叠时每组画几行(测试可调)。
 * @returns {{sections: Array, renderedIds: Array<string>}}
 */
export function buildSidebarSections({
  sessions = [],
  workspaces = [],
  archivedIds = [],
  pinnedIds = [],
  groupBy = SidebarGroupBy.workspace,
  orderBy = "updated",
  collapsedGroupIds = [],
  expandedGroupIds = [],
  activeSessionId = null,
  sortRows = null,
  rowLimit = COLLAPSED_GROUP_ROW_LIMIT
} = {}) {
  const sort = typeof sortRows === "function" ? sortRows : defaultSort;
  const collapsed = new Set(collapsedGroupIds ?? []);
  const expanded = new Set(expandedGroupIds ?? []);
  const visible = visibleSessions(sessions, { archivedIds, activeSessionId });
  const byId = new Map(visible.map((item) => [item.sessionId, item]));

  // 置顶区:按账本顺序,不受 orderBy 影响 —— 那个顺序是用户自己摆的。
  const pinnedOrder = (pinnedIds ?? []).filter((id) => byId.has(id));
  const pinnedSet = new Set(pinnedOrder);
  const rest = visible.filter((item) => !pinnedSet.has(item.sessionId));

  const sections = [];
  if (pinnedOrder.length) {
    sections.push(section({
      kind: "pinned",
      id: PINNED_GROUP_ID,
      title: null,             // 标题由视图按 i18n 取,派生层不碰文案
      rows: pinnedOrder.map((id) => byId.get(id)),
      collapsed: collapsed.has(PINNED_GROUP_ID),
      expanded: true,          // 置顶区是一小撮手挑的行,不做 show-more 截断
      rowLimit: Infinity
    }));
  }

  if (groupBy === SidebarGroupBy.flat) {
    // 单列表:所有行一视同仁,没有分组也没有"展开其余"——只有一条渲染上限
    // 兜底(见 FLAT_ROW_LIMIT)。
    sections.push(section({
      kind: "flat",
      id: FLAT_GROUP_ID,
      title: null,
      rows: sort(rest, orderBy, null),
      collapsed: false,
      expanded: false,
      rowLimit: FLAT_ROW_LIMIT
    }));
  } else {
    const claimed = new Set();
    for (const workspace of workspaces ?? []) {
      const memberIds = workspace?.sessionIds ?? [];
      for (const id of memberIds) claimed.add(id);
      // 宿主的 sessionIds 就是这个 workspace 的手动序,所以先按它取行,
      // 再按当前排序档重排(manual 档下这一步原样返回)。
      const rows = memberIds.map((id) => byId.get(id)).filter((item) => item && !pinnedSet.has(item.sessionId));
      const groupId = workspace.workspaceId;
      sections.push(section({
        kind: "workspace",
        id: groupId,
        workspaceId: groupId,
        title: workspace.title || basename(workspace.path),
        hint: workspace.path ?? null,
        rows: sort(rows, orderBy, memberIds),
        collapsed: collapsed.has(groupId) && !containsActive(rows, activeSessionId),
        expanded: expanded.has(groupId),
        rowLimit
      }));
    }
    const ungrouped = rest.filter((item) => !claimed.has(item.sessionId));
    if (ungrouped.length) {
      sections.push(section({
        kind: "ungrouped",
        id: UNGROUPED_GROUP_ID,
        title: null,
        rows: sort(ungrouped, orderBy, null),
        collapsed: collapsed.has(UNGROUPED_GROUP_ID) && !containsActive(ungrouped, activeSessionId),
        expanded: expanded.has(UNGROUPED_GROUP_ID),
        rowLimit
      }));
    }
  }

  // 渲染序 = 快捷键序:⌘K+数字、↑/↓、⌘[/⌘] 都走这一份,永远指向屏幕上真有的行。
  const renderedIds = sections.flatMap((item) => item.rows.map((row) => row.sessionId));
  return { sections, renderedIds };
}

/// 组装一段分区:把"折叠/截断"这件事在这里算完,视图只管画。
function section({ kind, id, workspaceId = null, title, hint = null, rows, collapsed, expanded, rowLimit }) {
  const all = rows ?? [];
  const limited = collapsed
    ? []
    : (expanded || all.length <= rowLimit ? all : all.slice(0, rowLimit));
  return {
    kind,
    id,
    workspaceId,
    title,
    hint,
    rows: limited,
    // 这一组的**完整**成员(含被折叠/截断掉的),拖拽解析锚点时要用:
    // 落在最后一条可见行之后、而后面还有折起来的行时,锚点取第一条折叠行。
    allIds: all.map((item) => item.sessionId),
    total: all.length,
    hiddenCount: collapsed ? 0 : all.length - limited.length,
    collapsed,
    expanded: Boolean(expanded)
  };
}

/// 含当前会话的那个组不许保持折叠(Mac `containsCurrent`):用户刚打开的
/// 会话藏在一个折起来的组里,列表看上去就像"我的会话不见了"。
function containsActive(rows, activeSessionId) {
  if (!activeSessionId) return false;
  return rows.some((item) => item.sessionId === activeSessionId);
}

function basename(path) {
  return String(path || "").replace(/\/+$/, "").split("/").pop() || String(path || "");
}
