// 侧栏会话列表的分区派生:置顶区 + (按工作区分组 | 单列表)。
//
// 纯函数,不碰 DOM、不读 storage —— 视图层(session-drawer-view.js)只负责把
// 这里算出来的 sections 画出来,快捷键与拖拽都读同一份 renderedIds。
//
// 规则逐条对齐 macOS 的 SidebarRoot(SessionTreeView / FlatSessionList /
// WorkspaceSection / PinnedSessionList):
//
// 1. **可见性**(Mac `sessionVisible`):子代理会话不进列表;归档行按视图选项里的
//    「筛选会话」取舍(默认隐藏 / 一并显示 / 只显示归档);空白(blank)行只有在
//    它就是当前会话时才出现 —— 否则每建一个新会话都会在列表里留下一行"什么都
//    没发生过"的幽灵。
// 2. **置顶优先于分组**:置顶是用户明确摆出来的安排,所以它排在两种分组模式
//    之上,并且被置顶的行不再出现在下面的分组里(否则同一行会出现两次)。
// 3. **折叠组只画前 5 个闲置行**(Mac `collapsedGroupRowLimit`),其余折进
//    「展开其余 N 个会话」;空白、运行中、有子代理在跑的行不占名额、始终显示
//    (web `collapsedSessionRows` / Mac `SessionQuickSwitch.collapsedRows`)。
// 4. **组内排序**:updated → 时间倒序;status → 注意力档位;manual → 真实
//    workspace 用宿主给的 sessionIds 顺序(那就是它的手动序),未分组/单列表
//    用浏览器本地账本。
//
// 分组本身不参与排序档:orderBy 只决定**组内**的行怎么排(Mac 的取舍)。
//
// 组标题:落在用户 home 的工作区显示为 homeLabel(默认 "Home"),而不是用户名或
// 整条 C:\Users\<name>;文案由调用方传入,这一层仍不碰 i18n。

import { workspaceDisplayName, DEFAULT_HOME_LABEL } from "../../shared/workspace-path.js";

/// 折叠状态下每个分组最多画几个闲置行(Mac SessionQuickSwitch.collapsedGroupRowLimit)。
export const COLLAPSED_GROUP_ROW_LIMIT = 5;

/**
 * 「展开其余」折叠:只有闲置行计入 limit;空白、运行中、子代理在跑的父会话
 * 始终留下,活着的工作绝不藏在「展开其余」后面。保持原顺序(渲染行是完整
 * 成员的有序子集,不一定是前缀)。对齐 web `collapsedSessionRows` 与 Mac
 * `SessionQuickSwitch.collapsedRows`。
 *
 * @param {Array} rows 组内已排好序的行。
 * @param {number} limit 闲置行名额。
 * @param {(item: object) => boolean} [isLive] 额外判定"有子代理在跑"(行本身可能闲置)。
 * @returns {Array} 要画的行。
 */
export function collapsedRows(rows, limit, isLive = null) {
  let idle = 0;
  return rows.filter((item) => {
    if (item.blank || item.running || isLive?.(item)) return true;
    if (idle >= limit) return false;
    idle += 1;
    return true;
  });
}

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

/// 「筛选会话」轴的三个取值(Mac SidebarViewOptions.archivedFilter,同名同值):
/// hide 隐藏归档行(默认)、show 归档行与其余会话一起列出、only 只列归档行。
export const ArchivedFilter = Object.freeze({
  hide: "default",
  show: "show",
  only: "only"
});

/// 一行在当前筛选下是否该出现(Mac SidebarViewOptions.archivedVisible)。
export function archivedVisible(isArchived, filter = ArchivedFilter.hide) {
  if (filter === ArchivedFilter.show) return true;
  if (filter === ArchivedFilter.only) return isArchived;
  return !isArchived;
}

/**
 * 名册里该出现在侧栏的那些行。归档行带上 archived:true,视图据此把它画成
 * 只能「取消归档」的暗行。
 *
 * @param {Array} sessions 全量名册(筛选要显示归档时,调用方把归档摘要并进来)。
 * @param {object} options
 * @param {Set<string>|Array<string>} options.archivedIds 已归档的会话。
 * @param {string|null} options.activeSessionId 当前打开的会话(决定唯一可见的空白行)。
 * @param {string} [options.archivedFilter] ArchivedFilter 之一,默认隐藏归档。
 * @returns {Array} 可见行(保持传入顺序)。
 */
export function visibleSessions(sessions, {
  archivedIds = [], activeSessionId = null, archivedFilter = ArchivedFilter.hide
} = {}) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? []);
  const rows = [];
  for (const item of sessions ?? []) {
    if (!item || item.origin === "subagent") continue;
    const isArchived = archived.has(item.sessionId);
    if (!archivedVisible(isArchived, archivedFilter)) continue;
    if (item.blank && item.sessionId !== activeSessionId) continue;
    rows.push(isArchived === Boolean(item.archived) ? item : { ...item, archived: isArchived });
  }
  return rows;
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
 * @param {string} [options.archivedFilter] ArchivedFilter 之一:归档行隐藏 / 一并显示 / 只显示。
 * @param {Array<string>} options.pinnedIds 置顶账本(按置顶顺序)。
 * @param {string} options.groupBy SidebarGroupBy 之一。
 * @param {string} options.orderBy SessionOrderBy 之一。
 * @param {Array<string>} options.collapsedGroupIds 已折叠的分组。
 * @param {Array<string>} options.expandedGroupIds 已「展开其余」的分组。
 * @param {string|null} options.activeSessionId 当前会话。
 * @param {(rows: Array, orderBy: string, workspaceSessionIds: Array<string>|null) => Array} [options.sortRows]
 *        组内排序器,通常注入 listStore.sortBy。
 * @param {(sessionId: string) => boolean} [options.isRunningSubagentRoot]
 *        该会话是否有子代理后裔在跑,通常注入 listStore.isRunningSubagentRoot。
 * @param {number} [options.rowLimit] 折叠时每组画几个闲置行(测试可调)。
 * @param {string|null} [options.home] 宿主报的用户 home;为空时按平台目录形状判断。
 * @param {string} [options.homeLabel] home 工作区的组标题。
 * @returns {{sections: Array, renderedIds: Array<string>, activeGroupId: string|null}}
 */
