// 模型 pane。照搬 macos/.../Settings/SettingsRoot.swift ModelsSection:
// 已配置提供方列表(每行开一个编辑器)+ 添加提供方标签云 + 目录问题区。
// 两个弹窗各自成模块:provider-editor-sheet(编辑已配置的)与
// custom-provider-sheet(声明新的)。
import { t } from "../../../shared/i18n.js";
import {
  section, row, textInput, button, iconButton,
  tag, statusLine, notice, spinner, escapeHtml
} from "./settings-ui.js";
import { providerKeyState, addableProviders, deriveKeyRef } from "../../../features/settings/settings-service.js";
import { openProviderEditor } from "./provider-editor-sheet.js";
import { openCustomProvider, protocolChoices } from "./custom-provider-sheet.js";

const KEY_STATE_TEXT = {
  configured: "prov.keyConfigured",
  notRequired: "prov.keyNotRequired",
  missing: "prov.keyMissing"
};
const KEY_STATE_KIND = { configured: "ok", notRequired: "muted", missing: "warn" };

export function createModelsPane({ host, sheet, deps, settingsService, showToast, onModelsChanged }) {
  let state = null;
  let loadError = null;
  let loading = true;
  let addSearch = "";
  let savedProviderName = null;
  let loadGeneration = 0;

  function rowFor(provider) {
    return state?.rows.find((entry) => entry.entry.provider === provider) ?? null;
  }

  function configuredRows() {
    return state?.rows.filter((entry) => entry.configured) ?? [];
  }

  function renderProviderRow(entry) {
    const keyState = providerKeyState(entry);
    const label = escapeHtml(entry.entry.displayName || entry.entry.provider)
      + (entry.entry.declared === true ? tag(t("prov.customTag")) : "");
    const trailing = (entry.removable
      ? iconButton({ id: `prov-del-${entry.entry.provider}`, glyph: "🗑", title: t("prov.remove"), kind: "danger" })
      : "")
      + iconButton({ id: `prov-edit-${entry.entry.provider}`, glyph: "›", title: entry.entry.displayName });
    return row({
      label,
      hint: statusLine(t(KEY_STATE_TEXT[keyState]), KEY_STATE_KIND[keyState]),
      control: trailing,
      id: `prov-row-${entry.entry.provider}`
    });
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
    return section({ header: t("set.tab.models"), body, footer });
  }

  /// 添加提供方:扁平标签云 + 搜索框。自定义提供方标签永远排第一且不参与过滤。
  /// 搜索语义全部由 placeholder 承担 —— 不再另挂一个标题行或图标,那既占宽度
  /// 又和 placeholder 重复。
  function renderAddSection() {
    const needle = addSearch.trim().toLowerCase();
    const candidates = addableProviders(state?.rows ?? []).filter((entry) => (
      !needle
      || (entry.displayName ?? "").toLowerCase().includes(needle)
      || entry.provider.toLowerCase().includes(needle)
    ));
    const canDeclare = state?.writable && state.namespaces.has("llm-pi-ai")
      && protocolChoices(state.namespaces.get("llm-pi-ai")?.schema).length > 0;
    const tags = `<button class="set-chip" type="button" id="prov-add-custom"${canDeclare ? "" : " disabled"}>`
      + `＋ ${escapeHtml(t("prov.addCustom"))}</button>`
      + candidates.map((entry) => (
        `<button class="set-chip" type="button" data-add-provider="${escapeHtml(entry.provider)}"`
        + `${state?.writable ? "" : " disabled"}>${escapeHtml(entry.displayName || entry.provider)}</button>`
      )).join("")
      + (!candidates.length && needle ? `<span class="set-row-hint">${escapeHtml(t("prov.addNoMatches"))}</span>` : "");
    return section({
      body: `<div class="set-row stacked"><div class="set-row-control wide">`
        + textInput({ id: "prov-add-search", type: "search", value: addSearch, placeholder: t("prov.searchPlaceholder") })
        + `</div></div><div class="set-chips">${tags}</div>`,
      footer: escapeHtml(t("prov.addFooter"))
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

  function bind() {
    const search = host.querySelector("#prov-add-search");
    search?.addEventListener("input", (event) => {
      addSearch = event.target.value;
      // 只重画标签云,避免每敲一个字就让搜索框失焦。
      const cloud = host.querySelector(".set-chips");
      if (!cloud) return;
      const container = document.createElement("div");
      container.innerHTML = renderAddSection();
      const fresh = container.querySelector(".set-chips");
      if (fresh) { cloud.replaceWith(fresh); bindChips(); }
    });
    bindChips();
    for (const entry of configuredRows()) {
      host.querySelector(`#prov-edit-${CSS.escape(entry.entry.provider)}`)
        ?.addEventListener("click", () => editProvider(entry.entry));
      host.querySelector(`#prov-del-${CSS.escape(entry.entry.provider)}`)
        ?.addEventListener("click", () => confirmRemove(entry));
    }
  }

  function bindChips() {
    host.querySelector("#prov-add-custom")?.addEventListener("click", () => addCustomProvider());
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
    if (error?.code === "settings-conflict") return t("prov.settingsConflict");
    return deps.formatErrorDetails(error);
  }

  function editProvider(entry) {
    openProviderEditor({
      entry, state, sheet, deps, settingsService, rowFor, translateSaveError,
      onSaved: async (name) => {
        savedProviderName = name;
        await refresh();
        onModelsChanged?.();
      }
    });
  }

  function addCustomProvider() {
    openCustomProvider({
      state, sheet, deps, settingsService, translateSaveError,
      onDone: async () => {
        await refresh();
        onModelsChanged?.();
      }
    });
  }

  // ── 删除确认 ──
  function confirmRemove(entry) {
    const name = entry.entry.displayName || entry.entry.provider;
    const derived = deriveKeyRef(entry.entry.provider);
    const managesCredential = entry.apiKeyEnv === derived
      && entry.credential?.configured === true && entry.credential?.writable === true;
    sheet.open({
      title: t("prov.remove"),
      body: `<p class="set-sheet-text">${escapeHtml(managesCredential
        ? t("prov.deleteWithCredential", { name })
        : t("prov.deleteKeepingCredential", { name }))}</p>`
      + `<div class="set-sheet-error" id="prov-del-error"></div>`,
      actions: button({ id: "prov-del-cancel", label: t("set.cancel") })
        + button({ id: "prov-del-confirm", label: t("prov.deleteNamed", { name }), kind: "danger" }),
      bind(root) {
        root.querySelector("#prov-del-cancel").addEventListener("click", () => sheet.close());
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
            sheet.close();
            await refresh();
            onModelsChanged?.();
          } catch (error) {
            root.querySelector("#prov-del-error").textContent = deps.formatErrorDetails(error);
            confirm.disabled = false;
            confirm.textContent = t("prov.deleteNamed", { name });
          }
        });
      }
    });
  }

  async function refresh() {
    const generation = ++loadGeneration;
    loading = true; loadError = null; render();
    try {
      const [providerState, catalog] = await Promise.all([
        settingsService.loadProviderRows(),
        deps.models.refresh().then(() => null).catch(() => null)
      ]);
      if (generation !== loadGeneration) return;
      state = { ...providerState, failures: providerState.failures ?? [] };
      void catalog;
      loadError = null;
    } catch (error) {
      if (generation !== loadGeneration) return;
      loadError = deps.formatErrorDetails(error);
    } finally {
      if (generation !== loadGeneration) return;
      loading = false;
      render();
    }
  }

  return { refresh };
}
