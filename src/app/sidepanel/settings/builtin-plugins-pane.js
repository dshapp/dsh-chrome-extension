// 设置页「内置插件」:宿主插件清单的只读视图。
//
// 逐条对齐 DSH web(ui-settings-plugins 的页面外壳 + ui-settings-plugin-inventory
// 的 PluginInventorySettingsTab):
//
// - 页头一句说明,下面一个搜索框,然后分两部分:
//   1. **会话插件**:由 Agent 预设按会话组成。右上角切换要看的预设(默认选宿主标
//      isDefault 的那个),列出它的组合行;默认展开。
//   2. **全局插件**:系统与所有会话共用(pluginInventory 的 entries)。启动失败的
//      排在最前,并在副标题里报失败数;默认折起 —— 它比会话插件长得多。
// - 搜索按译后的标题 / 说明与模块名、entry id 匹配,搜索期间两组都强制展开;当前
//   预设之外还有命中时,给出「其他预设中还有 N 个匹配」并可一键切过去。
// - 全局里停用、但被某些预设启用的行标为「预设中启用」,详情里列出是哪些预设,
//   并可「去预设分组查看」。
// - 每张卡片可展开看详情:entry id、完整名称、来源预设、配置状态、运行状态、禁用条件。
//
// 与 web 的差异:预设切换用原生 <select>(侧栏里不画浮层菜单);卡片网格在窄宽度下
// 退成一列。插件的装 / 卸 / 启停不在这里 —— 那是主区域「插件」管理页的事。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import { inventoryText } from "../../../features/settings/plugin-meta.js";
import { presetDisplayName } from "../composer-dock.js";
import { escapeHtml, searchField, button, notice, tag, selectorEscape } from "./settings-ui.js";

const PHASE_KEYS = {
  pending: "inv.pending",
  loading: "inv.loadingPhase",
  active: "inv.active",
  failed: "inv.failed",
  unloading: "inv.unloading"
};

/// 只有这三个阶段带点:pending 是"还没开始干活",loading / unloading 是宿主正在
/// 跑的过渡(会动)。active 不需要标记,failed 已经有失败标签(web PHASE_DOT_STATES)。
const PHASE_DOT = { pending: "muted", loading: "busy", unloading: "busy" };

/// 偏离默认的启用态才挂标签;单纯「已启用」不挂(web StateTag)。
const TAG_KIND = { disabled: "", conditional: "warn", preset: "accent", failed: "danger" };

const STATE_KEYS = {
  failed: "inv.failedTag",
  enabled: "inv.enabledTag",
  disabled: "inv.disabledTag",
  conditional: "inv.conditionalTag",
  preset: "inv.presetEnabledTag"
};

export function phaseLabel(phase) {
  return phase ? t(PHASE_KEYS[phase] ?? "inv.unobserved") : t("inv.unobserved");
}

function entrySubtitle(entryId) {
  return String(entryId ?? "").replace(/^include:/, "");
}

/// 卡片要不要单独显示 entry id:有,且去掉 include: 之后与标题不同。
function idAddsToTitle(entryId, title) {
  return entryId !== null && entryId !== undefined && entrySubtitle(entryId) !== title;
}

function matches(row, query) {
  if (!query) return true;
  const { title, description } = inventoryText(row);
  return [row.moduleName, row.entryId, title, description]
    .some((value) => String(value ?? "").toLocaleLowerCase().includes(query));
}

/// 预设切换器没选过时看哪个:宿主标的默认预设,其次第一个。
function fallbackPreset(presets) {
  return presets.find((preset) => preset.isDefault) ?? presets[0];
}

function presetName(preset) {
  return presetDisplayName(preset) || preset?.id || "";
}

function presetLabel(preset) {
  const name = presetName(preset);
  if (preset.broken !== undefined && preset.broken !== null) return t("inv.presetOptionBroken", { name });
  if (preset.isDefault) return t("inv.presetOptionDefault", { name });
  return name;
}

/**
 * 「内置插件」设置 pane。
 *
 * @param {object} options
 * @param {Element} options.host pane 容器。
 * @param {object} options.deps 需要 sessions.onPluginManagerChanged(可缺)。
 * @param {object} options.settingsService 需要 pluginInventory()。
 */
