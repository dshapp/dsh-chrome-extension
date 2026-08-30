// 侧栏浮层与覆盖层:历史 popover(搜索/分叉/重命名)+ popover 菜单。
// 设置页已独立到 ./settings/(五个 tab),不再由本文件承载。
import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/md-to-html.js";
import {
  resolveSessionRowTrailing, isAwaitingUserTrailing, formatRelativeTime,
  SessionRowTrailingKind, SessionAwaitingKind
} from "../../features/sessions/session-row-trailing.js";

// 行内操作图标取自 Lucide(https://github.com/lucide-icons/lucide,ISC),沿用官方 24×24 网格的
// 原始路径,stroke-width 从 2 调到 1.7 以适配 13px 的渲染尺寸。之前这里用的是 Unicode 字形
// (⑂ ✎ 🗄)—— 字形随系统字体变化、基线对不齐,🗄 在部分平台还会被渲染成彩色 emoji。
const actionIcon = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const HISTORY_ACTION_ICONS = Object.freeze({
  // lucide: git-fork
  fork: actionIcon('<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>'),
  // lucide: pencil-line
  rename: actionIcon('<path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>'),
  // lucide: archive
  archive: actionIcon('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>')
});

export function mountHistoryDrawer(deps, openSession, newSession, shortcutLabels = null, { workspacePath = () => null, workspaceSessionIds = () => null } = {}) {
  // 挂起请求/草稿的权威来源 —— session.list 的摘要里没有这两样。
  const listStore = deps.sessions?.listStore ?? null;
  const popover = document.querySelector("#history-popover");
  const titleWrap = document.querySelector("#hdr-title-wrap");
  const list = popover.querySelector("#history-list-inner");
  const search = popover.querySelector("#history-search");
  const title = document.querySelector("#hdr-title");
  let activeSessionId = null;
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
    refresh({ resetSelection: true });
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
    if (!q) return scoped;
    return scoped.filter((item) => (item.projections?.values?.title || item.sessionId).toLowerCase().includes(q));
  }

  async function refresh({ resetSelection = false } = {}) {
    try {
      allItems = await deps.sessions.refreshList();
      render(filterItems(search.value), { resetSelection });
    } catch { /* 后端不可达时保留旧列表 */ }
  }

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
      // 状态点与警示徽章二选一:徽章已经把「这行要你处理」说清楚了,
      // 再点一个绿点只是噪声(对齐 macOS 的 showStatus 抑制)。
      const showDot = item.running && !isAwaitingUserTrailing(trailing);
      return [
        `<li class="history-item${item.sessionId === activeSessionId ? " active" : ""}${index === selectedIndex ? " selected" : ""}" data-session-id="${escapeHtml(item.sessionId)}" data-index="${index}">`,
        `<span class="h-title">${escapeHtml(itemTitle(item))}</span>`,
        `<span class="h-when-row"><kbd class="shortcut-hint hist-shortcut-hint" aria-hidden="true">${escapeHtml(hint)}</kbd>${trailingHtml(trailing)}</span>`,
        showDot ? '<span class="h-dot" title="running"></span>' : "",
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
        refresh();
      }
    } catch (error) {
      alert(deps.formatErrorDetails(error));
    }
  });

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

// popover 菜单构建(模型/权限/技能共用)。
export function renderMenuItems(container, entries, { selectedId, onSelect, groupBy, emptyText }) {
  if (!entries.length) {
    container.innerHTML = emptyText
      ? `<div class="menu-empty">${escapeHtml(emptyText)}</div>`
      : "";
    container.onclick = null;
    return;
  }
  const groups = new Map();
  for (const entry of entries) {
    const key = groupBy ? groupBy(entry) : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  container.innerHTML = [...groups.entries()].map(([group, items]) => (
    (group ? `<div class="menu-group-label">${escapeHtml(group)}</div>` : "")
    + items.map((item) => (
      `<button type="button" class="menu-item${item.id === selectedId ? " selected" : ""}" data-item-id="${escapeHtml(item.id)}">`
      + `<span>${escapeHtml(item.label)}</span>${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}`
      + `</button>`
    )).join("")
  )).join("");
  container.onclick = (event) => {
    const button = event.target.closest("[data-item-id]");
    if (button) onSelect(button.dataset.itemId);
  };
}
