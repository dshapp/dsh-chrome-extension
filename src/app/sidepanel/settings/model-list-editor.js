// 提供方模型目录的共享编辑器(编辑与新增两张卡片都用它),对齐 web 的
// ModelListEditor / DeepSeekModelsEditor:
//
// - 一行只直接暴露 id 与显示名称,上下文 / 输出上限折叠在行内的容量面板里;
// - 编辑器只拥有 id / 名称 / 两个容量字段,行里其余字段(description、compat、
//   inputModalities 等)原样保留 —— 以前整表重写成 {id,name,contextWindow,
//   maxTokens,input},把宿主字段冲掉了,还会给 deepseek 写入它并不认识的 input;
// - 「获取可用模型」把候选列成勾选面板,由用户确认后再并入目录,而不是发现有
//   什么就直接写进配置;
// - 只有注册了模型发现的适配器(llm-pi-ai)才给拉取入口。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import {
  catalogRowFromModel, catalogRowToModel, validateCatalogRows,
  parseCapacitySpelling, formatCapacitySpelling
} from "../../../features/settings/settings-service.js";
import { escapeHtml, button, notice } from "./settings-ui.js";

/// 折叠面板打开时,容量字段的占位提示(web 用 256K / 32K)。
const CAPACITY_HINT = { contextWindow: "256K", maxTokens: "32K" };

/// 查找一条候选是否已在目录里(按 id 归一)。
function knownIds(rows) {
  return new Set(rows.map((row) => String(row.modelId ?? "").trim()).filter(Boolean));
}

/**
 * 建一个模型目录编辑器。
 * @param {object} options
 * @param {object} options.context 每次渲染时读取的表单上下文:
 *   { disabled, probeBlocked, probe, probeEnabled, capacityPlaceholders }
 * @param {(request: object) => Promise<{models: object[]}>} options.discover
 * @param {(mode: "soft"|"hard") => void} options.requestRender 重画回调
 * @param {(error: unknown) => string} options.formatErrorDetails
 * @param {boolean} options.allowFetch 该适配器是否注册了模型发现(仅 pi-ai)
 */
