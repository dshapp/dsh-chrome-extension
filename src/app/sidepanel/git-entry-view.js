// Git 入口用到的图标与行渲染。
//
// 从 git-entry.js 拆出来只为守住单文件 300 行的上限;这里全是无状态的字符串
// 拼装,与「入口何时出现、点了做什么」那些决策分开读更清楚。

/// linked worktree 用堆叠图标,普通 checkout 用分支图标 —— 与 Mac 的
/// `square.stack` / `arrow.triangle.branch` 一一对应,让两种位置一眼可辨。
export const ICON_WORKTREE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="6" rx="1"/><rect x="3" y="11" width="18" height="6" rx="1"/><path d="M7 19h10"/></svg>`;
export const ICON_BRANCH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/// popover 里的一行。所有行同高同内距,让当前分支、分支列表、新建、push/pull
/// 读起来是一个列表而不是四种控件。
export function row({ id, name, trailing = "", icon = "", checked = false, disabled = false, title = "" }) {
  return `<button class="git-row" type="button" id="${id}"${disabled ? " disabled" : ""}`
    + `${title ? ` title="${escapeHtml(title)}"` : ""}>`
    + (icon ? `<span class="git-row-icon" aria-hidden="true">${icon}</span>` : "")
    + `<span class="git-row-name">${escapeHtml(name)}</span>`
    + (trailing ? `<span class="git-row-trailing">${escapeHtml(trailing)}</span>` : "")
    + (checked ? `<span class="git-row-check" aria-hidden="true">✓</span>` : "")
    + `</button>`;
}
