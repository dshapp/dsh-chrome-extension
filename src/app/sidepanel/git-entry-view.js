// Git 入口用到的图标与行渲染。
//
// 从 git-entry.js 拆出来只为守住单文件 300 行的上限;这里全是无状态的字符串
// 拼装,与「入口何时出现、点了做什么」那些决策分开读更清楚。
import { lucideIconSvg } from "../../features/chat/file-icons.js";

/// linked worktree 用堆叠图标,普通 checkout 用分支图标 —— 与 Mac 的
/// `square.stack` / `arrow.triangle.branch` 一一对应,让两种位置一眼可辨。
export const ICON_WORKTREE = lucideIconSvg("layers", { size: 13 });
export const ICON_BRANCH = lucideIconSvg("git-branch", { size: 13 });

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/// popover 里的一行。所有行同高同内距,让当前分支、分支列表、新建、push/pull
/// 读起来是一个列表而不是四种控件。
export function row({ id, name, trailing = "", trailingHtml = "", icon = "", checked = false, disabled = false, title = "" }) {
  return `<button class="git-row" type="button" id="${id}"${disabled ? " disabled" : ""}`
    + `${title ? ` title="${escapeHtml(title)}"` : ""}>`
    + (icon ? `<span class="git-row-icon" aria-hidden="true">${icon}</span>` : "")
    + `<span class="git-row-name">${escapeHtml(name)}</span>`
    + (trailingHtml || trailing
      ? `<span class="git-row-trailing">${trailingHtml || escapeHtml(trailing)}</span>`
      : "")
    + (checked ? `<span class="git-row-check" aria-hidden="true">${lucideIconSvg("check", { size: 13 })}</span>` : "")
    + `</button>`;
}
