// 左侧图标栏(缩小版)与它的「最近会话」弹层。
//
// 图标栏什么时候出现完全由 foundation.css 的 @media 决定(中档默认、宽档收起后),这里只
// 接按钮:展开 / 新建 / 搜索 / 最近会话 / 设置。插件与自动化两颗按钮带 data-main-surface,
// 点击与高亮都归 main-surfaces(它在 document 上委托),这里只给它们画图标和文案。
//
// 「最近会话」对齐 codemax-chrome 的 rail-recents(Codex 的 Recents):悬停或点击图标,在它
// 右边弹出最近会话标题,点一项打开。位置交给 CSS 锚点定位;弹层是图标栏的子节点,
// 图标栏被 CSS 藏起时它也跟着不渲染。每一行与会话抽屉的行同一套呈现:行首状态灯
//(在跑 / 失败 / 跑完未读 / 置顶),行尾徽章或时间 —— 只是没有行操作按钮。
// 弹层开着时,会话状态变化经 refreshRecents() 就地重画。
import { t } from "../../shared/i18n.js";
import { lucideIconSvg } from "../../features/chat/file-icons.js";
import { renderMenuItems } from "./menu-items.js";

export const RECENTS_LIMIT = 10;
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 250;

const RAIL_ICONS = Object.freeze({
  expand: "panel-left",
  new: "plus",
  search: "search",
  recents: "message-circle",
  settings: "settings"
});
const RAIL_LABEL_KEYS = Object.freeze({
  expand: "sidebar.expand",
  new: "new_session",
  search: "sidebar.search",
  recents: "sidebar.recents",
  settings: "settings"
});
const SURFACE_LABEL_KEYS = Object.freeze({
  plugins: "management.plugins",
  automations: "management.automations"
});

/**
 * @param {Document} doc
 * @param {object} options
 * @param {() => void} options.onExpand
 * @param {() => void} options.onNew
 * @param {(button: Element) => void} options.onSearch 收到被点的按钮(悬浮搜索框的 invoker)。
 * @param {() => void} options.onSettings
 * @param {(limit: number) => Array<{ id: string, title: string, leadingHtml?: string, trailingHtml?: string }>} options.listRecent
 *        最近更新的在前。leadingHtml / trailingHtml 是行首状态灯与行尾徽章/时间(可信 HTML)。
 * @param {() => string|null} options.currentId 当前会话,在弹层里高亮。
 * @param {(id: string) => void} options.onPick
 * @param {{ newSession?: string, history?: string }|null} [options.shortcutLabels]
 */
