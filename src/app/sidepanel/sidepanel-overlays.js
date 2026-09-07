// 侧栏浮层与覆盖层:历史 popover(搜索/分叉/重命名)+ popover 菜单。
// 设置页已独立到 ./settings/(五个 tab),不再由本文件承载。
import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/md-to-html.js";
import {
  resolveSessionRowTrailing, formatRelativeTime,
  SessionRowTrailingKind, SessionAwaitingKind
} from "../../features/sessions/session-row-trailing.js";
import {
  resolveSessionRowStatus, shouldShowSessionRowStatus, SessionRowStatus
} from "../../features/sessions/session-row-status.js";
import { mountHistoryOrdering } from "./history-ordering.js";
import { HISTORY_ACTION_ICONS } from "./history-icons.js";

// 行首状态灯的无障碍/tooltip 文案。warning 一档不会真的渲染
//(shouldShowSessionRowStatus 会挡掉它,因为 trailing 已经把话说了),
// 但表里留着它,保持与 SessionRowStatus 同形、日后不会漏。
const STATUS_HELP_KEY = Object.freeze({
  [SessionRowStatus.ongoing]: "session.stateOngoing",
  [SessionRowStatus.error]: "session.stateError",
  [SessionRowStatus.done]: "session.stateCompleted",
  [SessionRowStatus.warning]: "session.awaitingApprovalHelp"
});

