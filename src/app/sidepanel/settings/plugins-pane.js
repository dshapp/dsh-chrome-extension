// 插件 pane。照搬 macos/.../Settings/SettingsRoot.swift PluginsSection:
// 一个分段切换器(可配置 / 插件清单)+ 各自的表单。
//
// 与 Mac 的差异(已与使用者确认):不做「联网搜索」卡片。Mac 那张卡片写的是
// baseURL + maxUses,而宿主 web-search-deepseek 实际暴露的是
// model/apiVersion/maxTokens/maxUses —— 两边字段对不上,且该卡片还要写凭证库,
// 所以整张卡片不渲染。可配置段落只保留 Shell 与 Agent 循环。
//
// Mac D30 规则保留:命名空间不被当前部署组装的卡片完全不渲染,而不是画一个
// 禁用的空壳 —— 一张点不动的卡片读起来像坏了,而不像"此部署没有它"。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import {
  section, row, stackedRow, textInput, button, notice, spinner,
  escapeHtml, tag, formFooter
} from "./settings-ui.js";
import { createPluginSettingsState } from "../../../features/settings/plugin-settings-state.js";
import { createPluginActionsUi } from "./plugin-actions-ui.js";

/// 可配置卡片规格。fields 的 id 即命名空间里的字段名(路径只有一段)。
const CARDS = [
  {
    namespace: "shell",
    title: "plug.bashTitle",
    description: "plug.bashDescription",
    fields: [
      { id: "timeoutMs", label: "plug.bashTimeoutMs", hint: "plug.bashTimeoutMsHint", kind: "number" },
      { id: "maxOutputBytes", label: "plug.bashMaxOutputBytes", hint: "plug.bashMaxOutputBytesHint", kind: "number" }
    ]
  },
  {
    namespace: "agent-loop",
    title: "plug.agentLoopTitle",
    description: "plug.agentLoopDescription",
    fields: [
      { id: "maxParallelToolCalls", label: "plug.agentLoopMaxParallel", hint: "plug.agentLoopMaxParallelHint", kind: "number" }
    ]
  }
];

const PHASE_TEXT = {
  pending: "inv.pending",
  loading: "inv.loadingPhase",
  active: "inv.active",
  failed: "inv.failed",
  unloading: "inv.unloading"
};

/// 模块短名:@scope/dsh-xxx → dsh-xxx,cordis:include → include。
function moduleShortName(moduleName) {
  const raw = String(moduleName ?? "");
  if (raw.includes(":")) return raw.slice(raw.lastIndexOf(":") + 1);
  if (raw.startsWith("@")) return raw.slice(raw.indexOf("/") + 1);
  return raw;
}

