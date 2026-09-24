// 会话抽屉底部的「已归档会话」入口,以及它打开的归档列表。
//
// 对齐 macOS ArchivedSessionsButton / ArchivedSessionsView:
//
// - **入口钉在抽屉最底部**,不随列表滚动 —— 归档行被会话列表滤掉了,这里是它们
//   唯一的入口,折进视图选项菜单就等于藏起来了。
// - **数据口径**:权威归档集合(宿主注册表的 archivedSessionIds)与手上的会话
//   摘要求交成行,最近归档的在前;摘要已不存在的成员不出行(不留一个点不动的
//   取消归档按钮)。搜索按标题或工作区名过滤。每行一个「取消归档」。
// - **三种空态**:没有归档 / 归档集合非空却一行都拼不出来 / 搜索无匹配。
//
// 与 Mac 的一处不同:Mac 开独立窗口,好让会话列表留在旁边看到"那一行回来了";
// 侧栏只有一栏宽,所以这里是抽屉内的一页,带返回按钮 —— 返回时列表里已经能看到
// 刚恢复的会话。

import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/md-to-html.js";
import { lucideIconSvg } from "../../features/chat/file-icons.js";
import { formatRelativeTime } from "../../features/sessions/session-row-trailing.js";
import { itemTitle } from "./session-drawer-view.js";

/**
 * @param {object} options
 * @param {Element} options.drawer 会话抽屉 <aside>。
 * @param {object} options.sessions 会话服务(archivedItems / archivedSessionIds / onArchivedChange / unarchive)。
 * @param {() => Array} options.workspaces 当前 workspace 名单(给行取工作区名)。
 * @param {(message: string) => void} [options.showToast]
 * @param {() => void} [options.onBack] 回到会话列表后(把焦点还给列表搜索框)。
 */
export function mountArchivedSessions({ drawer, sessions, workspaces = () => [], showToast = null, onBack = null }) {
  /// 正在等取消归档 RPC 的行:按钮换成进行中,防止连点;失败时保留该行可重试。
  const restoring = new Set();

  const entry = document.createElement("button");
  entry.id = "history-archived-btn";
  entry.type = "button";

  const pane = document.createElement("section");
  pane.id = "archived-pane";
  pane.hidden = true;
  pane.innerHTML = [
    `<div id="archived-head">`,
    `<button class="hdr-btn" id="archived-back" type="button">${lucideIconSvg("chevron-left", { size: 15 })}</button>`,
    `<span id="archived-title"></span>`,
    `</div>`,
    `<div id="archived-search-wrap"><input id="archived-search" type="text" autocomplete="off" spellcheck="false" /></div>`,
    `<ul id="archived-list" role="list"></ul>`
  ].join("");
  drawer.append(entry, pane);

  const back = pane.querySelector("#archived-back");
  const titleNode = pane.querySelector("#archived-title");
  const search = pane.querySelector("#archived-search");
  const list = pane.querySelector("#archived-list");

  const isActive = () => drawer.classList.contains("archived-mode");

  function relabel() {
    const label = t("sessions.archived");
    entry.innerHTML = `${lucideIconSvg("archive", { size: 14 })}<span>${escapeHtml(label)}</span>`;
    entry.title = label;
    titleNode.textContent = label;
    back.title = t("sessions.archivedBack");
    back.setAttribute("aria-label", t("sessions.archivedBack"));
    search.placeholder = t("sessions.archivedSearch");
    if (isActive()) render();
  }

  /// 工作区显示名:工作区标题,其次路径末段,其次 cwd 末段;都没有 = 未分组。
  function workspaceName(item) {
    const owner = (workspaces() ?? []).find((row) => (row.sessionIds ?? []).includes(item.sessionId));
    return owner?.title || basename(owner?.path) || basename(item.cwd) || t("sessions.groupUngrouped");
  }

  function render() {
    const rows = sessions?.archivedItems?.() ?? [];
    const query = search.value.trim().toLowerCase();
    const visible = query
      ? rows.filter((item) => itemTitle(item).toLowerCase().includes(query)
        || workspaceName(item).toLowerCase().includes(query))
      : rows;
    if (!visible.length) {
      list.innerHTML = `<li class="history-empty">${escapeHtml(emptyLabel(rows))}</li>`;
      return;
    }
    list.innerHTML = visible.map((item) => {
      const title = itemTitle(item);
      const busy = restoring.has(item.sessionId);
      const meta = `${workspaceName(item)} · ${formatRelativeTime(item.updatedAt ?? Date.now(), t)}`;
      return [
        `<li class="archived-item${busy ? " is-busy" : ""}" data-session-id="${escapeHtml(item.sessionId)}">`,
        `<div class="archived-text">`,
        `<span class="archived-name" title="${escapeHtml(title)}">${escapeHtml(title)}</span>`,
        `<span class="archived-meta">${escapeHtml(meta)}</span>`,
        `</div>`,
        `<button type="button" class="archived-restore" data-action="unarchive"${busy ? " disabled" : ""}`,
        ` aria-label="${escapeHtml(t("sessions.unarchiveNamed", { title }))}">`,
        escapeHtml(busy ? t("sessions.unarchiving") : t("sessions.unarchive")),
        `</button>`,
        `</li>`
      ].join("");
    }).join("");
  }

  function emptyLabel(rows) {
    if (rows.length) return t("sessions.archivedNoMatch");
    return (sessions?.archivedSessionIds?.() ?? []).length
      ? t("sessions.archivedUnavailable")
      : t("sessions.archivedEmpty");
  }

  async function unarchive(sessionId) {
    if (!sessionId || restoring.has(sessionId)) return;
    restoring.add(sessionId);
    render();
    try {
      await sessions.unarchive(sessionId);
    } catch {
      // 老宿主(0.1.6 之前)没有这个 RPC,也会走到这里 —— 给提示而不是悄悄不动。
      showToast?.(t("sessions.unarchiveFailed"));
    } finally {
      restoring.delete(sessionId);
      if (isActive()) render();
    }
  }

  function open() {
    drawer.classList.add("archived-mode");
    pane.hidden = false;
    search.value = "";
    render();
    requestAnimationFrame(() => search.focus());
  }

  /// 回到会话列表。restoreFocus=false 用于抽屉重新打开时的静默复位。
  function close({ restoreFocus = true } = {}) {
    if (!isActive()) return;
    drawer.classList.remove("archived-mode");
    pane.hidden = true;
    if (restoreFocus) onBack?.();
  }

  entry.addEventListener("click", open);
  back.addEventListener("click", () => close());
  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.isComposing || event.key !== "Escape") return;
    // 只退回会话列表,不关抽屉:与返回按钮同义。
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest('button[data-action="unarchive"]');
    if (button) void unarchive(button.closest("[data-session-id]")?.dataset.sessionId);
  });
  sessions?.onArchivedChange?.(() => { if (isActive()) render(); });

  relabel();
  return { open, close, isActive, relabel };
}

function basename(path) {
  return String(path || "").replace(/\/+$/, "").split("/").pop() || "";
}
