// 插件 pane。照搬 macos/.../Settings/SettingsRoot.swift PluginsSection 与
// Components/Plugins/PluginsPage.swift:一个分段切换器,两个面 ——
// 「插件市场」(官方 / 已安装两组 + 添加 / 卸载,并含可配置的官方卡片)与
// 「内置插件」(只读清单)。
//
// 与 Mac 的差异(刻意保留):内置页签里保留了经 daemon 代理的 dsh plugin
// 装 / 更 / 删控件(plugin-actions-ui.js)。市场页是 pluginManager/* 的界面,
// daemon 不可用或不支持 pluginManager 时它整片降级为说明文字,那时这些控件
// 是唯一的管理入口。
//
// Mac D30 规则保留:命名空间不被当前部署组装的卡片完全不渲染,而不是画一个
// 禁用的空壳 —— 一张点不动的卡片读起来像坏了,而不像"此部署没有它"。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import {
  section, row, textInput, button, notice, spinner, escapeHtml
} from "./settings-ui.js";
import { PLUGIN_CARDS, availableCards } from "./plugin-config-cards.js";
import { createPluginCardViews } from "./plugin-card-view.js";
import { createMarketplaceView } from "./plugin-marketplace.js";
import { createPluginActionsUi } from "./plugin-actions-ui.js";
import { entryText } from "../../../features/settings/plugin-meta.js";
import { createPluginSchemaConfig } from "./plugin-schema-config.js";

const PHASE_TEXT = {
  pending: "inv.pending",
  loading: "inv.loadingPhase",
  active: "inv.active",
  failed: "inv.failed",
  unloading: "inv.unloading"
};

