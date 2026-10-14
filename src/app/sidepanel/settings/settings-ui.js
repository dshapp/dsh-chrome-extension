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

/// 选择器里的 id 片段转义。
///
/// 大部分环境有 CSS.escape,但 jsdom 下 globalThis.CSS 不存在 —— 而这里拼的
/// id 里本来就只有 bundle 名/预设 id 这类字符,所以自带一份实现比依赖全局更稳。
export function selectorEscape(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, (char) => "\\" + char);
}

/// 提供方行的显示名。账号路由的宿主名是纯英文,与 web 一致地本地化
/// (对齐 Mac modelProviderDisplayName)。
export function providerDisplayName(entry) {
  if (entry?.provider === "deepseek-account") return t("prov.deepSeekAccount");
  return entry?.displayName || entry?.provider || "";
}

/// 一个分组(Mac Section):可选表头与表尾说明。
/// header 走转义,headerHtml 原样插入 —— 分组标题要带数量徽标(groupHeader),
/// 那已经是一段 HTML,再转义一次就会把标签显示成文字。
export function section({ header, headerHtml, footer, body, id } = {}) {
  const head = headerHtml ?? (header ? escapeHtml(header) : "");
  return `<div class="set-section"${id ? ` id="${escapeHtml(id)}"` : ""}>`
    + (head ? `<div class="set-section-header">${head}</div>` : "")
    + `<div class="set-section-body">${body ?? ""}</div>`
    + (footer ? `<div class="set-section-footer">${footer}</div>` : "")
    + `</div>`;
}

