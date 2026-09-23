// 左侧会话抽屉:开关与动画、搜索、键盘导航、行操作、分组折叠与拖拽接线。
//
// 列表的**派生**在 features/sessions/sidebar-sections.js(纯函数),**渲染**在
// ./session-drawer-view.js,**视图选项/折叠态/拖拽提交**在 ./history-view-options.js。
// 这里只做编排 —— 三块分开是因为它们的变更理由不同,合在一处也会把本文件顶过
// 400 行的硬上限。
//
// 抽屉从左侧滑入(对齐 Mac 的左侧栏),入口是顶栏最左那颗带标题的按钮。
import { t } from "../../shared/i18n.js";
import { buildSidebarSections } from "../../features/sessions/sidebar-sections.js";
import { renderSections, renderResultRows, renderLoading, SECTION_HEAD_ID } from "./session-drawer-view.js";
import { mountHistoryViewOptions } from "./history-view-options.js";

export function mountHistoryDrawer(deps, openSession, newSession, shortcutLabels = null, {
  // 宿主的 workspace 名单(分组模式按它划分),以及已归档 id(永远不进列表)。
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
  // 正在跑 fork/rename/archive 的会话 id:同一行的操作按钮在往返期间禁用。
  const rowBusy = new Set();
  let allItems = [];
  let renderedItems = [];
  let sections = [];
  // 键盘导航的高亮行下标(-1 = 无选中)。与 activeSessionId(当前打开的会话)是两回事:
  // 前者是"光标在哪",后者是"哪个会话是当前的"。
  let selectedIndex = -1;

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

  entry.addEventListener("click", () => {
    if (isOpen()) hide();
    else open();
  });
  scrim.addEventListener("click", () => hide({ restoreFocus: true }));
  closeButton?.addEventListener("click", () => hide({ restoreFocus: true }));

  // 搜索:优先用宿主的全文索引(能搜到正文);索引未开启时回退到本地标题过滤。
  let searchToken = 0;
  let searchDebounceTimer = null;
  // 一次性渲染的行数上限,超出部分折叠为提示行(搜索结果与单列表都吃这条)。
  const MAX_RENDERED_ROWS = 500;
  search.addEventListener("input", () => {
    const query = search.value.trim();
    const token = ++searchToken;
    // 搜索词一变,结果集就是新的 —— 高亮统一回到第一行。
    paint({ resetSelection: true });
    if (!query) return;
    // 远端全文搜索按 250ms 防抖:连续输入只发最后一次请求。
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      void runRemoteSearch(query, token);
    }, 250);
  });

  async function runRemoteSearch(query, token) {
    try {
      const remote = await deps.sessions.search(query);
      if (token !== searchToken || !remote) return;   // 迟到的结果 / 索引未开启
      const hits = remote.items ?? remote.results ?? [];
      if (!hits.length) return;
      const byId = new Map(allItems.map((item) => [item.sessionId, item]));
      const merged = hits
        .map((hit) => byId.get(hit.sessionId) ?? { sessionId: hit.sessionId, updatedAt: hit.updatedAt })
        .filter(Boolean);
      if (merged.length) renderRows(merged, { resetSelection: true });
    } catch { /* 搜索失败不打断输入 */ }
  }

  // 抽屉之外的点击关掉它。抽屉内的 popover(视图选项)虽然画在 top layer 里,
  // 但仍是抽屉的 DOM 子节点,composedPath 能命中,所以不需要额外的例外分支。
  document.addEventListener("click", (event) => {
    if (!isOpen()) return;
    const path = event.composedPath();
    if (path.includes(drawer) || path.includes(entry) || path.includes(scrim)) return;
    hide();
  });

  /// 搜索词过滤(本地标题匹配)。分组/排序由 buildSidebarSections 负责,
  /// 所以这里只管"哪些行参与"。
  function matchingItems(query) {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((item) =>
      (item.projections?.values?.title || item.sessionId).toLowerCase().includes(q));
  }

  /// 行渲染上下文:实时状态都从 listStore 现取,置顶态从账本现取。
  function rowContext() {
    return {
      listStore,
      pinnedStore,
      activeSessionId,
      selectedIndex,
      shortcutLabels,
      draggable: viewOptions?.isDraggable() ?? true
    };
  }

  /// 画一串没有分区的行(搜索结果)。
  function renderRows(items, { resetSelection = false } = {}) {
    const visible = items.length > MAX_RENDERED_ROWS ? items.slice(0, MAX_RENDERED_ROWS) : items;
    sections = [];
    clampSelection(visible.length, resetSelection);
    renderedItems = renderResultRows(list, {
      items: visible,
      overflow: items.length - visible.length,
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
    const query = search.value.trim();
    if (query) { renderRows(matchingItems(query), { resetSelection }); return; }
    const built = buildSidebarSections({
      sessions: allItems,
      workspaces: workspaces() ?? [],
      archivedIds: archivedIds() ?? [],
      pinnedIds: pinnedStore?.order ?? [],
      groupBy: viewOptions?.groupBy(),
      orderBy: viewOptions?.orderBy(),
      collapsedGroupIds: viewOptions?.collapsedIds() ?? [],
      expandedGroupIds: viewOptions?.expandedIds() ?? [],
      activeSessionId,
      sortRows: listStore?.sortBy ? (rows, orderBy, ids) => listStore.sortBy(rows, orderBy, ids) : null
    });
    sections = built.sections;
    clampSelection(built.renderedIds.length, resetSelection);
    renderedItems = renderSections(list, {
      sections: built.sections,
      groupBy: viewOptions?.groupBy(),
      ctx: rowContext()
    });
    // 常驻的视图选项与「添加目录」搬回刚画出来的分区标题行(搬而不是重建:
    // popover 的锚点与事件绑定都挂在那几个节点上)。
    viewOptions?.mountInto(list.querySelector(`#${SECTION_HEAD_ID} .history-section-actions`));
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
        hide();
        openSession(item.sessionId);
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

    const actionButton = event.target.closest("button[data-action]");
    const row = event.target.closest("[data-session-id]");
    if (!row) return;
    const sessionId = row.dataset.sessionId;
    if (!actionButton) {
      hide();
      openSession(sessionId);
      return;
    }
    // 置顶是乐观更新:账本立即变,0.1.7 宿主模式下的 RPC 在后台结算(失败回滚 + toast),
    // 所以这里不需要在途标记。
    if (actionButton.dataset.action === "pin") {
      pinnedStore?.setPinned?.(sessionId, !pinnedStore.isPinned(sessionId));
      paint();
      return;
    }
    // fork / archive 都会改变会话集合,且宿主往返期间抽屉保持打开、按钮仍可点。
    // 没有在途标记的话,连点两下会 fork 出两个子会话,或在归档当前会话时多建
    // 一个空白会话。整行按钮一起禁用并给出进行中样式。
    if (rowBusy.has(sessionId)) return;
    rowBusy.add(sessionId);
    setRowBusy(row, true);
    try {
      if (actionButton.dataset.action === "fork") {
        const forkedId = await deps.sessions.fork(sessionId);
        hide();
        openSession(forkedId);
      } else if (actionButton.dataset.action === "rename") {
        const name = prompt(t("session.renamePrompt"));
        if (name) { await deps.sessions.rename(sessionId, name); refresh(); }
      } else if (actionButton.dataset.action === "archive") {
        // 归档不是删除:宿主保留日志,只是从活动列表移出。
        const archived = await deps.sessions.archive(sessionId, { confirmStop: confirmArchiveActive });
        if (archived === null) return;
        if (sessionId === activeSessionId) {
          // 当前转录已经不属于活动列表；继续停在这里会留下一个标题仍选中、
          // 但列表里找不到的幽灵会话。与 Mac 一致，归档当前项后进入新会话。
          hide();
          await newSession();
        } else {
          refresh();
        }
      }
    } catch (error) {
      // 与全局一致用 toast:alert 会阻塞 UI 线程,且和应用其余部分的报错风格不符。
      showToast?.(deps.formatErrorDetails(error));
    } finally {
      rowBusy.delete(sessionId);
      // 行可能已被 refresh() 重建或随归档消失,重新查一次当前 DOM 里的它。
      setRowBusy(list.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`), false);
    }
  });

  /// 归档一个还在跑的会话前的确认(0.1.7 workspace/session-active)。
  function confirmArchiveActive() {
    return Promise.resolve(window.confirm(t("session.archiveActiveConfirm")));
  }

  /// 整行的操作按钮统一进入/退出在途态。
  function setRowBusy(row, busy) {
    if (!row) return;
    row.classList.toggle("is-busy", busy);
    for (const button of row.querySelectorAll("button[data-action]")) button.disabled = busy;
  }

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
    // 抽屉开着时把上下键/回车/Esc 交给列表;返回 true 表示已消费。
    handleKeyDown,
    // 快捷键(⌘K + 数字)按当前渲染序打开会话。
    selectByIndex(index) {
      const item = renderedItems[index];
      if (!item) return;
      hide();
      openSession(item.sessionId);
    },
    /// 当前渲染序(置顶 → 分组/单列表,含折叠与截断的结果)。
    /// ⌘[ / ⌘] 与归档后的接替选择都走它,所以永远只指向屏幕上真有的行。
    renderedOrder: () => renderedItems.map((item) => item.sessionId)
  };
}

// 通用 popover 菜单渲染器住在 menu-items.js。这里再导出,让既有调用方
//(composer-dock / composer-menus / workspace-menu)的 import 路径保持不变。
export { renderMenuItems } from "./menu-items.js";