export function createPluginsPane({ host, deps, settingsService, showToast, pluginActions }) {
  let activeTab = "configurable";
  // 每张卡片一份暂存态,按命名空间存;切 tab 不该丢掉正在编辑的草稿(Mac D.D29)。
  const forms = new Map();
  const expanded = new Set();
  let describe = null;
  let loadingCards = true;
  let cardsError = null;
  let cardsLoadGeneration = 0;

  let inventory = [];
  let inventoryError = null;
  let inventoryLoading = false;
  let inventoryLoaded = false;
  let inventorySearch = "";
  let inventoryExpanded = null;
  let inventoryLoadGeneration = 0;
  // 装 / 更 / 删经 daemon 代理。daemon 不可用(老版本、没跑、被关掉)时这些控件
  // 整体不渲染 —— 与"命名空间不被组装就不画卡片"同一条规则:一个点不动的按钮
  // 读起来像坏了,而不像"此部署没有它"。
  // 状态放在一个对象里,好让 plugin-actions-ui 与本文件共享同一份,而不是各存一半。
  const actionState = { actionsAvailable: false, installName: "", actionBusy: null };
  // render 在下面才定义,这里用一层间接调用把它晚绑定 —— 直接传 render 会捕获
  // 到 undefined(函数声明会提升,但这行在模块工厂里先于赋值执行)。
  const actionsUi = createPluginActionsUi({
    host,
    pluginActions,
    showToast,
    state: actionState,
    render: () => render()
  });
  const saving = new Set();
  const failed = new Set();

  function availableCards() {
    const namespaces = new Set((describe?.namespaces ?? []).map((entry) => entry.ns));
    return CARDS.filter((card) => namespaces.has(card.namespace));
  }

  function formFor(card) {
    let form = forms.get(card.namespace);
    if (form) return form;
    const namespace = (describe?.namespaces ?? []).find((entry) => entry.ns === card.namespace);
    if (!namespace) return null;
    form = createPluginSettingsState({
      namespace,
      writable: describe?.writable === true,
      fields: Object.fromEntries(card.fields.map((field) => [field.id, field.kind]))
    });
    forms.set(card.namespace, form);
    return form;
  }

  function renderTabs() {
    const item = (id, labelKey) => `<button class="set-subtab${activeTab === id ? " active" : ""}"`
      + ` type="button" role="tab" data-subtab="${id}" aria-selected="${activeTab === id}">`
      + `${escapeHtml(t(labelKey))}</button>`;
    return `<div class="set-subtabs" role="tablist" aria-label="${escapeHtml(t("plug.tabs"))}">`
      + item("configurable", "plug.configurableTab")
      + item("inventory", "plug.inventoryTab")
      + `</div>`;
  }

  function renderField(card, field) {
    const form = formFor(card);
    const state = form?.field(field.id) ?? { text: "", overridden: false, invalid: false };
    const hint = state.invalid
      ? `<span class="set-danger">${escapeHtml(t("plug.invalidNumber"))}</span>`
      : escapeHtml(t(field.hint));
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

  function renderCard(card) {
    const form = formFor(card);
    const open = expanded.has(card.namespace);
    const isSaving = saving.has(card.namespace);
    const dirty = form?.dirty === true;
    const valid = form?.invalid === false;
    const head = `<button class="set-disclosure${open ? " open" : ""}" type="button"`
      + ` id="plug-head-${card.namespace}" aria-expanded="${open}">`
      + `<span class="set-disclosure-caret" aria-hidden="true">${lucideIconSvg(open ? "chevron-down" : "chevron-right", { size: 13 })}</span>`
      + `<span class="set-disclosure-text">`
      + `<span class="set-row-label">${escapeHtml(t(card.title))}${dirty ? tag(t("plug.unsaved"), "accent") : ""}</span>`
      + `<span class="set-row-hint">${escapeHtml(t(card.description))}</span>`
      + `</span></button>`;
    if (!open) return `<div class="set-card">${head}</div>`;
    const body = (form?.writable === false ? notice(t("plug.readOnly"), "muted") : "")
      + card.fields.map((field) => renderField(card, field)).join("")
      + (failed.has(card.namespace) ? notice(t("plug.saveFailed")) : "")
      + formFooter({
        discardId: `plug-discard-${card.namespace}`,
        saveId: `plug-save-${card.namespace}`,
        dirty, valid, saving: isSaving
      });
    return `<div class="set-card">${head}<div class="set-card-body">${body}</div></div>`;
  }

  function renderConfigurable() {
    if (loadingCards) return spinner();
    if (cardsError) return section({ body: notice(cardsError) });
    const cards = availableCards();
    if (!cards.length) {
      return section({ body: `<div class="set-empty">${escapeHtml(t("plug.empty"))}</div>` });
    }
    return section({
      body: cards.map(renderCard).join(""),
      footer: escapeHtml(t("plug.intro"))
    });
  }

  function filteredInventory() {
    const needle = inventorySearch.trim().toLowerCase();
    if (!needle) return inventory;
    return inventory.filter((entry) => (
      String(entry.moduleName ?? "").toLowerCase().includes(needle)
      || String(entry.entryId ?? "").toLowerCase().includes(needle)
    ));
  }

  function phaseLabel(phase) {
    if (!phase) return t("inv.unobserved");
    return PHASE_TEXT[phase] ? t(PHASE_TEXT[phase]) : phase;
  }

  function renderInventoryRow(entry) {
    const open = inventoryExpanded === entry.entryId;
    const stateKind = entry.enabled
      ? (entry.fiberPhase === "failed" ? "err" : entry.fiberPhase === "active" ? "ok" : "busy")
      : "muted";
    const head = `<button class="set-disclosure${open ? " open" : ""}" type="button"`
      + ` data-inv="${escapeHtml(entry.entryId)}" aria-expanded="${open}">`
      + `<span class="set-disclosure-caret" aria-hidden="true">${lucideIconSvg(open ? "chevron-down" : "chevron-right", { size: 13 })}</span>`
      + `<span class="set-disclosure-text"><span class="set-row-label">${escapeHtml(moduleShortName(entry.moduleName))}</span></span>`
      + `<span class="set-status ${stateKind}"><i aria-hidden="true"></i>`
      + `${escapeHtml(entry.enabled ? t("inv.enabledTag") : t("inv.disabledTag"))}</span>`
      + `</button>`;
    if (!open) return `<div class="set-card">${head}</div>`;
    const detail = `<div class="set-mono">${escapeHtml(entry.entryId)}</div>`
      + row({
        label: escapeHtml(t("inv.configuration")),
        control: escapeHtml(entry.enabled ? t("inv.enabledTag") : t("inv.disabledTag"))
      })
      + (entry.enabled
        ? row({ label: escapeHtml(t("inv.cordis")), control: escapeHtml(phaseLabel(entry.fiberPhase)) })
        : "")
      + actionsUi.renderRowActions(entry);
    return `<div class="set-card">${head}<div class="set-card-body">${detail}</div></div>`;
  }

  function renderInventory() {
    const searchRow = `<div class="set-row stacked"><div class="set-row-control wide">`
      + textInput({ id: "inv-search", value: inventorySearch, placeholder: t("inv.search") })
      + `</div></div>`;
    if (inventoryLoading) return section({ body: searchRow + spinner() });
    if (inventoryError) {
      return section({
        body: searchRow + notice(t("inv.error"))
          + `<div class="set-form-footer"><span class="set-spacer"></span>`
          + button({ id: "inv-retry", label: t("inv.retry"), kind: "primary" }) + `</div>`
      });
    }
    if (!inventory.length) {
      return section({ body: searchRow + `<div class="set-empty">${escapeHtml(t("inv.empty"))}</div>` });
    }
    const rows = filteredInventory();
    if (!rows.length) {
      return section({ body: searchRow + `<div class="set-empty">${escapeHtml(t("inv.emptySearch"))}</div>` });
    }
    return section({ body: searchRow })
      + actionsUi.renderInstallRow()
      + section({
        header: `${t("inv.catalog")} · ${rows.length}`,
        body: rows.map(renderInventoryRow).join("")
      });
  }

  function render() {
    host.innerHTML = renderTabs()
      + (activeTab === "configurable" ? renderConfigurable() : renderInventory());
    bind();
  }

  function bind() {
    for (const element of host.querySelectorAll("[data-subtab]")) {
      element.addEventListener("click", () => {
        activeTab = element.dataset.subtab;
        if (activeTab === "inventory" && !inventoryLoaded) loadInventory();
        else render();
      });
    }
    if (activeTab === "configurable") bindCards();
    else bindInventory();
  }

  function bindCards() {
    for (const card of availableCards()) {
      host.querySelector(`#plug-head-${CSS.escape(card.namespace)}`)?.addEventListener("click", () => {
        if (expanded.has(card.namespace)) expanded.delete(card.namespace);
        else expanded.add(card.namespace);
        render();
      });
      const form = formFor(card);
      for (const field of card.fields) {
        host.querySelector(`#plug-${CSS.escape(card.namespace)}-${CSS.escape(field.id)}`)
          ?.addEventListener("input", (event) => {
            form?.edit(field.id, event.target.value);
            failed.delete(card.namespace);
            // 只更新按钮态,避免重画让输入框失焦。
            syncCardFooter(card);
          });
        host.querySelector(`#plug-reset-${CSS.escape(card.namespace)}-${CSS.escape(field.id)}`)
          ?.addEventListener("click", () => {
            form?.reset(field.id);
            failed.delete(card.namespace);
            render();
          });
      }
      host.querySelector(`#plug-discard-${CSS.escape(card.namespace)}`)?.addEventListener("click", () => {
        form?.discard();
        failed.delete(card.namespace);
        render();
      });
      host.querySelector(`#plug-save-${CSS.escape(card.namespace)}`)?.addEventListener("click", () => {
        saveCard(card);
      });
    }
  }

  function syncCardFooter(card) {
    const form = formFor(card);
    const save = host.querySelector(`#plug-save-${CSS.escape(card.namespace)}`);
    const discard = host.querySelector(`#plug-discard-${CSS.escape(card.namespace)}`);
    const isSaving = saving.has(card.namespace);
    if (save) save.disabled = !form?.dirty || form?.invalid === true || isSaving;
    if (discard) discard.disabled = !form?.dirty || isSaving;
  }

  async function saveCard(card) {
    const form = formFor(card);
    const mutations = form?.mutations;
    if (!form || !mutations?.length || saving.has(card.namespace)) return;
    saving.add(card.namespace);
    failed.delete(card.namespace);
    render();
    try {
      const settled = await settingsService.mutate(
        card.namespace, mutations, form.namespace?.revision
      );
      form.settle(settled);
      if (form.dirty) failed.add(card.namespace);
      // 重新 describe:命名空间 revision 变了,别的卡片也要跟上。
      //
      // 这次读取与 refresh() 抢同一个 describe/forms,所以必须共用同一个
      // generation:期间若用户切走再切回(activate 会强制 refresh)或另一张卡
      // 也保存完毕,较新的快照已经落地,这里的旧回包不能再覆盖它 ——
      // 否则 formFor 会拿陈旧 revision 当 expectedRevision,下次保存必冲突。
      const generation = ++cardsLoadGeneration;
      const nextDescribe = await settingsService.describe();
      if (generation !== cardsLoadGeneration) return;
      describe = nextDescribe;
      for (const [ns, staged] of forms) {
        if (staged.dirty) continue;
        forms.delete(ns);
      }
    } catch (error) {
      failed.add(card.namespace);
      showToast?.(deps.formatErrorDetails(error));
    } finally {
      saving.delete(card.namespace);
      render();
    }
  }

  function bindInventory() {
    const search = host.querySelector("#inv-search");
    search?.addEventListener("input", (event) => {
      inventorySearch = event.target.value;
      if (inventoryExpanded && !filteredInventory().some((entry) => entry.entryId === inventoryExpanded)) {
        inventoryExpanded = null;
      }
      render();
      // 重画后把焦点与光标还给搜索框。
      const fresh = host.querySelector("#inv-search");
      if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
    });
    host.querySelector("#inv-retry")?.addEventListener("click", () => loadInventory());
    for (const element of host.querySelectorAll("[data-inv]")) {
      element.addEventListener("click", () => {
        inventoryExpanded = inventoryExpanded === element.dataset.inv ? null : element.dataset.inv;
        render();
      });
    }
    actionsUi.bind(inventory);
  }

  async function loadInventory() {
    const generation = ++inventoryLoadGeneration;
    inventoryLoading = true; inventoryError = null; render();
    // 先探一次代理可用性,再决定要不要画那些按钮。清单本身来自 dsh web,
    // 与代理是两条独立链路 —— 代理不可用不该让清单也读不出来。
    await actionsUi.probe();
    if (generation !== inventoryLoadGeneration) return;
    try {
      const value = await settingsService.pluginInventory();
      if (generation !== inventoryLoadGeneration) return;
      inventory = value?.entries ?? [];
      inventoryLoaded = true;
    } catch (error) {
      if (generation !== inventoryLoadGeneration) return;
      inventoryError = deps.formatErrorDetails(error);
    } finally {
      if (generation !== inventoryLoadGeneration) return;
      inventoryLoading = false;
      render();
    }
  }

  async function refresh() {
    const generation = ++cardsLoadGeneration;
    loadingCards = true; cardsError = null; render();
    try {
      const nextDescribe = await settingsService.describe();
      if (generation !== cardsLoadGeneration) return;
      describe = nextDescribe;
      // 干净的草稿丢弃重建,让卡片显示最新的宿主值;有未保存编辑的保留。
      for (const [ns, staged] of forms) {
        if (!staged.dirty) forms.delete(ns);
      }
    } catch (error) {
      if (generation !== cardsLoadGeneration) return;
      cardsError = deps.formatErrorDetails(error);
    } finally {
      if (generation !== cardsLoadGeneration) return;
      loadingCards = false;
      render();
    }
  }

  return { refresh };
}