/// 一行(Mac LabeledContent):左侧标题 + 副标题,右侧控件。
/// control 为空时整行只是说明文字。
/// leading:行首的识别块(头像 / 图标),不参与文字截断。
export function row({ label, hint, control, id, extra, clickable, leading, className } = {}) {
  return `<div class="set-row${clickable ? " clickable" : ""}${className ? " " + className : ""}"${id ? ` id="${escapeHtml(id)}"` : ""}`
    + `${clickable ? ' role="button" tabindex="0"' : ""}>`
    + (leading ?? "")
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

export function textInput({ id, value, placeholder, type = "text", disabled, mono, autocomplete }) {
  return `<input class="set-input${mono ? " mono" : ""}" id="${escapeHtml(id)}" type="${type}"`
    + ` value="${escapeHtml(value ?? "")}" placeholder="${escapeHtml(placeholder ?? "")}"`
    + `${autocomplete ? ` autocomplete="${escapeHtml(autocomplete)}"` : ""}`
    + `${disabled ? " disabled" : ""} />`;
}

/// 密钥输入:password 输入框 + 行尾「显示 / 隐藏」切换。切换只改 input.type,
/// 不重画,所以正在输入的值和光标都不受影响;revealed 让重画后保持上次的可见态。
export function secretInput({ id, value, placeholder, disabled, revealed = false }) {
  const label = t(revealed ? "set.secretHide" : "set.secretShow");
  return `<div class="set-secret">`
    + textInput({ id, value, placeholder, disabled, type: revealed ? "text" : "password", autocomplete: "new-password", mono: true })
    + `<button class="set-secret-toggle" type="button" data-secret-toggle="${escapeHtml(id)}"`
    + ` aria-pressed="${revealed}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">`
    + lucideIconSvg(revealed ? "eye-off" : "eye", { size: 14 }) + `</button></div>`;
}

/// 绑定 root 下所有密钥显隐切换。onToggle(id, revealed) 让调用方记住可见态。
export function bindSecretToggles(root, onToggle) {
  for (const toggleButton of root.querySelectorAll("[data-secret-toggle]")) {
    toggleButton.addEventListener("click", () => {
      const input = root.querySelector(`#${selectorEscape(toggleButton.dataset.secretToggle)}`);
      if (!input) return;
      const revealed = input.type === "password";
      input.type = revealed ? "text" : "password";
      const label = t(revealed ? "set.secretHide" : "set.secretShow");
      toggleButton.setAttribute("aria-pressed", String(revealed));
      toggleButton.title = label;
      toggleButton.setAttribute("aria-label", label);
      toggleButton.innerHTML = lucideIconSvg(revealed ? "eye-off" : "eye", { size: 14 });
      onToggle?.(toggleButton.dataset.secretToggle, revealed);
    });
  }
}

/// 带放大镜与清除键的搜索框。清除键只在有内容时出现。
export function searchField({ id, value, placeholder, clearId, clearLabel }) {
  return `<div class="set-search">`
    + `<span class="set-search-icon" aria-hidden="true">${lucideIconSvg("search", { size: 13 })}</span>`
    + `<input class="set-input set-search-input" id="${escapeHtml(id)}" type="text"`
    + ` value="${escapeHtml(value ?? "")}" placeholder="${escapeHtml(placeholder ?? "")}"`
    + ` aria-label="${escapeHtml(placeholder ?? "")}" autocomplete="off" spellcheck="false" />`
    + (value && clearId
      ? `<button class="set-search-clear" type="button" id="${escapeHtml(clearId)}"`
        + ` title="${escapeHtml(clearLabel ?? "")}" aria-label="${escapeHtml(clearLabel ?? "")}">`
        + `${lucideIconSvg("x", { size: 13 })}</button>`
      : "")
    + `</div>`;
}

/// 分段选择(筛选条)。options: [{ value, label, count }]。
export function segmented({ id, options, value, ariaLabel }) {
  return `<div class="set-segmented" role="radiogroup"${id ? ` id="${escapeHtml(id)}"` : ""}`
    + ` aria-label="${escapeHtml(ariaLabel ?? "")}">`
    + options.map((option) => {
      const active = option.value === value;
      return `<button class="set-segment${active ? " active" : ""}" type="button" role="radio"`
        + ` aria-checked="${active}" data-segment="${escapeHtml(option.value)}">`
        + `<span>${escapeHtml(option.label)}</span>`
        + (option.count !== undefined ? `<span class="set-segment-count">${escapeHtml(String(option.count))}</span>` : "")
        + `</button>`;
    }).join("")
    + `</div>`;
}

/// 名字的首字母头像:色相按名字散列,同一个提供方 / 插件每次都是同一种颜色,
/// 长列表里靠颜色 + 字母就能快速扫到目标。icon 给定时画图标而不是字母。
export function avatar(name, { icon, size = "" } = {}) {
  const text = String(name ?? "").trim();
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const glyph = icon
    ? lucideIconSvg(icon, { size: 14 })
    : escapeHtml((text.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase());
  return `<span class="set-avatar${size ? " " + size : ""}${icon ? " icon" : ""}" style="--avatar-hue:${hash % 360}" aria-hidden="true">${glyph}</span>`;
}

/// 行尾的装饰性雪佛龙:整行就是点击目标,它只是一个"可进入"的提示。
export function chevron() {
  return `<span class="set-chevron" aria-hidden="true">${lucideIconSvg("chevron-right", { size: 14 })}</span>`;
}

/// 返回链接(详情页左上角):图标 + 上一级的名字。
export function backLink({ id, label }) {
  return `<button class="set-back" type="button" id="${escapeHtml(id)}">`
    + lucideIconSvg("chevron-left", { size: 14 }) + `<span>${escapeHtml(label)}</span></button>`;
}

/// 忙碌指示(行内小转圈)。
export function busyIndicator(label) {
  return `<span class="set-spinner" role="status" aria-label="${escapeHtml(label ?? "")}"></span>`;
}

/// 可点击行的键盘契约:Enter / 空格等同点击(行是 role=button 的 div)。
/// 只在焦点就在行本身上时生效,行内的开关 / 按钮保持各自的键盘行为。
export function bindClickableRows(root) {
  for (const element of root.querySelectorAll(".set-row.clickable")) {
    element.addEventListener("keydown", (event) => {
      if (event.target !== element || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      element.click();
    });
  }
}

/// 行内的独立控件(开关、按钮、链接)不应触发整行的点击。
export function isRowControlTarget(event) {
  return Boolean(event.target?.closest?.("button, .set-switch, input, select, a, label"));
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

/// 带图标的一行状态文字(Mac 的 Label(text, systemImage:))。提供方行的
/// "已配置 / 无需密钥 / 缺少密钥"在 Mac 那边是彩色符号 + 文字,不是色点。
export function iconStatusLine(text, kind, icon) {
  return `<span class="set-icon-status ${kind}">${icon ? lucideIconSvg(icon, { size: 12 }) : ""}${escapeHtml(text)}</span>`;
}

/// 外观的三块色板(Mac 的 ThemeCube)。每块是一张 48×48 的方形预览 + 名称,
/// 选中态靠 `.active` 描边;预览块本身用半色/全色区分浅色与深色,
/// 跟随系统画成左浅右深的一刀切。
const THEME_CUBES = [
  { value: "light", icon: "sun", swatch: "light" },
  { value: "dark", icon: "moon", swatch: "dark" },
  { value: "system", icon: "circle-half", swatch: "system" }
];

export function themeCubes({ id, value, disabled }) {
  const cubes = THEME_CUBES.map((cube) => {
    const label = t("set.appearance." + cube.value);
    return `<button class="set-theme-cube${cube.value === value ? " active" : ""}" type="button"`
      + ` data-theme-cube="${cube.value}"${disabled ? " disabled" : ""}`
      + ` aria-pressed="${cube.value === value}" title="${escapeHtml(label)}">`
      + `<span class="set-theme-cube-swatch ${cube.swatch}" aria-hidden="true">`
      + `${lucideIconSvg(cube.icon, { size: 14 })}</span>`
      + `<span class="set-theme-cube-label">${escapeHtml(label)}</span>`
      + `</button>`;
  }).join("");
  return `<div class="set-theme-cubes"${id ? ` id="${escapeHtml(id)}"` : ""}>${cubes}</div>`;
}

/// 一个带数量徽标的分组标题(Mac PluginsPage 的 group(title:count:) )。
export function groupHeader(title, count, id) {
  return `<div class="set-group-header"${id ? ` id="${escapeHtml(id)}"` : ""}>`
    + `<span class="set-group-title">${escapeHtml(title)}</span>`
    + `<span class="set-group-count">${escapeHtml(String(count))}</span></div>`;
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
