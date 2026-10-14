// 模型 pane。照搬 macos/.../Settings/SettingsRoot.swift ModelsSection:
// 已配置提供方列表(每行开一个编辑器)+ 添加提供方标签云 + 目录问题区。
// 两个弹窗各自成模块:provider-editor-sheet(编辑已配置的)与
// custom-provider-sheet(声明新的)。
import { t } from "../../../shared/i18n.js";
import {
  section, row, button, iconButton, searchField, avatar, chevron, groupHeader, bindClickableRows,
  tag, iconStatusLine, notice, spinner, escapeHtml, selectorEscape, providerDisplayName
} from "./settings-ui.js";
import { providerKeyState, addableProviders, deriveKeyRef } from "../../../features/settings/settings-service.js";
import { openProviderEditor } from "./provider-editor-sheet.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import { openCustomProvider, protocolChoices } from "./custom-provider-sheet.js";

const KEY_STATE_TEXT = {
  configured: "prov.keyConfigured",
  notRequired: "prov.keyNotRequired",
  missing: "prov.keyMissing"
};
const KEY_STATE_KIND = { configured: "ok", notRequired: "muted", missing: "warn" };
// Mac 的提供方副标题是 Label(text, systemImage:)—— 状态用彩色符号表达,
// 比一个 6px 的圆点更容易在缩进的行里扫到。
const KEY_STATE_ICON = { configured: "check", notRequired: "minus", missing: "triangle-alert" };

// 添加提供方的标签云:常用提供方排最前,未搜索时只露出前 COLLAPSED_LIMIT 个 ——
// 四十多个裸路由 id 一次铺满,真正想找的那个反而淹没在里面。
const FEATURED_PROVIDERS = [
  "openai", "anthropic", "google", "openrouter", "deepseek", "moonshotai", "xai",
  "mistral", "groq", "zai", "minimax", "azure", "amazon-bedrock", "github-copilot"
];
const COLLAPSED_LIMIT = 12;

function featuredOrder(entries) {
  const rank = (entry) => {
    const index = FEATURED_PROVIDERS.indexOf(entry.provider);
    return index < 0 ? FEATURED_PROVIDERS.length : index;
  };
  return [...entries].sort((a, b) => rank(a) - rank(b));
}