export function mountSidebarRail(doc, {
  onExpand, onNew, onSearch, onSettings, listRecent, currentId, onPick, shortcutLabels = null
}) {
  const rail = doc.querySelector("#sidebar-rail");
  const menu = doc.querySelector("#sidebar-rail-recents");
  if (!rail) return { relabel() {}, closeRecents() {}, refreshRecents() {}, isRecentsOpen: () => false };
  const recentsButton = rail.querySelector('[data-rail="recents"]');
  let open = false;
  let openTimer = null;
  let closeTimer = null;

  for (const button of rail.querySelectorAll("[data-rail]")) {
    button.innerHTML = lucideIconSvg(RAIL_ICONS[button.dataset.rail], { size: 17 });
  }
  for (const button of rail.querySelectorAll("[data-rail-icon]")) {
    button.innerHTML = lucideIconSvg(button.dataset.railIcon, { size: 17 });
  }

  function paintRecents() {
    const items = listRecent(RECENTS_LIMIT) ?? [];
    const heading = t("sidebar.recents");
    renderMenuItems(menu, items.map((item) => ({
      id: item.id,
      label: item.title,
      leadingHtml: item.leadingHtml ?? "",
      trailingHtml: item.trailingHtml ?? ""
    })), {
      selectedId: currentId?.() ?? null,
      groupBy: () => heading,
      emptyText: t("sidebar.recentsEmpty"),
      onSelect: (id) => {
        closeRecents();
        onPick(id);
      }
    });
    for (const row of menu.querySelectorAll(".menu-item")) {
      row.setAttribute("role", "menuitem");
      // 状态灯 / 徽章 / 时间的样式与会话抽屉行共用(foundation.css 里同一组选择器)。
      row.classList.add("rail-recent-item");
    }
  }

  /// 弹层开着时按最新会话状态重画(运行状态灯、徽章、时间)。重画会换掉整排按钮,
  /// 所以把键盘焦点按 id 还回原来那一行,方向键选到一半不会被后台帧打断。
  function refreshRecents() {
    if (!open || !menu) return;
    const focusedId = menu.contains(doc.activeElement) ? doc.activeElement?.dataset?.itemId : null;
    paintRecents();
    if (focusedId) {
      const row = [...menu.querySelectorAll(".menu-item")].find((el) => el.dataset.itemId === focusedId);
      row?.focus();
    }
  }

  function openRecents() {
    if (!menu) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    paintRecents();
    if (!open) {
      open = true;
      try { menu.showPopover?.(); } catch { /* 已经开着 / 不支持 */ }
    }
    recentsButton?.setAttribute("aria-expanded", "true");
  }

  function closeRecents() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!open) return;
    open = false;
    try { menu?.hidePopover?.(); } catch { /* 已经关了 */ }
    recentsButton?.setAttribute("aria-expanded", "false");
  }

  const scheduleClose = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeRecents, HOVER_CLOSE_MS);
  };

  // popover="auto" 自己会在点外面 / Esc 时收起:同步本地状态与 aria。
  menu?.addEventListener("toggle", (event) => {
    if (event.newState !== "closed") return;
    open = false;
    recentsButton?.setAttribute("aria-expanded", "false");
  });
  menu?.addEventListener("mouseenter", () => clearTimeout(closeTimer));
  menu?.addEventListener("mouseleave", scheduleClose);
  // ↑ / ↓ 在条目间移动焦点。
  menu?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...menu.querySelectorAll(".menu-item")];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(doc.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next].focus();
  });
  recentsButton?.addEventListener("mouseenter", () => {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    if (!open) openTimer = setTimeout(openRecents, HOVER_OPEN_MS);
  });
  recentsButton?.addEventListener("mouseleave", scheduleClose);

  rail.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-rail]");
    if (!button) return;
    const action = button.dataset.rail;
    if (action !== "recents") closeRecents();
    switch (action) {
      case "expand": onExpand(); break;
      case "new": onNew(); break;
      // 带上按钮本身:悬浮搜索框把它当 invoker,再点一次是关。
      case "search": onSearch(button); break;
      case "settings": onSettings(); break;
      case "recents":
        // 悬停已经打开时点一下是关;关着时点开,焦点落到第一项,键盘可直接上下选。
        if (open) closeRecents();
        else {
          openRecents();
          menu?.querySelector(".menu-item")?.focus();
        }
        break;
      default: break;
    }
  });

  function relabel() {
    rail.setAttribute("aria-label", t("sidebar.label"));
    menu?.setAttribute("aria-label", t("sidebar.recents"));
    for (const button of rail.querySelectorAll("[data-rail]")) {
      const label = t(RAIL_LABEL_KEYS[button.dataset.rail]);
      const shortcut = button.dataset.rail === "new" ? shortcutLabels?.newSession
        : button.dataset.rail === "expand" ? shortcutLabels?.history : "";
      button.setAttribute("aria-label", label);
      button.title = shortcut ? `${label} (${shortcut})` : label;
    }
    for (const button of rail.querySelectorAll("[data-main-surface]")) {
      const label = t(SURFACE_LABEL_KEYS[button.dataset.mainSurface] ?? "");
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }
  relabel();

  return { relabel, closeRecents, refreshRecents, isRecentsOpen: () => open };
}