export function createPluginsPane({ host, sheet, deps, settingsService, showToast, pluginActions, settingsDialog,
  readOnlyInventory = false, onOpenManager, renderSlot, tabs = false }) {
  let activeTab = readOnlyInventory ? "inventory" : "marketplace";
  let visible = true, disposed = false, openedSchema = null, refreshWork = null;
  const cleanups = [], slotContributions = [];
  function cardSlot(name, card) {
    const result = renderSlot?.(name, { view: "page", subject: { kind: "item", id: card.id }, form: schemaConfig.form(card.namespace) }, { only: card.id });
    if (!result) return "";
    if (typeof result === "string") return result;
    slotContributions.push(result); return result.html ?? "";
  }
  // 市场里点开的配置卡片;为空时市场列表就是根视图(Mac 的 route)。
  let openedCard = null;
  let describe = null;
  let loadingCards = true;
  let cardsError = null;
  let cardsLoadGeneration = 0;
  // 凭证状态:按 ref 缓存 {configured, writable},草稿值按卡片存 —— 密钥原文
  // 只在用户刚输入的那一刻存在内存里,提交后立刻清掉。
  const credentialCache = {
    state: new Map(),
    drafts: new Map(),
    get(ref) { return this.state.get(ref) ?? null; },
    async refresh(refs) {
      const unique = [...new Set((refs ?? []).filter(Boolean))];
      if (!unique.length) return;
      try {
        const value = await settingsService.describeCredentials(unique);
        for (const ref of unique) this.state.set(ref, value?.[ref] ?? null);
      } catch { /* 凭证是增强信息,读不到不该让整页失败 */ }
    }
  };

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
  const actionState = { actionsAvailable: false, installName: "", actionBusy: null };
  const actionsUi = createPluginActionsUi({
    host,
    pluginActions: readOnlyInventory ? null : pluginActions,
    showToast,
    state: actionState,
    render: () => render()
  });

  const describeNow = ({ refresh = false } = {}) => {
    if (refresh) return refreshDescribe();
    return describe;
  };

  const cards = createPluginCardViews({
    host, deps, settingsService, showToast, describeNow, credentialCache,
    // 卡片不拥有整块 host(那里还画着页签与市场),所以状态一变就请调用方重画。
    requestRender: () => { if (activeTab === "marketplace") render(); }
  });

  const schemaConfig = createPluginSchemaConfig({ settingsService, describeNow, onChange: render });

  const marketplace = createMarketplaceView({
    host, sheet, deps, settingsService, showToast, settingsDialog, schemaConfig, renderSlot,
    cards: () => selectableCards(),
    onOpenCard(card) { openedCard = card; render(); },
    onInstalled() { refreshDescribe().then(render).catch(() => {}); if (inventoryLoaded) loadInventory(); },
    onChange() { if (activeTab === "marketplace") render(); }
  });

  // 0.1.6 的 plugin-manager/changed:宿主的插件启停/装载状态变了。市场与清单
  // 都是实时视图,变化到达时必须重读。没打开过清单就不主动拉。
  const unsubscribeChanged = deps.sessions?.onPluginManagerChanged?.(() => {
    if (!visible || disposed) return;
    if (!readOnlyInventory) {
      marketplace.refresh({ keepNotices: true });
      refreshDescribe().then(render).catch(() => {});
    }
    if (inventoryLoaded || inventoryLoading || activeTab === "inventory") loadInventory();
  });
  if (unsubscribeChanged) cleanups.push(unsubscribeChanged);

  function namespacesSet() {
    return new Set((describe?.namespaces ?? []).map((entry) => entry.ns));
  }

  function selectableCards() {
    return availableCards(PLUGIN_CARDS, namespacesSet());
  }

  function renderTabs() {
    const item = (id, labelKey) => `<button class="set-subtab${activeTab === id ? " active" : ""}"`
      + ` type="button" role="tab" data-subtab="${id}" aria-selected="${activeTab === id}">`
      + `${escapeHtml(t(labelKey))}</button>`;
    return `<div class="set-subtabs" role="tablist" aria-label="${escapeHtml(t("plug.tabs"))}">`
      + item("marketplace", "plug.marketplaceTab")
      + item("inventory", "plug.builtinTab")
      + `</div>`;
  }

  /// 配置卡片路由:面包屑 + 返回,卡片本体 + 本卡凭证状态的异步载入占位。
  function renderConfigRoute() {
    const card = openedCard;
    if (!card) return "";
    return section({
      body: `<div class="set-crumb">${escapeHtml(t("plug.crumbRoot"))} / ${escapeHtml(t(card.title))}</div>`
        + `<button class="set-link" type="button" id="plug-back">`
        + `${lucideIconSvg("chevron-left", { size: 13 })} ${escapeHtml(t("plug.backToList"))}</button>`
    }) + section({
      headerHtml: escapeHtml(t(card.title)) + cardSlot("plugins.detail.badge", card),
      body: `<div class="set-card open"><div class="set-card-body">`
        + cardSlot("plugins.detail.actions", card)
        + (cardSlot("plugins.item", card) || (cards.renderBody(card) + cards.renderFooter(card)))
        + button({ id: "plug-all-config", label: t("plug.allConfiguration") })
        + `</div></div>`,
      footer: escapeHtml(t(card.description))
    }) + cardSlot("plugins.detail.section", card);
  }

  function renderConfigurable() {
    if (loadingCards && (openedCard || openedSchema)) return spinner();
    if (cardsError && (openedCard || openedSchema)) return section({ body: notice(cardsError) });
    if (openedSchema) return section({ body: button({ id: "plug-schema-back", label: t("plug.backToList") }) }) + schemaConfig.render(openedSchema);
    if (openedCard) return renderConfigRoute();
    return (cardsError ? section({ body: notice(cardsError) }) : "") + marketplace.render();
  }

  function filteredInventory() {
    const needle = inventorySearch.trim().toLowerCase();
    if (!needle) return inventory;
    // 译后的标题/说明与技术名一起参与匹配(web PluginInventorySettingsTab.matches)。
    return inventory.filter((entry) => {
      const { title, description } = entryText(entry);
      return [entry.moduleName, entry.entryId, title, description]
        .some((value) => String(value ?? "").toLowerCase().includes(needle));
    });
  }

  function phaseLabel(phase) {
    if (!phase) return t("inv.unobserved");
    return PHASE_TEXT[phase] ? t(PHASE_TEXT[phase]) : phase;
  }

  function renderInventoryRow(entry) {
    const open = inventoryExpanded === entry.entryId;
    const text = entryText(entry);
    const stateKind = entry.enabled
      ? (entry.fiberPhase === "failed" ? "err" : entry.fiberPhase === "active" ? "ok" : "busy")
      : "muted";
    const head = `<button class="set-disclosure${open ? " open" : ""}" type="button"`
      + ` data-inv="${escapeHtml(entry.entryId)}" aria-expanded="${open}">`
      + `<span class="set-disclosure-caret" aria-hidden="true">${lucideIconSvg(open ? "chevron-down" : "chevron-right", { size: 13 })}</span>`
      + `<span class="set-disclosure-text"><span class="set-row-label">${escapeHtml(text.title)}</span></span>`
      + `<span class="set-status ${stateKind}"><i aria-hidden="true"></i>`
      + `${escapeHtml(entry.enabled ? t("inv.enabledTag") : t("inv.disabledTag"))}</span>`
      + `</button>`;
    if (!open) return `<div class="set-card">${head}</div>`;
    const detail = (text.description ? `<div class="set-row-hint">${escapeHtml(text.description)}</div>` : "")
      + `<div class="set-mono">${escapeHtml(entry.entryId)}</div>`
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
    if (disposed || !visible) return;
    slotContributions.length = 0;
    host.innerHTML = (readOnlyInventory ? section({ body: button({ id: "plug-open-manager", label: t("plug.openManager"), kind: "primary" }) }) : tabs ? renderTabs() : "")
      + (activeTab === "marketplace" ? renderConfigurable() : renderInventory());
    bind();
  }

  function bind() {
    host.querySelector("#plug-open-manager")?.addEventListener("click", () => onOpenManager?.());
    host.querySelector("#plug-schema-back")?.addEventListener("click", () => { openedSchema = null; render(); });
    host.querySelector("#plug-all-config")?.addEventListener("click", () => { openedSchema = openedCard.namespace; render(); });
    for (const element of host.querySelectorAll("[data-subtab]")) {
      element.addEventListener("click", () => {
        activeTab = element.dataset.subtab;
        if (activeTab === "inventory" && !inventoryLoaded) loadInventory();
        else render();
      });
    }
    if (activeTab === "marketplace") {
      host.querySelector("#plug-back")?.addEventListener("click", () => {
        openedCard = null;
        render();
      });
      // 市场列表的绑定点在它自己的模块里;配置路由里只有卡片本体。
      if (openedSchema) schemaConfig.bind(host, openedSchema);
      else if (openedCard) cards.bind(openedCard);
      else marketplace.bindInto(host);
    } else {
      bindInventory();
    }
    slotContributions.forEach(contribution => contribution.bind?.(host));
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
        const id = element.dataset.inv;
        inventoryExpanded = inventoryExpanded === id ? null : id;
        render();
      });
    }
    actionsUi.bind(inventory);
  }

  async function loadInventory() {
    const generation = ++inventoryLoadGeneration;
    inventoryLoading = true; inventoryError = null; render();
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

  /// describe 重读。市场与卡片共用同一份快照,所以两个 generation 必须同步推进
  /// —— 否则陈旧的 revision 会被当成 expectedRevision,下一次保存必冲突。
  async function refreshDescribe() {
    const generation = ++cardsLoadGeneration;
    const next = await settingsService.describe();
    if (generation !== cardsLoadGeneration) return describe;
    describe = next;
    // 凭证状态跟着重读(用户可能在别处改过)。
    await credentialCache.refresh(selectableCards()
      .filter((card) => card.credential)
      .map((card) => card.credential.defaultRef));
    cards.dropCleanDrafts();
    return describe;
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    if (refreshWork) return refreshWork;
    refreshWork = refreshNow().finally(() => { refreshWork = null; });
    return refreshWork;
  }

  async function refreshNow() {
    if (disposed) return;
    if (readOnlyInventory) { await loadInventory(); return; }
    cardsLoadGeneration += 1;
    loadingCards = true; cardsError = null; render();
    try {
      if (tabs) await actionsUi.probe();
      await refreshDescribe();
      // Subagent 的模型选择要目录数据:它是卡片的一部分,失败不阻塞保存,
      // 卡片自己会显示"加载失败 + 重试"。
      deps.models?.refresh?.().catch(() => {});
    } catch (error) {
      cardsError = deps.formatErrorDetails(error);
    } finally {
      loadingCards = false;
      render();
    }
    await marketplace.refresh({ keepNotices: true });
  }

  return {
    refresh, relabel: render,
    setVisible(value, { refresh: shouldRefresh = true } = {}) {
      visible = Boolean(value); if (visible && !disposed) { if (shouldRefresh) refresh(); else render(); }
    },
    openBundle(name) { openedCard = null; openedSchema = null; marketplace.openBundle(name); },
    openRow(name, rowId) { openedCard = null; openedSchema = null; marketplace.openRow(name, rowId); },
    openConfiguration(ns) { openedSchema = ns; render(); },
    dispose() {
      disposed = true; cardsLoadGeneration++; inventoryLoadGeneration++;
      cleanups.splice(0).forEach(cleanup => cleanup()); marketplace.dispose(); schemaConfig.dispose(); cards.dispose();
      credentialCache.state.clear(); credentialCache.drafts.clear();
    }
  };
}