export function createModelCatalogEditor({ context, discover, requestRender, formatErrorDetails, allowFetch }) {
  const state = {
    rows: [],
    owned: false,
    touched: false,
    expanded: new Set(),
    buffers: new Map(),
    candidates: null,
    picked: new Set(),
    query: "",
    fetching: false,
    failure: undefined
  };

  const bufferKey = (index, field) => index + ":" + field;

  function capacityText(row, index, field) {
    const typed = state.buffers.get(bufferKey(index, field));
    if (typed !== undefined) return typed;
    const value = row[field];
    return typeof value === "string" ? value : "";
  }

  /// 容量字段失焦后,把能识别的拼写收敛成标准写法。
  function settleCapacity(index, field) {
    const key = bufferKey(index, field);
    const typed = state.buffers.get(key);
    if (typed === undefined) return;
    const parsed = parseCapacitySpelling(typed);
    if (parsed !== null && String(typed).trim()) {
      state.rows[index][field] = formatCapacitySpelling(parsed);
    }
    state.buffers.delete(key);
  }

  function setRows(rows, owned) {
    state.rows = rows;
    state.owned = owned;
    state.touched = false;
    state.buffers.clear();
    state.expanded.clear();
    state.failure = undefined;
  }

  function reset() {
    state.rows = [];
    state.owned = false;
    state.touched = true;
    state.buffers.clear();
    state.expanded.clear();
    state.failure = undefined;
  }

  function validation() {
    return validateCatalogRows(state.rows);
  }

  /// 折回宿主模型对象数组(丢掉空 id 的行)。
  function models() {
    return state.rows
      .filter((row) => String(row.modelId ?? "").trim())
      .map((row) => catalogRowToModel(row));
  }

  function visibleCandidates() {
    const list = state.candidates ?? [];
    const needle = state.query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((candidate) =>
      String(candidate.id ?? "").toLowerCase().includes(needle)
      || String(candidate.name ?? "").toLowerCase().includes(needle));
  }

  function rowHtml(row, index) {
    const open = state.expanded.has(index);
    const placeholders = context().capacityPlaceholders ?? {};
    return '<div class="mle-entry">'
      + '<div class="mle-row">'
      + '<input class="set-input" id="mle-id-' + index + '" type="text" value="' + escapeHtml(row.modelId)
      + '" placeholder="' + escapeHtml(t("cat.columnId")) + '" aria-label="' + escapeHtml(t("cat.columnId") + " " + (index + 1)) + '" />'
      + '<input class="set-input" id="mle-name-' + index + '" type="text" value="' + escapeHtml(row.name)
      + '" placeholder="' + escapeHtml(t("cat.columnName")) + '" aria-label="' + escapeHtml(t("cat.columnName") + " " + (index + 1)) + '" />'
      + '<button class="set-icon-btn" type="button" id="mle-exp-' + index + '" title="' + escapeHtml(t("cat.capacity"))
      + '" aria-label="' + escapeHtml(t("cat.capacity") + " " + (index + 1)) + '" aria-expanded="' + String(open) + '">'
      + lucideIconSvg(open ? "chevron-down" : "chevron-right", { size: 14 }) + "</button>"
      + '<button class="set-icon-btn danger" type="button" id="mle-del-' + index + '" title="' + escapeHtml(t("cat.remove"))
      + '" aria-label="' + escapeHtml(t("cat.remove") + " " + (index + 1)) + '">'
      + lucideIconSvg("trash-2", { size: 14 }) + "</button>"
      + "</div>"
      + (open
        ? '<div class="mle-advanced">'
          + capacityField(row, index, "contextWindow", placeholders.contextWindow)
          + capacityField(row, index, "maxTokens", placeholders.maxTokens)
          + "</div>"
        : "")
      + "</div>";
  }

  function capacityField(row, index, field, placeholder) {
    const label = field === "contextWindow" ? t("cat.columnContext") : t("cat.columnMaxOutput");
    return '<label class="mle-field"><span class="mle-field-label">' + escapeHtml(label) + "</span>"
      + '<input class="set-input" id="mle-' + (field === "contextWindow" ? "ctx" : "max") + "-" + index + '" type="text" inputmode="numeric"'
      + ' value="' + escapeHtml(capacityText(row, index, field)) + '"'
      + ' placeholder="' + escapeHtml(placeholder || CAPACITY_HINT[field]) + '"'
      + ' aria-label="' + escapeHtml(label + " " + (index + 1)) + '" /></label>';
  }

  function pickerHtml() {
    const visible = visibleCandidates();
    const allPicked = visible.length > 0 && visible.every((candidate) => state.picked.has(candidate.id));
    return '<div class="mle-picker">'
      + '<div class="mle-picker-head">'
      + '<input class="set-input" id="mle-search" type="search" value="' + escapeHtml(state.query)
      + '" placeholder="' + escapeHtml(t("cat.fetchSearch")) + '" aria-label="' + escapeHtml(t("cat.fetchSearch")) + '" />'
      + '<button class="set-btn" type="button" id="mle-selectall"' + (visible.length ? "" : " disabled") + ">"
      + escapeHtml(allPicked ? t("cat.fetchDeselectAll") : t("cat.fetchSelectAll")) + "</button>"
      + "</div>"
      + (visible.length
        ? '<div class="mle-candidates">' + visible.map((candidate) => (
          '<label class="mle-candidate"><input type="checkbox" data-candidate="' + escapeHtml(candidate.id) + '"'
          + (state.picked.has(candidate.id) ? " checked" : "") + " />"
          + '<span class="mle-candidate-id">' + escapeHtml(candidate.id) + "</span></label>"
        )).join("") + "</div>"
        : '<div class="set-row-hint">' + escapeHtml(t("cat.fetchNoMatches")) + "</div>")
      + '<div class="mle-picker-actions">'
      + button({ id: "mle-picker-cancel", label: t("set.cancel") })
      + button({ id: "mle-picker-adopt", label: t("cat.fetchAdopt"), kind: "primary" })
      + "</div></div>";
  }

  function headHtml() {
    const meta = state.owned ? t("cat.overridden") : t("cat.inherited");
    const ctx = context();
    const canReset = allowFetch && state.owned;
    const fetchDisabled = ctx.disabled || state.fetching || !allowFetch || !ctx.probeEnabled || ctx.probeBlocked !== undefined;
    const fetchTitle = !allowFetch ? ""
      : ctx.probeBlocked !== undefined ? t(ctx.probeBlocked)
        : ctx.probeEnabled ? undefined : t("cat.fetchNeedsBaseUrl");
    return '<div class="mle-head">'
      + '<div class="mle-heading"><span class="mle-title">' + escapeHtml(t("cat.title")) + '</span>'
      + '<span class="mle-meta">' + escapeHtml(meta) + "</span></div>"
      + (canReset
        ? '<button class="set-link" type="button" id="mle-reset"' + (ctx.disabled ? " disabled" : "") + ">"
          + escapeHtml(t("cat.restoreDefaults")) + "</button>"
        : "")
      + (allowFetch
        ? '<button class="set-link" type="button" id="mle-fetch"' + (fetchDisabled ? " disabled" : "")
          + (fetchTitle ? ' title="' + escapeHtml(fetchTitle) + '"' : "") + ">"
          + escapeHtml(state.fetching ? t("cat.fetching") : t("cat.fetch")) + "</button>"
        : "")
      + "</div>";
  }

  function html() {
    const ctx = context();
    const rowsHtml = state.rows.map(rowHtml).join("");
    return '<section class="set-section" id="mle-root">'
      + headHtml()
      + '<div class="set-section-body">'
      + (state.candidates ? pickerHtml() : "")
      + (rowsHtml || '<div class="set-row-hint mle-empty">' + escapeHtml(t("cat.emptyFooter")) + "</div>")
      + '<div class="cat-actions"><button class="set-btn" type="button" id="mle-add"' + (ctx.disabled ? " disabled" : "") + ">"
      + lucideIconSvg("plus", { size: 13 }) + " " + escapeHtml(t("cat.add")) + "</button></div>"
      + (state.failure ? notice(state.failure) : "")
      + '<div class="set-section-footer">' + escapeHtml(t("cat.footer")) + "</div>"
      + "</div></section>";
  }

  async function fetchModels() {
    if (state.fetching) return;
    state.fetching = true;
    state.failure = undefined;
    requestRender("hard");
    try {
      const answer = await discover(context().probe);
      const found = Array.isArray(answer?.models) ? answer.models : [];
      if (!found.length) {
        state.failure = t("cat.discoveryNone");
        return;
      }
      const known = knownIds(state.rows);
      state.candidates = found;
      state.query = "";
      state.picked = new Set(found.filter((candidate) => !known.has(candidate.id)).map((candidate) => candidate.id));
    } catch (error) {
      state.failure = formatErrorDetails(error);
    } finally {
      state.fetching = false;
      requestRender("hard");
    }
  }

  function closePicker() {
    state.candidates = null;
    state.picked = new Set();
    state.query = "";
    requestRender("hard");
  }

  function adoptPicked() {
    const candidates = state.candidates ?? [];
    const byId = new Map(state.rows.map((row) => [String(row.modelId ?? "").trim(), row]));
    for (const candidate of candidates) {
      if (!state.picked.has(candidate.id)) continue;
      if (!byId.has(candidate.id)) byId.set(candidate.id, catalogRowFromModel(candidate));
    }
    state.rows = [...byId.values()];
    state.owned = true; state.touched = true;
    closePicker();
  }

  function bind(root) {
    const ctx = context();
    state.rows.forEach((row, index) => {
      const wireRow = (id, key, settle) => {
        const input = root.querySelector("#" + id);
        input?.addEventListener("input", (event) => {
          row[key] = event.target.value;
          state.owned = true; state.touched = true;
          requestRender("soft");
        });
        if (settle) input?.addEventListener("blur", () => { settleCapacity(index, key); });
      };
      wireRow("mle-id-" + index, "modelId", false);
      wireRow("mle-name-" + index, "name", false);
      const ctxInput = root.querySelector("#mle-ctx-" + index);
      ctxInput?.addEventListener("input", (event) => {
        state.buffers.set(bufferKey(index, "contextWindow"), event.target.value);
        row.contextWindow = event.target.value;
        state.owned = true; state.touched = true;
        requestRender("soft");
      });
      ctxInput?.addEventListener("blur", () => { settleCapacity(index, "contextWindow"); });
      const maxInput = root.querySelector("#mle-max-" + index);
      maxInput?.addEventListener("input", (event) => {
        state.buffers.set(bufferKey(index, "maxTokens"), event.target.value);
        row.maxTokens = event.target.value;
        state.owned = true; state.touched = true;
        requestRender("soft");
      });
      maxInput?.addEventListener("blur", () => { settleCapacity(index, "maxTokens"); });
      root.querySelector("#mle-exp-" + index)?.addEventListener("click", () => {
        if (state.expanded.has(index)) state.expanded.delete(index);
        else state.expanded.add(index);
        requestRender("hard");
      });
      root.querySelector("#mle-del-" + index)?.addEventListener("click", () => {
        state.rows.splice(index, 1);
        state.buffers.clear();
        const next = new Set();
        for (const at of state.expanded) {
          if (at < index) next.add(at);
          else if (at > index) next.add(at - 1);
        }
        state.expanded = next;
        state.owned = true; state.touched = true;
        requestRender("hard");
      });
    });
    root.querySelector("#mle-add")?.addEventListener("click", () => {
      state.rows.push(catalogRowFromModel({}));
      state.owned = true; state.touched = true;
      requestRender("hard");
    });
    root.querySelector("#mle-reset")?.addEventListener("click", () => {
      reset();
      requestRender("hard");
    });
    root.querySelector("#mle-fetch")?.addEventListener("click", () => { void fetchModels(); });
    root.querySelector("#mle-picker-cancel")?.addEventListener("click", closePicker);
    root.querySelector("#mle-picker-adopt")?.addEventListener("click", adoptPicked);
    const search = root.querySelector("#mle-search");
    search?.addEventListener("input", (event) => {
      state.query = event.target.value;
      // 重画会换掉整个 DOM,记下待恢复的焦点,在下次 bind 时落到新输入框上。
      state.focusSearch = true;
      requestRender("hard");
    });
    root.querySelector("#mle-selectall")?.addEventListener("click", () => {
      const visible = visibleCandidates();
      const allPicked = visible.length > 0 && visible.every((candidate) => state.picked.has(candidate.id));
      state.picked = allPicked ? new Set() : new Set(visible.map((candidate) => candidate.id));
      requestRender("hard");
    });
    for (const checkbox of root.querySelectorAll("[data-candidate]")) {
      checkbox.addEventListener("change", (event) => {
        const id = event.target.dataset.candidate;
        if (event.target.checked) state.picked.add(id);
        else state.picked.delete(id);
        requestRender("hard");
      });
    }
    if (state.focusSearch) {
      state.focusSearch = false;
      const next = root.querySelector("#mle-search");
      if (next) {
        next.focus();
        const end = next.value.length;
        next.setSelectionRange(end, end);
      }
    }
  }

  /// 只同步按钮可用态,不重画输入框 —— 供调用方在软刷新时使用。
  function syncChrome(root) {
    const ctx = context();
    const fetch = root.querySelector("#mle-fetch");
    if (fetch) {
      fetch.disabled = ctx.disabled || state.fetching || !allowFetch || !ctx.probeEnabled || ctx.probeBlocked !== undefined;
      if (!allowFetch) fetch.hidden = true;
    }
    const add = root.querySelector("#mle-add");
    if (add) add.disabled = ctx.disabled;
  }

  return {
    state, setRows, reset, validation, models, html, bind, syncChrome,
    get rows() { return state.rows; },
    get owned() { return state.owned; },
    get touched() { return state.touched; }
  };
}