export function createBuiltinPluginsPane({ host, deps, settingsService }) {
  let state = { status: "idle" };
  let query = "";
  let expanded = null;
  let chosenPreset = null;
  // null = 用户没碰过,用默认:会话插件展开、全局插件折起。
  let presetOpen = null;
  let globalOpen = null;
  let visible = false;
  let disposed = false;
  let generation = 0;
  let inflight = null;

  // 宿主的插件启停 / 装载变了:清单是实时视图,可见时重读。
  const unsubscribe = deps?.sessions?.onPluginManagerChanged?.(() => {
    if (visible && !disposed) void load();
  });

  async function load() {
    const mine = ++generation;
    if (state.status !== "ready") { state = { status: "loading" }; render(); }
    try {
      const value = await settingsService.pluginInventory();
      if (mine !== generation || disposed) return;
      state = { status: "ready", snapshot: { entries: value?.entries ?? [], agentPresets: value?.agentPresets ?? [] } };
    } catch {
      if (mine !== generation || disposed) return;
      state = { status: "error" };
    }
    render();
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    if (inflight) return inflight;
    inflight = load().finally(() => { inflight = null; });
    return inflight;
  }

  // ---- 渲染 ----

  function phaseDot(phase) {
    const kind = PHASE_DOT[phase];
    if (!kind) return "";
    const label = escapeHtml(phaseLabel(phase));
    return `<span class="set-status ${kind} inv-phase-dot" role="img" aria-label="${label}" title="${label}"><i></i></span>`;
  }

  function stateTag(kind, label) {
    return kind === "enabled" ? "" : tag(label, TAG_KIND[kind] ?? "");
  }

  function facts(rows) {
    return `<dl class="inv-details">` + rows.map(([label, value]) => (
      `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`
    )).join("") + `</dl>`;
  }

  /// 一张可展开的卡片。状态与详情由调用方给(两组的状态口径不同)。
  function card({ key, row, title, description, kind, dot, detail }) {
    const open = expanded === key;
    const stateText = t(STATE_KEYS[kind]);
    const metaError = row.meta?.error ? t("inv.metadataError", { error: row.meta.error }) : "";
    const label = idAddsToTitle(row.entryId, title) ? `${title}, ${row.entryId}, ${stateText}` : `${title}, ${stateText}`;
    return `<li class="inv-card${open ? " open" : ""}${kind === "failed" ? " failed" : ""}"`
      + (row.entryId ? ` data-plugin-entry="${escapeHtml(row.entryId)}"` : "")
      + ` data-plugin-module="${escapeHtml(row.moduleName)}">`
      + `<button class="inv-card-head" type="button" data-inv-card="${escapeHtml(key)}"`
      + ` aria-expanded="${open}" aria-label="${escapeHtml(label)}">`
      + `<span class="inv-card-row"><strong class="inv-card-title" title="${escapeHtml(row.moduleName)}">${escapeHtml(title)}</strong>`
      + `<span class="inv-card-trailing">${dot}${stateTag(kind, stateText)}`
      + `<span class="inv-chevron" aria-hidden="true">${lucideIconSvg("chevron-down", { size: 12 })}</span></span></span>`
      + (description ? `<span class="inv-card-desc">${escapeHtml(description)}</span>` : "")
      + (idAddsToTitle(row.entryId, title)
        ? `<span class="inv-card-meta"><code class="inv-card-id" title="${escapeHtml(row.entryId)}">${escapeHtml(entrySubtitle(row.entryId))}</code></span>`
        : "")
      + `</button>`
      + (metaError ? `<p class="inv-broken" role="status">${escapeHtml(metaError)}</p>` : "")
      + (open
        ? `<div class="inv-card-details">`
          + (row.entryId ? `<code class="inv-entry">${escapeHtml(row.entryId)}</code>` : "")
          + facts([[t("inv.moduleLabel"), escapeHtml(row.moduleName)], ...detail])
          + `</div>`
        : "")
      + `</li>`;
  }

  function presetRowCard(preset, row, index) {
    const { title, description } = inventoryText(row);
    const kind = row.fiberPhase === "failed" ? "failed"
      : row.enabled === true ? "enabled" : row.enabled === false ? "disabled" : "conditional";
    return card({
      key: `preset:${preset.id}:${index}`,
      row, title, description, kind,
      dot: row.enabled === true ? phaseDot(row.fiberPhase) : "",
      detail: [
        [t("inv.fromPreset"), escapeHtml(presetName(preset))],
        [t("inv.configuration"), escapeHtml(t(STATE_KEYS[kind]))],
        ...(row.fiberPhase ? [[t("inv.runtime"), escapeHtml(phaseLabel(row.fiberPhase))]] : []),
        ...(row.condition !== undefined && row.condition !== null
          ? [[t("inv.condition"), `<code>${escapeHtml(row.condition)}</code>`]]
          : [])
      ]
    });
  }

  function globalRowCard(entry, providers) {
    const { title, description } = inventoryText(entry);
    const kind = entry.fiberPhase === "failed" ? "failed" : providers ? "preset" : entry.enabled ? "enabled" : "disabled";
    const detail = providers
      ? [
        [t("inv.configuration"), escapeHtml(t("inv.presetProvidedDetail"))],
        [t("inv.enabledIn"), `<span class="inv-enabled-in"><span>${escapeHtml(providers.map(presetName).join(" · "))}</span>`
          + `<button class="set-link" type="button" data-inv-preset="${escapeHtml(providers[0].id)}">${escapeHtml(t("inv.viewInPreset"))}</button></span>`]
      ]
      : [
        [t("inv.configuration"), escapeHtml(t(entry.enabled ? "inv.enabledTag" : "inv.disabledTag"))],
        ...(entry.enabled ? [[t("inv.runtime"), escapeHtml(phaseLabel(entry.fiberPhase))]] : [])
      ];
    return card({
      key: `global:${entry.entryId}`,
      row: entry, title, description, kind,
      dot: entry.enabled ? phaseDot(entry.fiberPhase) : "",
      detail
    });
  }

  function groupHead({ id, title, open, end = "" }) {
    return `<div class="inv-group-head">`
      + `<button class="inv-group-toggle" type="button" id="${id}" aria-expanded="${open}">`
      + `<span class="inv-chevron" aria-hidden="true">${lucideIconSvg("chevron-down", { size: 12 })}</span>`
      + `<span class="inv-group-title">${escapeHtml(title)}</span></button>`
      + (end ? `<span class="inv-group-end">${end}</span>` : "")
      + `</div>`;
  }

  function countText(count) {
    return `${count} ${t("inv.countUnit")}`;
  }

  function renderCatalog(snap) {
    const normalized = query.trim().toLocaleLowerCase();
    const searching = normalized.length > 0;
    const presets = snap.agentPresets;
    const selected = presets.find((preset) => preset.id === chosenPreset) ?? fallbackPreset(presets);

    // 真正启用某模块的预设,按模块名(全局里停用的行据此标「预设中启用」)。
    const enabledIn = new Map();
    for (const preset of presets) {
      for (const row of preset.rows ?? []) {
        if (row.enabled !== true) continue;
        const groups = enabledIn.get(row.moduleName) ?? [];
        if (!groups.includes(preset)) groups.push(preset);
        enabledIn.set(row.moduleName, groups);
      }
    }

    const entries = snap.entries;
    const failedEntries = entries.filter((entry) => entry.fiberPhase === "failed" && matches(entry, normalized));
    const regularEntries = entries.filter((entry) => entry.fiberPhase !== "failed" && matches(entry, normalized));
    const globalCount = failedEntries.length + regularEntries.length;
    const selectedRows = selected
      ? (selected.rows ?? []).map((row, index) => [row, index]).filter(([row]) => matches(row, normalized))
      : [];
    const otherPresets = searching
      ? presets.filter((preset) => preset !== selected && (preset.rows ?? []).some((row) => matches(row, normalized)))
      : [];
    const otherCount = otherPresets
      .reduce((total, preset) => total + (preset.rows ?? []).filter((row) => matches(row, normalized)).length, 0);

    // 会话插件默认展开、全局插件默认折起;搜索期间两组都展开。
    const presetEffectiveOpen = searching || (presetOpen ?? true);
    const globalEffectiveOpen = searching || (globalOpen ?? false);
    const nothingMatches = searching && globalCount === 0 && selectedRows.length === 0 && otherPresets.length === 0;

    let html = searchField({
      id: "inv-search", value: query, placeholder: t("inv.search"),
      clearId: "inv-search-clear", clearLabel: t("inv.searchClear")
    });
    if (!entries.length && !presets.length) html += `<p class="inv-status">${escapeHtml(t("inv.empty"))}</p>`;
    if (nothingMatches) html += `<p class="inv-status">${escapeHtml(t("inv.emptySearch"))}</p>`;

    if (selected) {
      const switcher = `<select class="set-select inv-switcher" id="inv-preset-switcher" aria-label="${escapeHtml(t("inv.switcherLabel"))}">`
        + presets.map((preset) => `<option value="${escapeHtml(preset.id)}"${preset === selected ? " selected" : ""}>${escapeHtml(presetLabel(preset))}</option>`).join("")
        + `</select>`;
      html += `<section class="inv-group" data-plugin-scope="preset" data-preset-id="${escapeHtml(selected.id)}">`
        + groupHead({ id: "inv-toggle-preset", title: t("inv.presetTitle"), open: presetEffectiveOpen, end: switcher })
        + `<p class="inv-group-sub"><span>${escapeHtml(t("inv.presetSubtitle"))}</span>`
        + `<span data-preset-plugin-count="${selectedRows.length}">${escapeHtml(countText(selectedRows.length))}</span></p>`
        + (presetEffectiveOpen
          ? `<div class="inv-group-body">`
            + (selected.broken ? `<p class="inv-broken" role="alert">${escapeHtml(selected.broken)}</p>` : "")
            + (selectedRows.length
              ? `<ul class="inv-cards">${selectedRows.map(([row, index]) => presetRowCard(selected, row, index)).join("")}</ul>`
              : "")
            + (otherCount > 0
              ? `<p class="inv-hint">${escapeHtml(t("inv.matchesInOtherPresets", { count: String(otherCount) }))}`
                + otherPresets.map((preset) => `<button class="set-link" type="button" data-inv-preset="${escapeHtml(preset.id)}">${escapeHtml(presetName(preset))}</button>`).join("")
                + `</p>`
              : "")
            + `</div>`
          : "")
        + `</section>`;
    }

    if (entries.length) {
      html += `<section class="inv-group" data-plugin-scope="global">`
        + groupHead({ id: "inv-toggle-global", title: t("inv.globalTitle"), open: globalEffectiveOpen })
        + `<p class="inv-group-sub"><span>${escapeHtml(t("inv.globalSubtitle"))}</span>`
        + `<span data-plugin-count="${globalCount}">${escapeHtml(countText(globalCount))}</span>`
        + (failedEntries.length
          ? `<span class="inv-failed-count">${failedEntries.length} ${escapeHtml(t("inv.failedCountLabel"))}</span>`
          : "")
        + `</p>`
        + (globalEffectiveOpen && globalCount > 0
          ? `<ul class="inv-cards">`
            + failedEntries.map((entry) => globalRowCard(entry)).join("")
            + regularEntries.map((entry) => globalRowCard(entry, entry.enabled ? undefined : enabledIn.get(entry.moduleName))).join("")
            + `</ul>`
          : "")
        + `</section>`;
    }
    return html;
  }

  function render() {
    if (disposed || !visible) return;
    // 整块重画会重建搜索框:记下焦点与光标,画完还回去(打字时不丢焦点)。
    const focused = host.ownerDocument.activeElement;
    const focusId = focused && host.contains(focused) && focused.id ? focused.id : null;
    const caret = focusId && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
    let body = `<p class="inv-intro">${escapeHtml(t("inv.intro"))}</p>`;
    if (state.status === "loading" || state.status === "idle") {
      body += `<div class="inv-cards" role="status" aria-label="${escapeHtml(t("inv.loading"))}">`
        + [0, 1, 2, 3].map(() => `<div class="inv-skeleton" aria-hidden="true"><span></span><span></span></div>`).join("")
        + `</div>`;
    } else if (state.status === "error") {
      body += notice(t("inv.error")) + `<div class="inv-retry">${button({ id: "inv-retry", label: t("inv.retry") })}</div>`;
    } else {
      body += renderCatalog(state.snapshot);
    }
    host.innerHTML = `<div class="inv" aria-busy="${state.status === "loading"}">${body}</div>`;
    bind();
    if (focusId) {
      const next = host.querySelector(`#${selectorEscape(focusId)}`);
      if (next) {
        next.focus({ preventScroll: true });
        if (caret) { try { next.setSelectionRange(...caret); } catch { /* 非文本控件 */ } }
      }
    }
  }

  function bind() {
    host.querySelector("#inv-retry")?.addEventListener("click", () => { state = { status: "loading" }; void refresh(); });
    host.querySelector("#inv-search")?.addEventListener("input", (event) => { query = event.target.value; render(); });
    host.querySelector("#inv-search-clear")?.addEventListener("click", () => {
      query = "";
      render();
      host.querySelector("#inv-search")?.focus();
    });
    host.querySelector("#inv-preset-switcher")?.addEventListener("change", (event) => { chosenPreset = event.target.value; render(); });
    const searching = query.trim().length > 0;
    host.querySelector("#inv-toggle-preset")?.addEventListener("click", () => { presetOpen = !(searching || (presetOpen ?? true)); render(); });
    host.querySelector("#inv-toggle-global")?.addEventListener("click", () => { globalOpen = !(searching || (globalOpen ?? false)); render(); });
    for (const element of host.querySelectorAll("[data-inv-card]")) {
      element.addEventListener("click", () => {
        const key = element.dataset.invCard;
        expanded = expanded === key ? null : key;
        render();
      });
    }
    for (const element of host.querySelectorAll("[data-inv-preset]")) {
      element.addEventListener("click", () => {
        chosenPreset = element.dataset.invPreset;
        presetOpen = true;
        render();
        host.querySelector('[data-plugin-scope="preset"]')?.scrollIntoView?.({ block: "nearest" });
      });
    }
  }

  return {
    refresh,
    relabel: render,
    setVisible(value, { refresh: shouldRefresh = true } = {}) {
      visible = Boolean(value);
      if (!visible || disposed) return;
      render();
      if (shouldRefresh) void refresh();
    },
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribe?.();
    }
  };
}
