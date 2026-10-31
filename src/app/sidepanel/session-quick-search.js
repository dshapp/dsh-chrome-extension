// 会话快速搜索:左侧栏收起(只剩图标栏)时,点图标栏的「搜索」不再把会话列表展开,
// 而是在页面上方悬浮一个搜索框(命令面板的手感),并自动聚焦。
// 输入关键字后,在搜索框正下方列出候选会话;↑ / ↓ 移动、回车或点击打开、Esc / 点外面收起。
//
// 搜索口径与会话抽屉完全一致:本地标题 / 工作区命中即时出现,宿主内容命中 250ms 防抖后
// 接在后面(deriveSearchResults);每一行的行首状态灯与行尾徽章/时间也与抽屉行同一套
//(调用方经 decorate 传入 sessionRowDecorHtml)。归档会话按默认筛选不出现 —— 它们本就打不开。
import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/md-to-html.js";
import {
  deriveSearchResults, normalizeSearchQuery, sanitizeSearchQuery, SEARCH_DEBOUNCE_MS, SEARCH_RESULT_LIMIT
} from "../../features/sessions/session-search.js";
import { itemTitle } from "./session-drawer-view.js";

const OPTION_ID_PREFIX = "session-quick-search-opt-";

/**
 * @param {Document} doc
 * @param {object} options
 * @param {() => Array} options.sessions 名册(listStore 的会话摘要)。
 * @param {() => Array} [options.workspaces] 宿主 workspace 名单(工作区标签命中用)。
 * @param {() => Array<string>} [options.archivedIds]
 * @param {(query: string) => Promise<{items: Array, hasMore: boolean}>} [options.search] 宿主内容搜索。
 * @param {(item: object) => { leading: string, trailing: string }} [options.decorate] 行首 / 行尾(可信 HTML)。
 * @param {() => string|null} [options.currentId] 当前会话,行上加底色。
 * @param {() => { home?: string|null, homeLabel?: string }} [options.homeOptions]
 * @param {(id: string) => void} options.onPick
 */