export function mountHistoryDrawer(deps, openSession, newSession, shortcutLabels = null, {
  workspacePath = () => null,
  workspaceSessionIds = () => null,
  workspaceId = () => null,
  orderStore = null,
  // deps 是纯组装层,没有 toast —— 与设置页同样由 app 就地补进来。
  showToast = null
} = {}) {
  // 挂起请求/草稿的权威来源 —— session.list 的摘要里没有这两样。
  const listStore = deps.sessions?.listStore ?? null;
  // 排序控制器。在下面才创建(它要用到 render/filterItems),而 filterItems
  // 又要问它当前是哪一档 —— 所以这里先留个引用,由那些函数在**调用时**读取,
  // 而不是在定义时捕获。未就绪前按默认档,首帧不会因此出错。
  let ordering = null;
  const popover = document.querySelector("#history-popover");
  const titleWrap = document.querySelector("#hdr-title-wrap");
  const list = popover.querySelector("#history-list-inner");
  const search = popover.querySelector("#history-search");
  const title = document.querySelector("#hdr-title");
  let activeSessionId = null;
  // 正在跑 fork/rename/archive 的会话 id:同一行的操作按钮在往返期间禁用。
  const rowBusy = new Set();
  let allItems = [];
  let renderedItems = [];
  // 键盘导航的高亮行下标(-1 = 无选中)。与 activeSessionId(当前打开的会话)是两回事:
  // 前者是"光标在哪",后者是"哪个会话是当前的"。
  let selectedIndex = -1;

  /// 打开浮层:清空上一次的搜索词、刷新列表,并把光标放进搜索框。
  /// 抽成函数是因为 show() 也要走同一套 —— 否则用 show() 开出来的浮层
  /// 不聚焦,得多点一下才能打字。
  function open() {
    popover.classList.add("open");
    titleWrap.setAttribute("aria-expanded", "true");
    search.value = "";
    // 高亮由 refresh() → render(reset) 落到第一行,这样浮层一开回车就能开首条。
    // showLoading:refreshList 是一次 RPC,慢的时候浮层会挂着**上一次**的行不动 ——
    // 那批行属于打开之前的时刻(甚至是上个工作目录),看着像已经加载完了。
    // 先落加载态,列表回来再整体换掉,与切工作目录那条路径同一套处理。
    refresh({ resetSelection: true, showLoading: true });
    // 浮层刚从 display:none 切出来,同一帧里 focus() 在部分浏览器上不生效。
    requestAnimationFrame(() => search.focus());
  }

  titleWrap.addEventListener("click", () => {
    if (popover.classList.contains("open")) {
      popover.classList.remove("open");
      titleWrap.setAttribute("aria-expanded", "false");
      return;
    }
    open();
  });
  // 搜索:优先用宿主的全文索引(能搜到正文);索引未开启时回退到本地标题过滤。
  let searchToken = 0;
  let searchDebounceTimer = null;
  // 历史浮层一次性渲染的行数上限,超出部分折叠为提示行(见 render)。
  const MAX_RENDERED_ROWS = 500;
  search.addEventListener("input", () => {
    const query = search.value.trim();
    const token = ++searchToken;
    // 搜索词一变,结果集就是新的 —— 高亮统一回到第一行。
    if (!query) { render(filterItems(""), { resetSelection: true }); return; }
    // 先用本地结果即时反馈,避免输入时列表空白。
    render(filterItems(query), { resetSelection: true });
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
      if (merged.length) render(merged, { resetSelection: true });
    } catch { /* 搜索失败不打断输入 */ }
  }
  // 工作目录菜单是独立的原生 popover,渲染在 top layer 里,不是 #history-popover
  // 的 DOM 子节点 —— 点它会被判成"点在历史浮层之外"而把历史关掉,连带菜单一起消失。
  const workspaceMenu = document.querySelector("#workspace-menu");
  document.addEventListener("click", (event) => {
    if (popover.contains(event.target) || titleWrap.contains(event.target)) return;
    // 菜单项点击会触发 handleSelect → renderMenu,而 renderMenu 重建 innerHTML,
    // 把被点的按钮从 DOM 里摘掉 —— 冒泡到这里时 event.target 已 disconnect,
    // workspaceMenu.contains(event.target) 会误判 false 从而连历史浮层一起关掉。
    // composedPath 在事件产生时就固定了传播路径,不依赖 target 仍挂在树上。
    if (workspaceMenu && event.composedPath().includes(workspaceMenu)) return;
    popover.classList.remove("open");
    titleWrap.setAttribute("aria-expanded", "false");
  });

  function itemTitle(item) {
    // session.list 的标题在 projections.values.title;无标题回退到去掉 "session-" 前缀的短 id。
    return item.projections?.values?.title
      || `session ${String(item.sessionId).replace(/^session-/, "").slice(0, 8)}`;
  }

  function filterItems(query) {
    // 先按工作目录收窄,再按搜索词。
    // 选中具体 workspace 时,优先用宿主给的 sessionIds(权威成员名单)过滤;
    // 只比对 item.cwd === path 太脆 —— cwd 可能缺失,也可能与 workspace 的
    // canonical 路径拼写不一致(symlink/尾斜杠),导致切目录后列表整片消失。
    // 「临时目录」(未挂 workspace)没有 sessionIds,仍按 cwd === path 过滤。
    const sessionIds = workspaceSessionIds();
    const path = workspacePath();
    let scoped;
    if (sessionIds) {
      const members = new Set(sessionIds);
      scoped = allItems.filter((item) => members.has(item.sessionId) || (path != null && item.cwd === path));
    } else if (path) {
      scoped = allItems.filter((item) => item.cwd === path);
    } else {
      scoped = allItems;
    }
    const q = query.trim().toLowerCase();
    const matched = q
      ? scoped.filter((item) => (item.projections?.values?.title || item.sessionId).toLowerCase().includes(q))
      : scoped;
    // 排序放在过滤之后:手动序与状态序都只对**当前可见的这批**行成立
    //(见 session-order-store 的"交集安全")。
    return listStore?.sortBy
      ? listStore.sortBy(matched, ordering?.orderBy(), sessionIds)
      : matched;
  }

  /// 列表正在刷新:显示加载态。切换工作目录 / 首次打开浮层时,旧列表不再适用,
  /// 与其让用户盯着一片空白或上个目录的残留行,不如明确告诉他在加载。
  function renderLoading() {
    selectedIndex = -1;
    renderedItems = [];
    list.innerHTML = `<li class="history-loading" role="status" aria-live="polite"><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>${escapeHtml(t("sessions.loading"))}</li>`;
  }

  async function refresh({ resetSelection = false, showLoading = false } = {}) {
    if (showLoading) renderLoading();
    try {
      allItems = await deps.sessions.refreshList();
      render(filterItems(search.value), { resetSelection });
    } catch {
      // 后端不可达时保留旧列表(若刚显示过 loading,用旧 allItems 恢复)。
      if (showLoading) render(filterItems(search.value), { resetSelection });
    }
  }

  // ── 排序切换条与行拖拽。整块住在 history-ordering.js:
  // 本文件在这项功能之前就已经 409 行,再内联进来会超过 400 行的硬上限。
  ordering = mountHistoryOrdering({
    popover,
    list,
    orderStore,
    workspaceId,
    workspaces: deps.workspaces,
    visibleRows: () => renderedItems,
    fullRows: () => filterItems(search.value),
    rerender: (options) => render(filterItems(search.value), options)
  });

  // 实时同步:后台帧的偷看只写 listStore(运行状态点、待审批/草稿徽章、
  // 标题投影、活跃排序),浮层开着时跟着重画,不用等下一次 open()。
  // 关着时跳过 —— open() 反正会全量 refresh,省得白渲染。
  // 不 resetSelection:后台刷新不该把用户已移动的键盘光标顶回第一行。
  listStore?.subscribe?.(() => {
    if (!popover.classList.contains("open")) return;
    allItems = listStore.get();
    render(filterItems(search.value));
  });

  /// @param resetSelection 列表内容整体换了(打开浮层/改搜索词)时传 true —— 高亮回到第一行,
  ///        这样搜完直接敲回车就能开首条结果,不必先按一下方向键。
  ///        仅仅是后台刷新(refresh)时传 false,以免把用户已经移动到的光标顶回去。
  /// 把 resolve 出来的尾部内容渲染成 HTML。徽章用文字而不是警示三角:
  /// 三角只会说「看这里」,用户仍得点开才知道是要回答还是要授权 ——
  /// 而「待审批」和「待回答」是两件不同的事(对齐 macOS 的取舍)。
  function trailingHtml(trailing) {
    switch (trailing.kind) {
      case SessionRowTrailingKind.awaitingUser: {
        const isApproval = trailing.awaiting === SessionAwaitingKind.approval;
        const label = t(isApproval ? "session.awaitingApproval" : "session.awaitingQuestion");
        const help = t(isApproval ? "session.awaitingApprovalHelp" : "session.awaitingQuestionHelp");
        return `<span class="h-badge h-badge-warn" title="${escapeHtml(help)}" aria-label="${escapeHtml(help)}">${escapeHtml(label)}</span>`;
      }
      case SessionRowTrailingKind.draft: {
        // 单独一个词,免得读成上面那类通知:这是用户自己没写完的句子,
        // 不是会话向他发出的请求。
        const help = t("session.hasDraftHelp");
        return `<span class="h-badge h-badge-warn" title="${escapeHtml(help)}" aria-label="${escapeHtml(help)}">${escapeHtml(t("session.hasDraft"))}</span>`;
      }
      case SessionRowTrailingKind.time:
        return `<span class="h-when">${escapeHtml(formatRelativeTime(trailing.updatedAt, t))}</span>`;
      default:
        return "";
    }
  }

  /// 行首状态槽位。永远渲染一个等宽的 span,即使不点灯 ——
  /// 有灯和没灯的行标题必须左对齐,否则列表会随状态变化左右跳动
  /// (对齐 macOS 用 Color.clear 占住 statusSlotWidth 的做法)。
  function statusHtml(status, show) {
    if (!show) return '<span class="h-state h-state-idle" aria-hidden="true"></span>';
    const help = t(STATUS_HELP_KEY[status] ?? "session.stateOngoing");
    const safe = escapeHtml(help);
    return `<span class="h-state h-state-${status}" role="img" title="${safe}" aria-label="${safe}"></span>`;
  }

  function render(items, { resetSelection = false } = {}) {
    const visible = items.length > MAX_RENDERED_ROWS ? items.slice(0, MAX_RENDERED_ROWS) : items;
    const overflow = items.length - visible.length;
    renderedItems = visible;
    if (resetSelection) selectedIndex = 0;
    // 列表内容变了,旧的下标可能越界 —— 夹回合法范围而不是留着悬空。
    if (selectedIndex >= visible.length) selectedIndex = visible.length - 1;
    if (selectedIndex < 0) selectedIndex = 0;
    if (!visible.length) {
      selectedIndex = -1;
      list.innerHTML = `<li class="history-empty">${escapeHtml(t("sessions.empty"))}</li>`;
      return;
    }
    // 状态档的顺序是算出来的,拖了也会被下一次渲染算回去 —— 索性不让拖。
    const draggable = ordering?.isDraggable() ?? true;
    list.innerHTML = visible.map((item, index) => {
      const hint = shortcutLabels && index < 9 ? shortcutLabels.historyItem(index + 1) : "";
      const trailing = resolveSessionRowTrailing({
        awaitingUser: listStore?.awaitingUser(item.sessionId) ?? null,
        isSelected: item.sessionId === activeSessionId,
        isArchived: Boolean(item.archived),
        isBlank: Boolean(item.blank),
        hasDraft: listStore?.hasDraft(item.sessionId) ?? false,
        updatedAt: item.updatedAt ?? Date.now()
      });
      // 行首状态灯的判定全在 session-row-status.js 里,与 macOS 同一份语义:
      // 挂起 > 失败 > 自身在跑 > 子代理在跑 > 空闲,且徽章已报「卡住」时不点灯。
      const status = resolveSessionRowStatus({
        awaitingUser: listStore?.awaitingUser(item.sessionId) ?? null,
        running: Boolean(item.running),
        errored: listStore?.isErrored?.(item.sessionId) ?? false,
        runningSubagentRoot: listStore?.isRunningSubagentRoot?.(item.sessionId) ?? false
      });
      const showStatus = shouldShowSessionRowStatus({
        status,
        completed: listStore?.isCompleted?.(item.sessionId) ?? false,
        trailing,
        isArchived: Boolean(item.archived),
        isBlank: Boolean(item.blank)
      });
      return [
        `<li class="history-item${item.sessionId === activeSessionId ? " active" : ""}${index === selectedIndex ? " selected" : ""}" data-session-id="${escapeHtml(item.sessionId)}" data-index="${index}"${draggable ? ' draggable="true"' : ""}>`,
        statusHtml(status, showStatus),
        `<span class="h-title">${escapeHtml(itemTitle(item))}</span>`,
        `<span class="h-when-row"><kbd class="shortcut-hint hist-shortcut-hint" aria-hidden="true">${escapeHtml(hint)}</kbd>${trailingHtml(trailing)}</span>`,
        `<span class="h-actions">`,
        `<button type="button" data-action="fork" title="${escapeHtml(t("fork"))}" aria-label="${escapeHtml(t("fork"))}">${HISTORY_ACTION_ICONS.fork}</button>`,
        `<button type="button" data-action="rename" title="${escapeHtml(t("rename"))}" aria-label="${escapeHtml(t("rename"))}">${HISTORY_ACTION_ICONS.rename}</button>`,
        `<button type="button" data-action="archive" title="${escapeHtml(t("session.archive"))}" aria-label="${escapeHtml(t("session.archive"))}">${HISTORY_ACTION_ICONS.archive}</button>`,
        `</span></li>`
      ].join("");
    }).join("") + (overflow > 0
      ? '<li class="history-more">' + escapeHtml(t("sessions.more", { n: String(overflow) })) + '</li>'
      : "");
  }

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
    if (!popover.classList.contains("open")) return false;
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
      case "Escape": event.preventDefault(); hide(); return true;
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
    const actionButton = event.target.closest("button[data-action]");
    const row = event.target.closest("[data-session-id]");
    if (!row) return;
    const sessionId = row.dataset.sessionId;
    if (!actionButton) {
      hide();
      openSession(sessionId);
      return;
    }
    // fork / archive 都会改变会话集合,且宿主往返期间 popover 保持打开、
    // 按钮仍可点。没有在途标记的话,连点两下会 fork 出两个子会话,或在归档
    // 当前会话时多建一个空白会话。整行按钮一起禁用并给出进行中样式。
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
        await deps.sessions.archive(sessionId);
        if (sessionId === activeSessionId) {
          // 当前转录已经不属于活动列表；继续停在这里会留下一个标题仍选中、
          // 但历史里找不到的幽灵会话。与 Mac 一致，归档当前项后进入新会话。
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

  /// 整行的操作按钮统一进入/退出在途态。
  function setRowBusy(row, busy) {
    if (!row) return;
    row.classList.toggle("is-busy", busy);
    for (const button of row.querySelectorAll("button[data-action]")) button.disabled = busy;
  }

  function hide() {
    popover.classList.remove("open");
    titleWrap.setAttribute("aria-expanded", "false");
  }

  return {
    show() { open(); },
    hide,
    refresh,
    setActive(sessionId, sessionTitle) {
      activeSessionId = sessionId;
      title.textContent = sessionTitle || t("new_session");
      // 未读提醒的清除挂在这里,而不是在 openSession 里再调一次:
      // 打开会话与新建会话两条路径都已经走过 setActive(见 sidepanel-app),
      // 挂在这个汇聚点上就不会漏掉任何一条,以后新增入口也自动继承。
      // listStore 自己判断有没有真的清掉东西,没变就不会白 notify。
      listStore?.setSelected?.(sessionId);
    },
    // 快捷键(⌘K)复用标题下拉的开关逻辑,保证搜索框聚焦/列表刷新行为一致。
    toggle() { titleWrap.click(); },
    // 浮层开着时把上下键/回车/Esc 交给列表;返回 true 表示已消费。
    handleKeyDown,
    // 快捷键(⌘K + 数字)按当前可见(已按搜索过滤)列表的序号打开会话。
    selectByIndex(index) {
      const item = renderedItems[index];
      if (!item) return;
      hide();
      openSession(item.sessionId);
    }
  };
}

// 通用 popover 菜单渲染器住在 menu-items.js。这里再导出,让既有调用方
//(composer-dock / composer-menus / workspace-menu)的 import 路径保持不变。
export { renderMenuItems } from "./menu-items.js";
