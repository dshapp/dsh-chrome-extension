// 设置页共用的渲染原语。Mac 那边每个 pane 都是一个 grouped Form,行是
// LabeledContent(标题 + 副标题 + 尾随控件);这里用同样的三段结构落成 DOM,
// 让五个 pane 的行高、副标题灰度、控件对齐一次定义、处处一致。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/// 一个分组(Mac Section):可选表头与表尾说明。
export function section({ header, footer, body, id } = {}) {
  return `<div class="set-section"${id ? ` id="${escapeHtml(id)}"` : ""}>`
    + (header ? `<div class="set-section-header">${escapeHtml(header)}</div>` : "")
    + `<div class="set-section-body">${body ?? ""}</div>`
    + (footer ? `<div class="set-section-footer">${footer}</div>` : "")
    + `</div>`;
}

/// 一行(Mac LabeledContent):左侧标题 + 副标题,右侧控件。
/// control 为空时整行只是说明文字。
export function row({ label, hint, control, id, extra } = {}) {
  return `<div class="set-row"${id ? ` id="${escapeHtml(id)}"` : ""}>`
    + `<div class="set-row-text">`
    + (label ? `<div class="set-row-label">${label}</div>` : "")
    + (hint ? `<div class="set-row-hint">${hint}</div>` : "")
    + (extra ?? "")
    + `</div>`
    + (control ? `<div class="set-row-control">${control}</div>` : "")
    + `</div>`;
}

/// 竖排行:控件占满整行宽度(输入框、表格这类挤不进尾随位置的控件)。
export function stackedRow({ label, hint, control, id } = {}) {
  return `<div class="set-row stacked"${id ? ` id="${escapeHtml(id)}"` : ""}>`
    + `<div class="set-row-text">`
    + (label ? `<div class="set-row-label">${label}</div>` : "")
    + (hint ? `<div class="set-row-hint">${hint}</div>` : "")
    + `</div>`
    + `<div class="set-row-control wide">${control ?? ""}</div>`
    + `</div>`;
}

/// 原生 <select>。options 为 [{value,label,selected}]。
export function select({ id, options, disabled }) {
  const items = options.map((option) => (
    `<option value="${escapeHtml(option.value)}"${option.selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`
  )).join("");
  return `<select class="set-select" id="${escapeHtml(id)}"${disabled ? " disabled" : ""}>${items}</select>`;
}

export function textInput({ id, value, placeholder, type = "text", disabled, mono }) {
  return `<input class="set-input${mono ? " mono" : ""}" id="${escapeHtml(id)}" type="${type}"`
    + ` value="${escapeHtml(value ?? "")}" placeholder="${escapeHtml(placeholder ?? "")}"`
    + `${disabled ? " disabled" : ""} />`;
}

/// 开关。Mac 用 Toggle(.switch);这里是 checkbox + CSS 画的轨道。
export function toggle({ id, checked, disabled, ariaLabel }) {
  return `<label class="set-switch">`
    + `<input id="${escapeHtml(id)}" type="checkbox"${checked ? " checked" : ""}${disabled ? " disabled" : ""}`
    + ` aria-label="${escapeHtml(ariaLabel ?? "")}" />`
    + `<span class="set-switch-track" aria-hidden="true"></span>`
    + `</label>`;
}

export function button({ id, label, kind = "plain", disabled, title }) {
  return `<button class="set-btn ${kind}" type="button" id="${escapeHtml(id)}"`
    + `${disabled ? " disabled" : ""}${title ? ` title="${escapeHtml(title)}"` : ""}>`
    + `${escapeHtml(label)}</button>`;
}

/// 图标按钮(行尾的查看/复制/删除)。
export function iconButton({ id, glyph, icon, title, kind = "", disabled }) {
  return `<button class="set-icon-btn ${kind}" type="button" id="${escapeHtml(id)}"`
    + ` title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabled ? " disabled" : ""}>`
    + `${icon ? lucideIconSvg(icon, { size: 14 }) : escapeHtml(glyph ?? "")}</button>`;
}

/// 胶囊标记(自定义 / 已覆盖 / 未保存)。
export function tag(text, kind = "") {
  return `<span class="set-tag ${kind}">${escapeHtml(text)}</span>`;
}

/// 带状态点的一行状态文字(已配置 / 需要密钥 / 无需密钥)。
export function statusLine(text, kind) {
  return `<span class="set-status ${kind}"><i aria-hidden="true"></i>${escapeHtml(text)}</span>`;
}

/// 段落级错误 / 提示条。
export function notice(text, kind = "error") {
  return `<div class="set-notice ${kind}">${escapeHtml(text)}</div>`;
}

export function spinner() {
  return `<div class="set-loading">${escapeHtml(t("set.loading"))}…</div>`;
}

/// 表单页脚:放弃 / 保存(Mac PluginCardFooter)。
export function formFooter({ prefix, discardId, saveId, dirty, valid, saving }) {
  return `<div class="set-form-footer">${prefix ?? ""}<span class="set-spacer"></span>`
    + button({ id: discardId, label: t("set.discard"), kind: "plain", disabled: !dirty || saving })
    + button({
      id: saveId,
      label: saving ? t("set.saving") : t("set.save"),
      kind: "primary",
      disabled: !dirty || !valid || saving
    })
    + `</div>`;
}