export function mountSessionQuickSearch(doc, {
  sessions, workspaces = () => [], archivedIds = () => [], search = null, decorate = null,
  currentId = () => null, homeOptions = () => ({}), onPick
}) {
  const panel = doc.querySelector("#session-quick-search");
  const input = panel?.querySelector("#session-quick-search-input");
  const results = panel?.querySelector("#session-quick-search-results");
  if (!panel || !input || !results) {
    return { open() {}, close() {}, toggle() {}, refresh() {}, relabel() {}, isOpen: () => false };
  }

  let open = false;
  let items = [];
  let activeIndex = -1;
  let remote = { query: "", pending: false, items: [], hasMore: false };
  let debounceTimer = null;
  // 打开它的按钮:Esc 收起后焦点还回去,键盘用户不会掉到 body 上。
  let invoker = null;

  const query = () => normalizeSearchQuery(input.value);

  function show(source = null) {
    invoker = source;
    if (!open) {
      open = true;
      // source 让触发按钮成为它的 invoker:再点那颗按钮时不会先被「点外面」收起、又被点开。
      try { panel.showPopover?.(source ? { source } : undefined); } catch {
        try { panel.showPopover?.(); } catch { /* 已经开着 / 不支持 */ }
      }
    }
    reset();
    input.focus();
  }

  function close() {
    clearTimeout(debounceTimer);
    if (!open) return;
    open = false;
    try { panel.hidePopover?.(); } catch { /* 已经关了 */ }
  }

  /// 每次打开都是一次新的搜索:清空上一次的词与结果。
  function reset() {
    clearTimeout(debounceTimer);
    input.value = "";
    remote = { query: "", pending: false, items: [], hasMore: false };
    paint({ resetActive: true });
  }

  /// 重画候选。空查询不列任何东西(只剩搜索框);有词时先本地命中,宿主命中到了再补上。
  function paint({ resetActive = false } = {}) {
    const q = query();
    if (!q) {
      items = [];
      activeIndex = -1;
      results.innerHTML = "";
      results.hidden = true;
      syncAria();
      return;
    }
    const activeId = items[activeIndex]?.sessionId ?? null;
    const derived = deriveSearchResults({
      sessions: sessions() ?? [],
      workspaces: workspaces() ?? [],
      archivedIds: archivedIds() ?? [],
      query: q,
      remote: remote.query === q ? remote : null,
      ...homeOptions()
    });
    items = derived.items;
    // 后台重画(宿主命中到了 / 会话状态变了)时,键盘光标跟着原来那一行走。
    const kept = resetActive || !activeId ? -1 : items.findIndex((item) => item.sessionId === activeId);
    activeIndex = kept >= 0 ? kept : (items.length ? 0 : -1);
    const current = currentId?.() ?? null;
    let html = items.map((item, index) => {
      const decor = decorate?.(item) ?? { leading: "", trailing: "" };
      const classes = ["menu-item", "rail-recent-item", "quick-search-item"];
      if (index === activeIndex) classes.push("active");
      if (item.sessionId === current) classes.push("current");
      return '<button type="button" id="' + OPTION_ID_PREFIX + index + '" class="' + classes.join(" ") + '"'
        + ' role="option" aria-selected="' + (index === activeIndex) + '" tabindex="-1"'
        + ' data-session-id="' + escapeHtml(item.sessionId) + '" data-index="' + index + '">'
        + decor.leading
        + '<span class="menu-item-label">' + escapeHtml(itemTitle(item)) + "</span>"
        + decor.trailing
        + "</button>";
    }).join("");
    if (remote.pending) html += note(t("sessions.searchPending"), "status");
    else if (!items.length) html += note(t("sessions.noMatches"));
    if (derived.hasMore) html += note(t("sessions.searchHasMore", { n: String(SEARCH_RESULT_LIMIT) }));
    results.innerHTML = html;
    results.hidden = false;
    syncAria();
    results.querySelector(".quick-search-item.active")?.scrollIntoView?.({ block: "nearest" });
  }

  function note(text, role = "") {
    return '<div class="quick-search-note"' + (role ? ' role="' + role + '"' : "") + ">" + escapeHtml(text) + "</div>";
  }

  function syncAria() {
    input.setAttribute("aria-expanded", String(items.length > 0));
    if (activeIndex >= 0) input.setAttribute("aria-activedescendant", OPTION_ID_PREFIX + activeIndex);
    else input.removeAttribute("aria-activedescendant");
  }

  function setActive(index) {
    if (index === activeIndex || !items[index]) return;
    activeIndex = index;
    for (const row of results.querySelectorAll(".quick-search-item")) {
      const on = Number(row.dataset.index) === index;
      row.classList.toggle("active", on);
      row.setAttribute("aria-selected", String(on));
      if (on) row.scrollIntoView?.({ block: "nearest" });
    }
    syncAria();
  }

  function pick(item) {
    if (!item) return;
    close();
    onPick(item.sessionId);
  }

  async function runRemote(pending) {
    let page = null;
    try { page = await search?.(pending.query); } catch { /* 只显示本地命中 */ }
    if (remote !== pending) return;   // 迟到的旧查询
    remote = { query: pending.query, pending: false, items: page?.items ?? [], hasMore: page?.hasMore === true };
    if (open) paint();
  }

  input.addEventListener("input", () => {
    const clean = sanitizeSearchQuery(input.value);
    if (clean !== input.value) input.value = clean;
    const q = query();
    if (q !== remote.query) {
      clearTimeout(debounceTimer);
      remote = { query: q, pending: Boolean(q && search), items: [], hasMore: false };
      const pending = remote;
      if (q && search) debounceTimer = setTimeout(() => void runRemote(pending), SEARCH_DEBOUNCE_MS);
    }
    paint({ resetActive: true });
  });

  input.addEventListener("keydown", (event) => {
    // 输入法组字时的回车 / 上下键是选字,不是操作列表。
    if (event.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (!items.length) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive(activeIndex < 0 ? (step > 0 ? 0 : items.length - 1) : (activeIndex + step + items.length) % items.length);
        break;
      }
      case "Enter":
        if (!items[activeIndex]) return;
        event.preventDefault();
        pick(items[activeIndex]);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        invoker?.focus?.();
        break;
      default: break;
    }
  });

  // 鼠标指到哪行,键盘光标就跟到哪行 —— 免得悬停一行、回车却开了另一行。
  results.addEventListener("mousemove", (event) => {
    const row = event.target.closest?.(".quick-search-item");
    if (row) setActive(Number(row.dataset.index));
  });
  // 按下时不让行按钮抢走输入框的焦点(否则光标消失,接着打字就打不进去)。
  results.addEventListener("mousedown", (event) => {
    if (event.target.closest?.(".quick-search-item")) event.preventDefault();
  });
  results.addEventListener("click", (event) => {
    const row = event.target.closest?.(".quick-search-item");
    if (row) pick(items[Number(row.dataset.index)]);
  });

  // popover="auto" 自己会在点外面 / Esc 时收起:同步本地状态。
  panel.addEventListener("toggle", (event) => {
    if (event.newState !== "closed") return;
    open = false;
    clearTimeout(debounceTimer);
  });

  function relabel() {
    const label = t("sidebar.search");
    panel.setAttribute("aria-label", label);
    input.placeholder = t("history.searchPlaceholder");
    input.setAttribute("aria-label", label);
    results.setAttribute("aria-label", label);
  }
  relabel();

  return {
    open: show,
    close,
    /// 图标栏的搜索按钮:开着时再点是关。
    toggle: (source = null) => (open ? close() : show(source)),
    /// 名册 / 会话状态变化时就地重画(键盘光标留在原来那一行)。
    refresh: () => { if (open) paint(); },
    relabel,
    isOpen: () => open
  };
}
