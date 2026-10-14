// 主区域的「插件」管理页。照搬 macos/.../Components/Plugins/PluginsPage.swift:
// 官方 / 已安装两组 + 添加 / 卸载,并含可配置的官方卡片。
//
// 设置页的「内置插件」(只读清单)不在这里,见 builtin-plugins-pane.js。
//
// Mac D30 规则保留:命名空间不被当前部署组装的卡片完全不渲染,而不是画一个
// 禁用的空壳 —— 一张点不动的卡片读起来像坏了,而不像"此部署没有它"。
import { t } from "../../../shared/i18n.js";
import { section, notice, spinner, escapeHtml, backLink } from "./settings-ui.js";
import { cardArtwork } from "./plugin-artwork.js";
import { PLUGIN_CARDS, availableCards } from "./plugin-config-cards.js";
import { createPluginCardViews } from "./plugin-card-view.js";
import { createMarketplaceView } from "./plugin-marketplace.js";
import { createPluginSchemaConfig } from "./plugin-schema-config.js";

export function createPluginsPane({ host, sheet, deps, settingsService, showToast, settingsDialog, renderSlot }) {
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

  const describeNow = ({ refresh = false } = {}) => {
    if (refresh) return refreshDescribe();
    return describe;
  };

  const cards = createPluginCardViews({
    host, deps, settingsService, showToast, describeNow, credentialCache,
    // 卡片不拥有整块 host(那里还画着市场),所以状态一变就请调用方重画。
    requestRender: () => render()
  });

  const schemaConfig = createPluginSchemaConfig({ settingsService, describeNow, onChange: render });

  const marketplace = createMarketplaceView({
    host, sheet, deps, settingsService, showToast, settingsDialog, schemaConfig, renderSlot,
    cards: () => selectableCards(),
    onOpenCard(card) { openedCard = card; render(); scrollToTop(); },
    onInstalled() { refreshDescribe().then(render).catch(() => {}); },
    onChange() { render(); }
  });

  // 0.1.6 的 plugin-manager/changed:宿主的插件启停/装载状态变了。市场是实时视图,
  // 变化到达时必须重读。
  const unsubscribeChanged = deps.sessions?.onPluginManagerChanged?.(() => {
    if (!visible || disposed) return;
    marketplace.refresh({ keepNotices: true });
    refreshDescribe().then(render).catch(() => {});
  });
  if (unsubscribeChanged) cleanups.push(unsubscribeChanged);

  /// 进入 / 离开详情时回到顶部:沿用列表的滚动位置会让详情页从半截开始。
  function scrollToTop() {
    const scroller = host.closest("#management-content, #settings-body");
    if (scroller) scroller.scrollTop = 0;
  }

  function namespacesSet() {
    return new Set((describe?.namespaces ?? []).map((entry) => entry.ns));
  }

  function selectableCards() {
    return availableCards(PLUGIN_CARDS, namespacesSet());
  }

  /// 配置卡片路由:面包屑 + 返回,卡片本体 + 本卡凭证状态的异步载入占位。
  function renderConfigRoute() {
    const card = openedCard;
    if (!card) return "";
    return `<div class="set-detail-nav">${backLink({ id: "plug-back", label: t("plug.crumbRoot") })}</div>`
      + section({
        body: `<div class="set-hero">${cardArtwork(card.id, "lg")}`
          + `<div class="set-hero-text"><div class="set-hero-title">${escapeHtml(t(card.title))}${cardSlot("plugins.detail.badge", card)}</div>`
          + `<div class="set-row-hint">${escapeHtml(t(card.description))}</div></div></div>`
      })
      + section({
        body: `<div class="set-card open"><div class="set-card-body">`
          + cardSlot("plugins.detail.actions", card)
          + (cardSlot("plugins.item", card) || (cards.renderBody(card) + cards.renderFooter(card)))
          + `</div></div>`,
        footer: `<button class="set-link" type="button" id="plug-all-config">${escapeHtml(t("plug.allConfiguration"))}</button>`
      }) + cardSlot("plugins.detail.section", card);
  }

  function renderConfigurable() {
    if (loadingCards && (openedCard || openedSchema)) return spinner();
    if (cardsError && (openedCard || openedSchema)) return section({ body: notice(cardsError) });
    if (openedSchema) {
      return `<div class="set-detail-nav">${backLink({ id: "plug-schema-back", label: openedCard ? t(openedCard.title) : t("plug.crumbRoot") })}</div>`
        + schemaConfig.render(openedSchema);
    }
    if (openedCard) return renderConfigRoute();
    return (cardsError ? section({ body: notice(cardsError) }) : "") + marketplace.render();
  }

  function render() {
    if (disposed || !visible) return;
    slotContributions.length = 0;
    // 整块重画会重建输入框:记下焦点所在的 id 与光标,画完还回去。后台刷新
    // (广播、启停回包)落地时,用户正在搜索或填写的字段不会被抢走焦点。
    const focused = host.ownerDocument.activeElement;
    const focusId = focused && host.contains(focused) && focused.id ? focused.id : null;
    const caret = focusId && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
    const scroller = host.closest("#management-content, #settings-body");
    const scrollTop = scroller?.scrollTop;
    host.innerHTML = renderConfigurable();
    bind();
    if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
    if (focusId) {
      const next = host.ownerDocument.getElementById(focusId);
      if (next && host.contains(next) && !next.disabled) {
        next.focus({ preventScroll: true });
        if (caret) { try { next.setSelectionRange(...caret); } catch { /* 非文本控件 */ } }
      }
    }
  }

  function bind() {
    host.querySelector("#plug-schema-back")?.addEventListener("click", () => { openedSchema = null; render(); });
    host.querySelector("#plug-all-config")?.addEventListener("click", () => { openedSchema = openedCard.namespace; render(); });
    host.querySelector("#plug-back")?.addEventListener("click", () => {
      openedCard = null;
      render();
      scrollToTop();
    });
    // 市场列表的绑定点在它自己的模块里;配置路由里只有卡片本体。
    if (openedSchema) schemaConfig.bind(host, openedSchema);
    else if (openedCard) cards.bind(openedCard);
    else marketplace.bindInto(host);
    slotContributions.forEach(contribution => contribution.bind?.(host));
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
    cardsLoadGeneration += 1;
    loadingCards = true; cardsError = null; render();
    try {
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
      disposed = true; cardsLoadGeneration++;
      cleanups.splice(0).forEach(cleanup => cleanup()); marketplace.dispose(); schemaConfig.dispose(); cards.dispose();
      credentialCache.state.clear(); credentialCache.drafts.clear();
    }
  };
}