export function createModelsPane({ host, sheet, deps, settingsService, showToast, onModelsChanged }) {
  let state = null;
  let loadError = null;
  let loading = true;
  let addSearch = "";
  let showAllProviders = false;
  let savedProviderName = null;
  let loadGeneration = 0;
  let providerEditor = null;

  function rowFor(provider) {
    return state?.rows.find((entry) => entry.entry.provider === provider) ?? null;
  }

  function configuredRows() {
    return state?.rows.filter((entry) => entry.configured) ?? [];
  }

  function renderProviderRow(entry) {
    const keyState = providerKeyState(entry);
    const name = providerDisplayName(entry.entry);
    const label = escapeHtml(name)
      + (entry.entry.declared === true ? tag(t("prov.customTag")) : "");
    // Mac 的整行本体就是那个按钮,雪佛龙只是装饰符号;删除是行内唯一的独立控件,
    // 所以点击处理器挂在行上,删除按钮自己 stopPropagation。
    const trailing = (entry.removable
      ? iconButton({ id: `prov-del-${entry.entry.provider}`, icon: "trash-2", title: t("prov.remove"), kind: "danger reveal" })
      : "")
      + chevron();
    return row({
      leading: avatar(name),
      label,
      // 账号路由没有"密钥"概念,不渲染状态行(对齐 web 无凭据圆点)。
      hint: keyState
        ? iconStatusLine(t(KEY_STATE_TEXT[keyState]), KEY_STATE_KIND[keyState], KEY_STATE_ICON[keyState])
        : "",
      control: trailing,
      id: `prov-row-${entry.entry.provider}`
    }).replace('<div class="set-row"', `<div class="set-row clickable" role="button" tabindex="0" aria-label="${escapeHtml(name)}"`);
  }

  function renderProviderSection() {
    const rows = configuredRows();
    const body = rows.length
      ? rows.map(renderProviderRow).join("")
      : `<div class="set-empty">${escapeHtml(t("prov.empty"))}</div>`;
    const footer = [
      escapeHtml(t("prov.footer")),
      state?.writable === false ? escapeHtml(t("set.readOnlyDocument")) : "",
      savedProviderName ? `<span class="set-ok">${escapeHtml(t("prov.saved", { name: savedProviderName }))}</span>` : "",
      state?.credentialError ? `<span class="set-warn">${escapeHtml(state.credentialError)}</span>` : ""
    ].filter(Boolean).join("<br />");
    return section({ headerHtml: groupHeader(t("prov.configuredTitle"), rows.length), body, footer });
  }

  /// 添加提供方:搜索框 + 「自定义提供方」入口 + 标签云。
  /// 自定义提供方是一整行入口(而不是混在标签云里的第一个标签),它和其余
  /// 标签不是同一类动作:前者要填地址与协议,后者只差一把密钥。
  function addCandidates() {
    const needle = addSearch.trim().toLowerCase();
    const all = addableProviders(state?.rows ?? []);
    const matches = featuredOrder(all.filter((entry) => (
      !needle
      || (entry.displayName ?? "").toLowerCase().includes(needle)
      || entry.provider.toLowerCase().includes(needle)
    )));
    return { all, matches, needle };
  }

  function renderChips() {
    const { matches, needle } = addCandidates();
    const collapsed = !needle && !showAllProviders && matches.length > COLLAPSED_LIMIT;
    const visible = collapsed ? matches.slice(0, COLLAPSED_LIMIT) : matches;
    const chips = visible.map((entry) => (
      `<button class="set-chip" type="button" data-add-provider="${escapeHtml(entry.provider)}"`
      + `${state?.writable ? "" : " disabled"} title="${escapeHtml(entry.provider)}">`
      + `${lucideIconSvg("plus", { size: 12 })}${escapeHtml(entry.displayName || entry.provider)}</button>`
    )).join("");
    const toggleMore = !needle && matches.length > COLLAPSED_LIMIT
      ? `<button class="set-chip ghost" type="button" id="prov-show-all" aria-expanded="${!collapsed}">`
        + escapeHtml(collapsed ? t("prov.showAll", { count: matches.length }) : t("prov.showLess"))
        + `</button>`
      : "";
    const empty = !matches.length && needle
      ? `<span class="set-row-hint">${escapeHtml(t("prov.addNoMatches"))}</span>`
      : "";
    return `<div class="set-chips">${chips}${toggleMore}${empty}</div>`;
  }

  function renderAddSection() {
    const { all } = addCandidates();
    const canDeclare = state?.writable && state.namespaces.has("llm-pi-ai")
      && protocolChoices(state.namespaces.get("llm-pi-ai")?.schema).length > 0;
    const custom = `<button class="set-add-row" type="button" id="prov-add-custom"${canDeclare ? "" : " disabled"}>`
      + `<span class="set-add-row-icon" aria-hidden="true">${lucideIconSvg("plus", { size: 14 })}</span>`
      + `<span class="set-row-text"><span class="set-row-label">${escapeHtml(t("prov.addCustom"))}</span>`
      + `<span class="set-row-hint">${escapeHtml(t("prov.addFooter"))}</span></span>`
      + chevron() + `</button>`;
    return section({
      headerHtml: groupHeader(t("prov.addTitle"), all.length),
      body: `<div class="set-row stacked"><div class="set-row-control wide">`
        + searchField({
          id: "prov-add-search", value: addSearch, placeholder: t("prov.searchPlaceholder"),
          clearId: "prov-search-clear", clearLabel: t("prov.searchClear")
        })
        + `</div></div>`
        + renderChips()
        + custom
    });
  }

  function renderFailureSection() {
    const failures = state?.failures ?? [];
    if (!failures.length) return "";
    return section({
      header: t("prov.catalogProblems"),
      body: failures.map((failure) => row({
        label: escapeHtml(failure.name ?? failure.id ?? ""),
        hint: escapeHtml(failure.message ?? "")
      })).join("")
    });
  }

  function render() {
    if (loading) { host.innerHTML = spinner(); return; }
    if (loadError) {
      host.innerHTML = section({
        body: notice(t("prov.catalogLoadFailed", { message: loadError }))
          + `<div class="set-form-footer"><span class="set-spacer"></span>`
          + button({ id: "prov-retry", label: t("set.retry"), kind: "primary" })
          + `</div>`
      });
      host.querySelector("#prov-retry")?.addEventListener("click", () => refresh());
      return;
    }
    host.innerHTML = renderProviderSection() + renderAddSection() + renderFailureSection();
    bind();
  }

  /// 清除按钮:清空搜索并整页重画(输入框会被重建,但这是用户主动点的,
  /// 不存在"正在打字时失焦"的问题)。
  function bindClear() {
    host.querySelector("#prov-search-clear")?.addEventListener("click", () => {
      addSearch = "";
      render();
      host.querySelector("#prov-add-search")?.focus();
    });
  }

  function bind() {
    bindClear();
    const search = host.querySelector("#prov-add-search");
    search?.addEventListener("input", (event) => {
      addSearch = event.target.value;
      // 只重画标签云与清除按钮,避免每敲一个字就让搜索框失焦;
      // 输入框本身原地保留,所以光标与 IME 组合状态都不会丢。
      repaintChips();
      const searchWrap = search.closest(".set-search");
      const container = host.ownerDocument.createElement("div");
      container.innerHTML = renderAddSection();
      const freshClear = container.querySelector(".set-search-clear");
      const existingClear = host.querySelector("#prov-search-clear");
      if (freshClear && !existingClear) { searchWrap?.append(freshClear); bindClear(); }
      else if (!freshClear && existingClear) existingClear.remove();
    });
    // Esc 先清空搜索,再交给外层(关设置页等)。
    search?.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !addSearch) return;
      event.preventDefault(); event.stopPropagation();
      addSearch = ""; search.value = ""; repaintChips();
      host.querySelector("#prov-search-clear")?.remove();
    });
    host.querySelector("#prov-add-custom")?.addEventListener("click", () => addCustomProvider());
    bindChips();
    bindClickableRows(host);
    for (const entry of configuredRows()) {
      host.querySelector(`#prov-row-${selectorEscape(entry.entry.provider)}`)
        ?.addEventListener("click", () => editProvider(entry.entry));
      host.querySelector(`#prov-del-${selectorEscape(entry.entry.provider)}`)
        ?.addEventListener("click", (event) => {
          // 行本体也是按钮:删除不能被行点击吞掉。
          event.stopPropagation();
          confirmRemove(entry);
        });
    }
  }

  function repaintChips() {
    const cloud = host.querySelector(".set-chips");
    if (!cloud) return;
    const container = host.ownerDocument.createElement("div");
    container.innerHTML = renderChips();
    const fresh = container.querySelector(".set-chips");
    if (fresh) { cloud.replaceWith(fresh); bindChips(); }
  }

  function bindChips() {
    host.querySelector("#prov-show-all")?.addEventListener("click", (event) => {
      showAllProviders = !showAllProviders;
      repaintChips();
      if (event.detail === 0) host.querySelector("#prov-show-all")?.focus();
    });
    for (const chip of host.querySelectorAll("[data-add-provider]")) {
      chip.addEventListener("click", () => {
        const entry = state?.rows.find((candidate) => candidate.entry.provider === chip.dataset.addProvider)?.entry;
        if (entry) editProvider(entry);
      });
    }
  }

  function translateSaveError(error) {
    const raw = error?.message ?? "";
    if (raw === "keyBlank") return t("prov.keyBlank");
    if (raw === "keyFormat") return t("prov.keyFormatInvalid");
    if (raw === "keyLocked") return t("prov.credentialLocked");
    if (error?.code === "settings/conflict") return t("prov.settingsConflict");
    return deps.formatErrorDetails(error);
  }

  function editProvider(entry) {
    providerEditor = openProviderEditor({
      entry, state, sheet, deps, settingsService, rowFor, translateSaveError,
      onSaved: async (name) => {
        savedProviderName = name;
        await refresh();
        onModelsChanged?.();
      }
    });
  }

  function addCustomProvider() {
    providerEditor = openCustomProvider({
      state, getState: () => state, sheet, deps, settingsService, translateSaveError,
      onDone: async () => {
        await refresh();
        onModelsChanged?.();
      }
    });
  }

  // ── 删除确认 ──
  function confirmRemove(entry) {
    const name = providerDisplayName(entry.entry);
    const derived = deriveKeyRef(entry.entry.provider);
    const managesCredential = entry.apiKeyEnv === derived
      && entry.credential?.configured === true && entry.credential?.writable === true;
    const token = sheet.open({
      title: t("prov.remove"),
      body: `<p class="set-sheet-text">${escapeHtml(managesCredential
        ? t("prov.deleteWithCredential", { name })
        : t("prov.deleteKeepingCredential", { name }))}</p>`
      + `<div class="set-sheet-error" id="prov-del-error"></div>`,
      actions: button({ id: "prov-del-cancel", label: t("set.cancel") })
        + button({ id: "prov-del-confirm", label: t("prov.deleteNamed", { name }), kind: "danger" }),
      bind(root) {
        root.querySelector("#prov-del-cancel").addEventListener("click", () => sheet.close(token));
        const confirm = root.querySelector("#prov-del-confirm");
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          confirm.textContent = t("prov.deleting", { name });
          try {
            const fresh = rowFor(entry.entry.provider);
            await settingsService.removeProvider({
              ...(fresh ?? entry),
              expectedRevision: state?.namespaces.get(entry.entry.settingsNs)?.revision
            });
            // 只关自己:期间用户可能已关掉确认框并开了别的 sheet。
            sheet.close(token);
            await refresh();
            onModelsChanged?.();
          } catch (error) {
            if (!sheet.owns(token)) return;
            root.querySelector("#prov-del-error").textContent = deps.formatErrorDetails(error);
            confirm.disabled = false;
            confirm.textContent = t("prov.deleteNamed", { name });
          }
        });
      }
    });
  }

  async function refresh({ background = false } = {}) {
    const generation = ++loadGeneration;
    const focused = host.ownerDocument.activeElement;
    const restoreSearch = focused?.id === "prov-add-search";
    const selection = restoreSearch ? [focused.selectionStart, focused.selectionEnd] : null;
    loading = !background || !state; loadError = null;
    if (loading) render();
    try {
      const [providerState, catalog] = await Promise.all([
        settingsService.loadProviderRows(),
        deps.models.refresh().then(() => null).catch(() => null)
      ]);
      if (generation !== loadGeneration) return;
      state = { ...providerState, failures: providerState.failures ?? [] };
      if (providerEditor?.active) providerEditor.refreshFacts?.();
      void catalog;
      loadError = null;
    } catch (error) {
      if (generation !== loadGeneration) return;
      loadError = deps.formatErrorDetails(error);
    } finally {
      if (generation !== loadGeneration) return;
      loading = false;
      const mayRestoreSearch = restoreSearch && (host.ownerDocument.activeElement === focused || host.ownerDocument.activeElement === host.ownerDocument.body);
      render();
      if (mayRestoreSearch) {
        const input = host.querySelector("#prov-add-search");
        input?.focus();
        input?.setSelectionRange?.(...selection);
      }
    }
  }

  return { refresh };
}
