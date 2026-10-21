// 左侧会话抽屉:开关与动画、搜索、键盘导航、行操作、分组折叠与拖拽接线。
//
// 列表的**派生**在 features/sessions/sidebar-sections.js(纯函数),**渲染**在
// ./session-drawer-view.js,**视图选项/折叠态/拖拽提交**在 ./history-view-options.js。
// 这里只做编排 —— 三块分开是因为它们的变更理由不同,合在一处也会把本文件顶过
// 400 行的硬上限。
//
// 抽屉从左侧滑入(对齐 Mac 的左侧栏),入口是顶栏最左那颗带标题的按钮。
import { t } from "../../shared/i18n.js";
import { buildSidebarSections, ArchivedFilter } from "../../features/sessions/sidebar-sections.js";
import {
  deriveSearchResults, normalizeSearchQuery, sanitizeSearchQuery, SEARCH_DEBOUNCE_MS, SEARCH_RESULT_LIMIT
} from "../../features/sessions/session-search.js";
import { renderSections, renderResultRows, renderLoading, SECTION_HEAD_ID } from "./session-drawer-view.js";
import { mountHistoryViewOptions } from "./history-view-options.js";
import { createRepaintHold } from "../../features/sessions/history-repaint-hold.js";
import { createHistoryRowActions } from "./history-row-actions.js";
import { mountHeaderTitleEdit } from "./header-title-edit.js";

