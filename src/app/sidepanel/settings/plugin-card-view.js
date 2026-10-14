// 插件配置卡片的渲染与保存。
//
// 两张普通卡(Shell / Agent 循环 / 联网搜索)共用一套字段渲染:字段的暂存、
// 校验、覆盖标记、放弃/保存全部来自 plugin-settings-state;联网搜索多一行凭证,
// 它不进设置文件而是走凭证库,所以状态在视图里单独持有。
//
// Subagent 卡多一段模型选择:字段部分同上,模型选择是一份独立草稿(enabled +
// allowedModels),两段共用同一个页脚 —— 任一脏就整体可保存(Mac 的 dirty/valid)。
import { t } from "../../../shared/i18n.js";
import {
  stackedRow, row, textInput, secretInput, bindSecretToggles, toggle, tag, notice, escapeHtml, formFooter, selectorEscape
} from "./settings-ui.js";
import { createPluginSettingsState } from "../../../features/settings/plugin-settings-state.js";
import { credentialRef } from "./plugin-config-cards.js";
import {
  subagentModelCandidates, groupSubagentCandidates, routeKey,
  routesForSelection, subagentModelSelectionValid
} from "../../../features/settings/subagent-models.js";

/// 卡片渲染所需的共享上下文由 plugins-pane 传入:它持有 describe 快照、宿主
/// 地址、共享 sheet,以及"重新 describe"的能力。
export function createPluginCardViews({
  host, deps, settingsService, showToast, describeNow, credentialCache, requestRender
}) {
  // 每张卡一份字段暂存态,按命名空间存;切 tab 不该丢掉正在编辑的草稿(Mac D.D29)。
  const forms = new Map();
  // Subagent 模型选择草稿,同样按命名空间存。
  const modelDrafts = new Map();
  const saving = new Set();
  const failed = new Set();

  function namespaceOf(ns) {
    return (describeNow()?.namespaces ?? []).find((entry) => entry.ns === ns) ?? null;
  }

  function formFor(card) {
    let form = forms.get(card.namespace);
    if (form) return form;
    const namespace = namespaceOf(card.namespace);
    if (!namespace) return null;
    form = createPluginSettingsState({
      namespace,
      writable: describeNow()?.writable === true,
      fields: Object.fromEntries(card.fields.map((field) => [field.id, field.kind]))
    });
    forms.set(card.namespace, form);
    return form;
  }

  function modelDraftFor(card) {
    if (!card.modelSelection) return null;
    let draft = modelDrafts.get(card.modelSelection.namespace);
    if (draft) return draft;
    const namespace = namespaceOf(card.modelSelection.namespace);
    if (!namespace) return null;
    draft = {
      namespace,
      writable: describeNow()?.writable === true,
      enabled: namespace.value?.enabled === true,
      enabledDraft: namespace.value?.enabled === true,
      routes: Array.isArray(namespace.value?.allowedModels) ? namespace.value.allowedModels : [],
      routesDraft: Array.isArray(namespace.value?.allowedModels) ? [...namespace.value.allowedModels] : [],
      selected: new Set(),
      conflicted: false
    };
    draft.selected = new Set(draft.routesDraft.map((route) => routeKey(route?.provider, route?.model)));
    modelDrafts.set(card.modelSelection.namespace, draft);
    return draft;
  }

  /// 丢弃干净草稿,让卡片显示宿主最新值;有未保存编辑的保留。
  function dropCleanDrafts() {
    for (const [ns, staged] of forms) {
      if (!staged.dirty) forms.delete(ns);
    }
    for (const [ns, draft] of modelDrafts) {
      if (draftDirty(draft) === false) modelDrafts.delete(ns);
    }
  }

  function draftDirty(draft) {
    if (!draft) return false;
    if (draft.enabledDraft !== draft.enabled) return true;
    return JSON.stringify(draft.routesDraft) !== JSON.stringify(draft.routes);
  }

  function isDirty(card) {
    return formFor(card)?.dirty === true || draftDirty(modelDraftFor(card));
  }

  function isValid(card) {
    const form = formFor(card);
    const draft = modelDraftFor(card);
    const fieldsValid = form?.invalid !== true;
    const modelsValid = !draft || subagentModelSelectionValid(draft.enabledDraft, draft.selected);
    return fieldsValid && modelsValid;
  }

  /// 凭证行:只显示"已存/未存"与一个可输入的新值,不显示既有密钥 ——
  /// 宿主的 credentials/describe 只回 configured/writable,不回明文。
  function renderCredentialRow(card, form) {
    const spec = card.credential;
    const ref = credentialRef(card, namespaceOf(card.namespace)?.value);
    const current = credentialCache.get(ref) ?? null;
    const locked = current?.configured === true && current?.writable === false;
    const draftKey = `cred:${card.namespace}`;
    const draft = credentialCache.drafts.get(draftKey) ?? "";
    const status = current?.configured
      ? tag(t("plug.apiKeySet"), "accent")
      : tag(t("plug.apiKeyUnset"), "");
    return stackedRow({
      label: escapeHtml(t(spec.label)) + status + `<span class="set-mono">${escapeHtml(ref)}</span>`,
      hint: locked ? t("plug.apiKeyLocked") : t(spec.hint),
      control: secretInput({
        id: `plug-cred-${card.namespace}`,
        value: draft,
        placeholder: current?.configured ? "••••••••" : "",
        disabled: form?.writable !== true || locked
      }) + `<button class="set-link" type="button" id="plug-cred-save-${card.namespace}"`
        + `${form?.writable === true && !locked && draft ? "" : " disabled"}>`
        + `${escapeHtml(t("plug.apiKeySave"))}</button>`
        + (current?.configured && !locked
          ? `<button class="set-link" type="button" id="plug-cred-clear-${card.namespace}">`
            + `${escapeHtml(t("plug.apiKeyClear"))}</button>`
          : "")
    });
  }

  function renderField(card, field) {
    const form = formFor(card);
    const state = form?.field(field.id) ?? { text: "", overridden: false, invalid: false };
    const hint = state.invalid
      ? `<span class="set-danger">${escapeHtml(t(field.invalidKey ?? "plug.invalidNumber"))}</span>`
      : t(field.hint);
    const label = escapeHtml(t(field.label)) + (state.overridden ? tag(t("plug.overridden")) : "");
    return stackedRow({
      label,
      hint,
      control: textInput({
        id: `plug-${card.namespace}-${field.id}`,
        value: state.text,
        disabled: form?.writable !== true,
        mono: field.kind === "number"
      })
      + (state.overridden
        ? `<button class="set-link" type="button" id="plug-reset-${card.namespace}-${field.id}"`
          + `${form?.writable ? "" : " disabled"}>${escapeHtml(t("plug.reset"))}</button>`
        : "")
    });
  }

  /// Subagent 的模型选择段:开关 + 候选清单(按提供方分组,不可用的排最后)。
  function renderModelSelection(card) {
    const draft = modelDraftFor(card);
    if (!draft) return "";
    const rows = subagentModelCandidates(deps.models?.catalogGroups ?? [], draft.routesDraft);
    const groups = groupSubagentCandidates(rows, t("plug.subagentUnavailableGroup"));
    const toggleRow = row({
      label: escapeHtml(t("plug.subagentModelToggle")),
      hint: escapeHtml(draft.enabledDraft
        ? t("plug.subagentModelChoose")
        : t("plug.subagentModelOff")),
      control: toggle({
        id: "plug-subagent-model-enabled",
        checked: draft.enabledDraft,
        disabled: !draft.writable || saving.size > 0
      })
    });
    if (!draft.enabledDraft) return toggleRow;
    const catalogStatus = deps.models?.catalogStatus ?? "ready";
    if (catalogStatus === "loading") {
      return toggleRow + row({ label: escapeHtml(t("plug.subagentModelLoading")) });
    }
    if (catalogStatus === "error") {
      return toggleRow + row({
        label: escapeHtml(t("plug.subagentModelLoadFailed")),
        control: `<button class="set-link" type="button" id="plug-subagent-model-retry">`
          + `${escapeHtml(t("plug.subagentModelRetry"))}</button>`
      });
    }
    if (!rows.length) {
      return toggleRow + row({ label: escapeHtml(t("plug.subagentModelEmpty")) });
    }
    const list = groups.map((group) => `<div class="set-model-group">`
      + `<div class="set-model-group-title">${escapeHtml(group.providerName)}</div>`
      + group.candidates.map((candidate) => `<label class="set-model-candidate`
        + `${candidate.available ? "" : " unavailable"}">`
        + `<input type="checkbox" data-subagent-model="${escapeHtml(candidate.key)}"`
        + `${candidate.selected ? " checked" : ""}${draft.writable && !saving.size ? "" : " disabled"} />`
        + `<span class="set-model-candidate-text">`
        + `<span>${escapeHtml(candidate.modelName)}</span>`
        + `<span class="set-row-hint">${escapeHtml(`${candidate.providerName} · ${candidate.provider}/${candidate.model}`)}`
        + `${candidate.available ? "" : ` · ${escapeHtml(t("plug.subagentModelUnavailable"))}`}</span>`
        + `</span></label>`).join("")
      + `</div>`).join("");
    const partial = (deps.models?.catalogFailures ?? []).length
      ? row({ label: escapeHtml(t("plug.subagentModelPartial")) })
      : "";
    return toggleRow
      + row({ label: escapeHtml(t("plug.subagentModelAllowed")) })
      + partial
      + `<div class="set-model-list">${list}</div>`
      + (subagentModelSelectionValid(draft.enabledDraft, draft.selected)
        ? ""
        : notice(t("plug.subagentModelRequired")));
  }

  function renderBody(card) {
    const form = formFor(card);
    return (form?.writable === false ? notice(t("plug.readOnly"), "muted") : "")
      + card.fields.map((field) => renderField(card, field)).join("")
      + (card.credential ? renderCredentialRow(card, form) : "")
      + (card.modelSelection ? renderModelSelection(card) : "")
      + (failed.has(card.namespace) ? notice(t("plug.saveFailed")) : "");
  }

  function renderFooter(card) {
    return formFooter({
      discardId: `plug-discard-${card.namespace}`,
      saveId: `plug-save-${card.namespace}`,
      dirty: isDirty(card),
      valid: isValid(card),
      saving: saving.has(card.namespace)
    });
  }

  function bind(card) {
    const form = formFor(card);
    for (const field of card.fields) {
      host.querySelector(`#plug-${selectorEscape(card.namespace)}-${selectorEscape(field.id)}`)
        ?.addEventListener("input", (event) => {
          form?.edit(field.id, event.target.value);
          failed.delete(card.namespace);
          // 只更新按钮态,避免重画让输入框失焦。
          syncFooter(card);
        });
      host.querySelector(`#plug-reset-${selectorEscape(card.namespace)}-${selectorEscape(field.id)}`)
        ?.addEventListener("click", () => {
          form?.reset(field.id);
          failed.delete(card.namespace);
          requestRender();
        });
    }
    host.querySelector(`#plug-discard-${selectorEscape(card.namespace)}`)?.addEventListener("click", () => {
      form?.discard();
      modelDrafts.delete(card.modelSelection?.namespace);
      failed.delete(card.namespace);
      requestRender();
    });
    host.querySelector(`#plug-save-${selectorEscape(card.namespace)}`)?.addEventListener("click", () => {
      save(card);
    });
    if (card.credential) bindCredential(card);
    if (card.modelSelection) bindModelSelection(card);
  }

  function bindCredential(card) {
    const spec = card.credential;
    const ref = credentialRef(card, namespaceOf(card.namespace)?.value);
    const draftKey = `cred:${card.namespace}`;
    const input = host.querySelector(`#plug-cred-${selectorEscape(card.namespace)}`);
    const wrap = input?.closest(".set-secret");
    if (wrap) bindSecretToggles(wrap.parentElement);
    input?.addEventListener("input", (event) => {
      credentialCache.drafts.set(draftKey, event.target.value);
      const save = host.querySelector(`#plug-cred-save-${selectorEscape(card.namespace)}`);
      if (save) save.disabled = !event.target.value;
    });
    host.querySelector(`#plug-cred-save-${selectorEscape(card.namespace)}`)?.addEventListener("click", async () => {
      const value = credentialCache.drafts.get(draftKey) ?? "";
      if (!value) return;
      try {
        await settingsService.setCredential(ref, value);
        credentialCache.drafts.set(draftKey, "");
        await credentialCache.refresh([ref]);
        requestRender();
      } catch (error) {
        showToast?.(deps.formatErrorDetails(error));
      }
    });
    host.querySelector(`#plug-cred-clear-${selectorEscape(card.namespace)}`)?.addEventListener("click", async () => {
      try {
        await settingsService.unsetCredential(ref);
        await credentialCache.refresh([ref]);
        requestRender();
      } catch (error) {
        showToast?.(deps.formatErrorDetails(error));
      }
    });
  }

  function bindModelSelection(card) {
    const draft = modelDraftFor(card);
    if (!draft) return;
    host.querySelector("#plug-subagent-model-enabled")?.addEventListener("change", (event) => {
      draft.enabledDraft = event.target.checked;
      draft.conflicted = false;
      failed.delete(card.namespace);
      requestRender();
    });
    host.querySelector("#plug-subagent-model-retry")?.addEventListener("click", () => {
      deps.models?.refresh?.().catch(() => {});
      requestRender();
    });
    for (const box of host.querySelectorAll("[data-subagent-model]")) {
      box.addEventListener("change", () => {
        const key = box.dataset.subagentModel;
        if (box.checked) draft.selected.add(key);
        else draft.selected.delete(key);
        // 草稿路由按**当前显示顺序**重建,而不是把新勾的追加到末尾 ——
        // 保存后的列表顺序才是用户看到的那份。
        const rows = subagentModelCandidates(deps.models?.catalogGroups ?? [], draft.routesDraft);
        draft.routesDraft = routesForSelection(rows, draft.selected);
        failed.delete(card.namespace);
        requestRender();
      });
    }
  }

  function syncFooter(card) {
    const save = host.querySelector(`#plug-save-${selectorEscape(card.namespace)}`);
    const discard = host.querySelector(`#plug-discard-${selectorEscape(card.namespace)}`);
    const isSaving = saving.has(card.namespace);
    if (save) save.disabled = !isDirty(card) || !isValid(card) || isSaving;
    if (discard) discard.disabled = !isDirty(card) || isSaving;
  }

  /// 保存:字段走 mutate(单命名空间),模型选择走第二个命名空间。两个都成功才算
  /// 落地;第二个失败时保留模型草稿并把卡片标为失败,让用户可以直接重试。
  async function save(card) {
    const form = formFor(card);
    const draft = modelDraftFor(card);
    if (saving.has(card.namespace)) return;
    saving.add(card.namespace);
    failed.delete(card.namespace);
    requestRender();
    try {
      if (form?.mutations?.length) {
        const settled = await settingsService.mutate(
          card.namespace, form.mutations, form.namespace?.revision
        );
        form.settle(settled);
        if (form.dirty) failed.add(card.namespace);
      }
      if (draft && draftDirty(draft)) {
        const mutations = [];
        if (draft.enabledDraft !== draft.enabled) {
          mutations.push({ op: "set", path: ["enabled"], value: draft.enabledDraft });
        }
        if (draft.enabledDraft
          && JSON.stringify(draft.routesDraft) !== JSON.stringify(draft.routes)) {
          mutations.push({ op: "set", path: ["allowedModels"], value: draft.routesDraft });
        }
        if (mutations.length) {
          const settled = await settingsService.mutate(
            card.modelSelection.namespace, mutations, draft.namespace?.revision
          );
          // 保存期间别的客户端动过同一个命名空间:宿主会拒绝,保留草稿让用户再试。
          if (settled === null || settled === undefined) draft.conflicted = true;
          else {
            draft.enabled = draft.enabledDraft;
            draft.routes = [...draft.routesDraft];
          }
        }
      }
      await describeNow({ refresh: true });
    } catch (error) {
      failed.add(card.namespace);
      showToast?.(deps.formatErrorDetails(error));
    } finally {
      saving.delete(card.namespace);
      requestRender();
    }
  }

  return {
    renderBody,
    renderFooter,
    bind,
    isDirty,
    controlsEnabled: () => saving.size === 0,
    dropCleanDrafts,
    dispose() { forms.clear(); modelDrafts.clear(); saving.clear(); failed.clear(); }
  };
}