export function buildSidebarSections({
  sessions = [],
  workspaces = [],
  archivedIds = [],
  archivedFilter = ArchivedFilter.hide,
  pinnedIds = [],
  groupBy = SidebarGroupBy.workspace,
  orderBy = "updated",
  collapsedGroupIds = [],
  expandedGroupIds = [],
  activeSessionId = null,
  sortRows = null,
  isRunningSubagentRoot = null,
  rowLimit = COLLAPSED_GROUP_ROW_LIMIT,
  home = null,
  homeLabel = DEFAULT_HOME_LABEL
} = {}) {
  const isLive = typeof isRunningSubagentRoot === "function"
    ? (item) => isRunningSubagentRoot(item.sessionId)
    : null;
  const sort = typeof sortRows === "function" ? sortRows : defaultSort;
  const collapsed = new Set(collapsedGroupIds ?? []);
  const expanded = new Set(expandedGroupIds ?? []);
  const visible = visibleSessions(sessions, { archivedIds, activeSessionId, archivedFilter });
  const byId = new Map(visible.map((item) => [item.sessionId, item]));

  // 置顶区:按账本顺序,不受 orderBy 影响 —— 那个顺序是用户自己摆的。
  // 归档行不进置顶区,留在它原来的组里(Mac pinnedSidebarSessions);只看归档时
  // 整个置顶区都不出现。
  const pinnedOrder = archivedFilter === ArchivedFilter.only
    ? []
    : (pinnedIds ?? []).filter((id) => byId.has(id) && !byId.get(id).archived);
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
      // 只看归档时,一行归档都没有的工作区不出组(Mac SessionTreeView.shownWorkspaces)。
      if (archivedFilter === ArchivedFilter.only && !rows.length) continue;
      const groupId = workspace.workspaceId;
      sections.push(section({
        kind: "workspace",
        id: groupId,
        workspaceId: groupId,
        title: workspaceDisplayName(workspace, { home, homeLabel }),
        hint: workspace.path ?? null,
        rows: sort(rows, orderBy, memberIds),
        collapsed: collapsed.has(groupId),
        expanded: expanded.has(groupId),
        rowLimit,
        isLive
      }));
    }
    const ungrouped = rest.filter((item) => !claimed.has(item.sessionId));
    if (ungrouped.length) {
      sections.push(section({
        kind: "ungrouped",
        id: UNGROUPED_GROUP_ID,
        title: null,
        rows: sort(ungrouped, orderBy, null),
        collapsed: collapsed.has(UNGROUPED_GROUP_ID),
        expanded: expanded.has(UNGROUPED_GROUP_ID),
        rowLimit,
        isLive
      }));
    }
  }

  // 渲染序 = 快捷键序:⌘K+数字、↑/↓、⌘[/⌘] 都走这一份,永远指向屏幕上真有的行。
  const renderedIds = sections.flatMap((item) => item.rows.map((row) => row.sessionId));
  return { sections, renderedIds, activeGroupId: activeGroupOf(sections, activeSessionId) };
}

/// 组装一段分区:把"折叠/截断"这件事在这里算完,视图只管画。
/// isLive 只给「展开其余」式的分组折叠用;单列表的 FLAT_ROW_LIMIT 是渲染上限
/// 兜底,置顶区不截断,都不传。
function section({ kind, id, workspaceId = null, title, hint = null, rows, collapsed, expanded, rowLimit, isLive = undefined }) {
  const all = rows ?? [];
  const limited = collapsed
    ? []
    : expanded || all.length <= rowLimit
      ? all
      : isLive !== undefined ? collapsedRows(all, rowLimit, isLive) : all.slice(0, rowLimit);
  return {
    kind,
    id,
    workspaceId,
    title,
    hint,
    rows: limited,
    // 这一组的**完整**成员(含被折叠/截断掉的),拖拽解析锚点时要用:
    // 落在最后一条可见行之后时,锚点取完整成员里紧跟其前一行的那一条。
    allIds: all.map((item) => item.sessionId),
    total: all.length,
    hiddenCount: collapsed ? 0 : all.length - limited.length,
    collapsed,
    expanded: Boolean(expanded)
  };
}

/// 当前会话落在哪个分组里(按完整成员算,折叠的组也算)。
///
/// 对齐 Mac `containsCurrent`:它只在**挂载时**起作用(onAppear 里
/// `collapsed = stored && !containsCurrent`)—— 抽屉打开那一下把这个组展开,
/// 免得"我的会话不见了";之后用户照样可以把它折起来。所以这里只报告是哪一组,
/// 由视图层在打开抽屉时决定展开,而不是每次渲染都强行覆盖折叠态 —— 那样的话
/// 点这个组的标题永远没反应。
function activeGroupOf(sections, activeSessionId) {
  if (!activeSessionId) return null;
  return sections.find((item) => item.allIds.includes(activeSessionId))?.id ?? null;
}