export function mountHistoryDrawer(deps, openSession, newSession, shortcutLabels = null, {
  // 宿主的 workspace 名单(分组模式按它划分),以及已归档 id(按「筛选会话」取舍)。
  workspaces = () => [],
  archivedIds = () => [],
  orderStore = null,
  pinnedStore = null,
  // 分区标题右侧那颗「添加目录」:复用工作目录菜单里的同一条 pickAndCreate 路径。
  onAddWorkspace = null,
  // deps 是纯组装层,没有 toast —— 与设置页同样由 app 就地补进来。
  showToast = null
} = {}) {
  // 挂起请求/草稿的权威来源 —— session.list 的摘要里没有这两样。
  const listStore = deps.sessions?.listStore ?? null;
  // 视图选项控制器。在下面才创建(它要用到 paint),而 paint 又要问它当前是
  // 哪两根轴 —— 所以这里先留个引用,由那些函数在**调用时**读取。
  let viewOptions = null;
  const drawer = document.querySelector("#session-drawer");
  const scrim = document.querySelector("#session-drawer-scrim");
  const entry = document.querySelector("#hdr-title-wrap");
  const list = drawer.querySelector("#history-list-inner");
  const search = drawer.querySelector("#history-search");
  const closeButton = drawer.querySelector("#session-drawer-close");
  const title = document.querySelector("#hdr-title");
  let activeSessionId = null;
  let allItems = [];
  let renderedItems = [];
  let sections = [];
  // 键盘导航的高亮行下标(-1 = 无选中)。与 activeSessionId(当前打开的会话)是两回事:
  // 前者是"光标在哪",后者是"哪个会话是当前的"。
  let selectedIndex = -1;
  // 打开抽屉后,第一次分区渲染要把含当前会话的组展开(见 paint)。
  let revealPending = false;
  // 按住 / 拖拽期间不重画,原因见 history-repaint-hold.js。
  const hold = createRepaintHold(list, (options) => { if (isOpen()) paint(options); });

  function isOpen() { return drawer.classList.contains("open"); }

  /// 打开抽屉:清空上一次的搜索词、渲染列表,并把光标放进搜索框。
  function open() {
    drawer.classList.add("open");
    scrim.hidden = false;
    // 遮罩要先出现在 DOM 里,下一帧再上色,否则 opacity 过渡不会跑。
    requestAnimationFrame(() => scrim.classList.add("open"));
    document.body.classList.add("session-drawer-open");
    entry.setAttribute("aria-expanded", "true");
    search.value = "";
    clearTimeout(searchDebounceTimer);
    remote = { query: "", pending: false, items: [], hasMore: false };
    revealPending = true;
    // listStore 一直被 host 实时帧维护着,打开抽屉直接渲染这份 warm 快照即可,
    // 不再先清空成 loading 去等一次全量 session/list RPC(对齐 Web 端侧栏直接读
    // snapshot store 的做法)。只有冷启动还没有任何基线时才落 loading。
    // 高亮落到第一行,这样抽屉一开回车就能开首条。
    allItems = listStore?.get?.() ?? allItems;
    if (allItems.length) paint({ resetSelection: true });
    else renderLoading(list);
    // 后台静默刷新:single-flight,会和启动/重连的在途拉取合并;回包后整体替换。
    void refresh({ resetSelection: true });
    // 抽屉刚开始滑入,同一帧里 focus() 在部分浏览器上不生效。
    requestAnimationFrame(() => search.focus());
  }

  function hide({ restoreFocus = false } = {}) {
    if (!isOpen()) return;
    drawer.classList.remove("open");
    scrim.classList.remove("open");
    document.body.classList.remove("session-drawer-open");
    entry.setAttribute("aria-expanded", "false");
    // 遮罩淡出后才移出可交互层,否则它会在过渡期间吃掉点击。
    setTimeout(() => { if (!isOpen()) scrim.hidden = true; }, 200);
    if (restoreFocus) entry.focus();
  }

  // 单击开关抽屉、双击原地改名;两者的判定与编辑框在 header-title-edit.js。
  const titleEdit = mountHeaderTitleEdit({
    entry, title, sessionId: () => activeSessionId, showToast,
    rename: (sessionId, name) => deps.sessions.rename(sessionId, name),
    toggle: () => (isOpen() ? hide() : open()),
    beforeEdit: () => hide()
  });
  scrim.addEventListener("click", () => hide({ restoreFocus: true }));
  closeButton?.addEventListener("click", () => hide({ restoreFocus: true }));

  // 搜索(对齐 web WorkspaceBrowser):本地标题/工作区命中即时出现,宿主内容命中
  // 250ms 防抖后接在后面。remote 只属于它的 query —— 换词立刻作废旧命中并进入
  // pending;宿主失败(如部署关闭了 session/search)就只剩本地命中,不另行提示。
  let remote = { query: "", pending: false, items: [], hasMore: false };
  let searchDebounceTimer = null;
  function currentQuery() { return normalizeSearchQuery(search.value); }
  search.addEventListener("input", () => {
    const clean = sanitizeSearchQuery(search.value);
    if (clean !== search.value) search.value = clean;
    const query = currentQuery();
    if (query !== remote.query) {
      clearTimeout(searchDebounceTimer);
      remote = { query, pending: query !== "", items: [], hasMore: false };
      const pending = remote;
      if (query) searchDebounceTimer = setTimeout(() => void runRemoteSearch(pending), SEARCH_DEBOUNCE_MS);
    }
    // 搜索词一变,结果集就是新的 —— 高亮统一回到第一行。
    paint({ resetSelection: true });
  });

  async function runRemoteSearch(pending) {
    let page = null;
    try { page = await deps.sessions.search(pending.query); } catch { /* 只显示本地命中 */ }
    if (remote !== pending) return;   // 迟到的旧查询
    remote = { query: pending.query, pending: false, items: page?.items ?? [], hasMore: page?.hasMore === true };
    if (isOpen()) paint();
  }

  // 抽屉之外的点击关掉它。抽屉内的 popover(视图选项)虽然画在 top layer 里,
  // 但仍是抽屉的 DOM 子节点,composedPath 能命中,所以不需要额外的例外分支。
  document.addEventListener("click", (event) => {
    if (!isOpen()) return;
    const path = event.composedPath();
    if (path.includes(drawer) || path.includes(entry) || path.includes(scrim)) return;
    hide();
  });

  /// 行渲染上下文:实时状态都从 listStore 现取,置顶态从账本现取。
  function rowContext() {
    return {
      listStore,
      pinnedStore,
      activeSessionId,
      selectedIndex,
      shortcutLabels,
      draggable: viewOptions?.isDraggable() ?? true,
      groupDraggable: viewOptions?.isGroupDraggable?.() ?? false
    };
  }

  /// 列表与搜索读的名册。listStore 里只有活动会话;「筛选会话」要显示归档行时,
  /// 把会话服务手上的归档摘要并进来(Mac 的名册本来就含归档行)。
  function roster() {
    if ((viewOptions?.archivedFilter?.() ?? ArchivedFilter.hide) === ArchivedFilter.hide) return allItems;
    const archived = deps.sessions?.archivedItems?.() ?? [];
    if (!archived.length) return allItems;
    const seen = new Set(allItems.map((item) => item.sessionId));
    return [...allItems, ...archived.filter((item) => !seen.has(item.sessionId))];
  }

  /// 画搜索结果(平铺,没有分区)。
  function renderSearch(query, { resetSelection = false } = {}) {
    const results = deriveSearchResults({
      sessions: roster(),
      workspaces: workspaces() ?? [],
      archivedIds: archivedIds() ?? [],
      archivedFilter: viewOptions?.archivedFilter?.(),
      query,
      remote
    });
    sections = [];
    clampSelection(results.items.length, resetSelection);
    renderedItems = renderResultRows(list, {
      items: results.items,
      pending: remote.pending,
      hasMore: results.hasMore,
      limit: SEARCH_RESULT_LIMIT,
      ctx: rowContext()
    });
  }

  function clampSelection(count, resetSelection) {
    if (resetSelection) selectedIndex = 0;
    if (selectedIndex >= count) selectedIndex = count - 1;
    if (selectedIndex < 0) selectedIndex = count ? 0 : -1;
  }

  /// 重画整份列表。搜索态走结果行,否则走分区(置顶 + 分组/单列表)。
  function paint({ resetSelection = false } = {}) {
    // 视图选项菜单开着时不重建列表:菜单是分区标题行的子节点,innerHTML 一换
    // 它就被摘出 top layer 当场消失。攒着,等菜单关上再画。
    if (viewOptions?.isMenuOpen?.()) { viewOptions.deferRepaint({ resetSelection }); return; }
    if (hold.held()) { hold.defer({ resetSelection }); return; }
    const query = currentQuery();
    if (query) { renderSearch(query, { resetSelection }); return; }
    let built = buildSections();
    // 抽屉打开后的第一次分区渲染:含当前会话的组若是折着的,展开它(只这一次)。
    if (revealPending && built.sections.length) {
      revealPending = false;
      if (viewOptions?.reveal?.(built.activeGroupId)) built = buildSections();
    }
    sections = built.sections;
    clampSelection(built.renderedIds.length, resetSelection);
    renderedItems = renderSections(list, {
      sections: built.sections,
      groupBy: viewOptions?.groupBy(),
      archivedFilter: viewOptions?.archivedFilter?.(),
      ctx: rowContext()
    });
    // 常驻的视图选项与「添加目录」搬回刚画出来的分区标题行(搬而不是重建:
    // popover 的锚点与事件绑定都挂在那几个节点上)。
    viewOptions?.mountInto(list.querySelector(`#${SECTION_HEAD_ID} .history-section-actions`));
  }

  function buildSections() {
    return buildSidebarSections({
      sessions: roster(),
      workspaces: workspaces() ?? [],
      archivedIds: archivedIds() ?? [],
      archivedFilter: viewOptions?.archivedFilter?.(),
      pinnedIds: pinnedStore?.order ?? [],
      groupBy: viewOptions?.groupBy(),
      orderBy: viewOptions?.orderBy(),
      collapsedGroupIds: viewOptions?.collapsedIds() ?? [],
      expandedGroupIds: viewOptions?.expandedIds() ?? [],
      activeSessionId,
      sortRows: listStore?.sortBy ? (rows, orderBy, ids) => listStore.sortBy(rows, orderBy, ids) : null,
      // 子代理在跑的父会话同运行中行一样不占折叠名额(web runningSubagentCount > 0)。
      isRunningSubagentRoot: listStore?.isRunningSubagentRoot ? (id) => listStore.isRunningSubagentRoot(id) : null
    });
  }

  async function refresh({ resetSelection = false, showLoading = false } = {}) {
    if (showLoading) renderLoading(list);
    try {
      allItems = await deps.sessions.refreshList();
      paint({ resetSelection });
    } catch {
      // 后端不可达时保留旧列表(若刚显示过 loading,用旧 allItems 恢复)。
      if (showLoading) paint({ resetSelection });
    }
  }

  viewOptions = mountHistoryViewOptions({
    list,
    orderStore,
    pinnedStore,
    workspaces: deps.workspaces,
    sections: () => sections,
    rerender: (options) => paint(options),
    onAddWorkspace
  });

  const rowActions = createHistoryRowActions({
    list, sessions: deps.sessions, pinnedStore, activeSessionId: () => activeSessionId,
    hooks: { hide, openSession, newSession, refresh, paint, showToast, formatErrorDetails: deps.formatErrorDetails }
  });

  /// 打开一行。归档行打不开(Mac openSidebarSession):提示先取消归档,抽屉留着。
  function openRow(item) {
    if (item?.archived) { showToast?.(t("sessions.archivedNotOpenable")); return; }
    hide();
    openSession(item.sessionId);
  }

  // 实时同步:后台帧的偷看只写 listStore(运行状态点、待审批/草稿徽章、
  // 标题投影、活跃排序),抽屉开着时跟着重画,不用等下一次 open()。
  // 关着时跳过 —— open() 反正会全量 refresh,省得白渲染。
  // 不 resetSelection:后台刷新不该把用户已移动的键盘光标顶回第一行。
  listStore?.subscribe?.(() => {
    if (!isOpen()) return;
    allItems = listStore.get();
    paint();
  });
  // workspace 的增删改与组内顺序同样会改变分组视图。
  deps.workspaces?.subscribe?.(() => { if (isOpen()) paint(); });
  pinnedStore?.subscribe?.(() => { if (isOpen()) paint(); });
  // 归档 / 取消归档:筛选显示归档行时,归档摘要的增减也要跟着重画。
  deps.sessions?.onArchivedChange?.(() => { if (isOpen()) paint(); });

  /// 移动高亮行。步进后在两端循环 —— 列表短的时候按到底再按一下能绕回开头,
  /// 比卡在最后一行更符合下拉菜单的手感(和 trigger-menu 的 menuMove 一致)。
  function moveSelection(step) {
    if (!renderedItems.length) return;
    const count = renderedItems.length;
    // 起点为 -1(还没选过)时:向下从第 0 行开始,向上从最后一行开始。
    const next = selectedIndex < 0
      ? (step > 0 ? 0 : count - 1)
      : (selectedIndex + step + count) % count;
    setSelection(next);
  }

  function setSelection(index) {
    selectedIndex = index;
    for (const row of list.querySelectorAll(".history-item")) {
      const isSelected = Number(row.dataset.index) === index;
      row.classList.toggle("selected", isSelected);
      // 高亮行滚进可视区,否则长列表里按方向键会"走丢"。
      if (isSelected) row.scrollIntoView({ block: "nearest" });
    }
  }

  /// 供搜索框与全局快捷键复用。返回 true 表示按键已被消费。
  function handleKeyDown(event) {
    if (!isOpen()) return false;
    // 输入法组字确认候选时也会派发 Enter/上下键:那是选字,不是操作列表。
    if (event.isComposing) return false;
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); moveSelection(1); return true;
      case "ArrowUp": event.preventDefault(); moveSelection(-1); return true;
      case "Enter": {
        const item = renderedItems[selectedIndex];
        if (!item) return false;   // 没选中就交还给默认行为
        event.preventDefault();
        openRow(item);
        return true;
      }
      case "Escape": event.preventDefault(); hide({ restoreFocus: true }); return true;
      default: return false;
    }
  }

  // 焦点在搜索框上,方向键要能直接驱动列表,不用先 Tab 出去。
  search.addEventListener("keydown", handleKeyDown);

  // 鼠标移到哪行,键盘光标就跟到哪行 —— 避免鼠标悬停一行、回车却开了另一行。
  list.addEventListener("mousemove", (event) => {
    const row = event.target.closest(".history-item");
    if (!row) return;
    const index = Number(row.dataset.index);
    if (Number.isInteger(index) && index !== selectedIndex) setSelection(index);
  });

  list.addEventListener("click", async (event) => {
    // 分组标题 / 「展开其余 N 个」:只改视图状态,不碰宿主。
    const groupHead = event.target.closest(".history-group");
    if (groupHead) { viewOptions.toggleCollapsed(groupHead.dataset.groupId); return; }
    const moreRow = event.target.closest(".history-more-row");
    if (moreRow) { viewOptions.toggleExpanded(moreRow.dataset.groupId); return; }
    // 「仅显示已归档」空态里的「查看其他会话」:筛选回到默认。
    if (event.target.closest('[data-action="show-other-sessions"]')) {
      viewOptions.setArchivedFilter(ArchivedFilter.hide);
      return;
    }

    const actionButton = event.target.closest("button[data-action]");
    const row = event.target.closest("[data-session-id]");
    if (!row) return;
    if (!actionButton) {
      openRow(renderedItems.find((item) => item.sessionId === row.dataset.sessionId) ?? { sessionId: row.dataset.sessionId });
      return;
    }
    await rowActions.run(actionButton.dataset.action, row);
  });

  return {
    show() { if (!isOpen()) open(); },
    hide,
    refresh,
    /// 语言切换后重画菜单与列表。
    relabel() {
      viewOptions?.relabel();
      if (isOpen()) paint();
    },
    setActive(sessionId, sessionTitle) {
      if (sessionId !== activeSessionId) titleEdit.cancel();
      activeSessionId = sessionId;
      title.textContent = sessionTitle || t("new_session");
      // 未读提醒的清除挂在这里,而不是在 openSession 里再调一次:
      // 打开会话与新建会话两条路径都已经走过 setActive(见 sidepanel-app),
      // 挂在这个汇聚点上就不会漏掉任何一条,以后新增入口也自动继承。
      // listStore 自己判断有没有真的清掉东西,没变就不会白 notify。
      listStore?.setSelected?.(sessionId);
    },
    // 快捷键(⌘K)复用入口按钮的开关逻辑,保证搜索框聚焦/列表刷新行为一致。
    toggle() { entry.click(); },
    /// 行内改名当前会话的标题(双击标题与「重命名会话」快捷键共用)。
    editTitle: () => titleEdit.start(),
    // 抽屉开着时把上下键/回车/Esc 交给列表;返回 true 表示已消费。
    handleKeyDown,
    // 快捷键(⌘K + 数字)按当前渲染序打开会话。
    selectByIndex(index) {
      const item = renderedItems[index];
      if (item) openRow(item);
    },
    /// 当前渲染序(置顶 → 分组/单列表,含折叠与截断的结果)。
    /// ⌘[ / ⌘] 与归档后的接替选择都走它,所以永远只指向屏幕上真有的行;
    /// 筛选带出来的归档行打不开,不进这份顺序。
    renderedOrder: () => renderedItems.filter((item) => !item.archived).map((item) => item.sessionId)
  };
}

// 通用 popover 菜单渲染器住在 menu-items.js。这里再导出,让既有调用方
//(composer-dock / composer-menus / workspace-menu)的 import 路径保持不变。
export { renderMenuItems } from "./menu-items.js";
