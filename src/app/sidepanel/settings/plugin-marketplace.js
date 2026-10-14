// 插件市场。对齐 Mac PluginsPage(Components/Plugins/PluginsPage.swift):
// 「官方」与「已安装」两个分组 + 行内启停 + 添加插件 + 卸载确认。
//
// 分组口径按 Mac:
//   official = 宿主明确标记 official 的 bundle 与可配置官方卡片(非 optional 分组)。
//   installed = 其余已经装上的 bundle。
// bundle 行显示 name + vX.Y.Z + 描述;有 readOnlyReason 时开关禁用并显示原因
// (management-required 这类 bundle 由安装本身管,启停它只会失败)。
import { t } from "../../../shared/i18n.js";
import {
  section, row, button, iconButton, toggle, tag, notice, spinner,
  escapeHtml, groupHeader, selectorEscape, searchField, segmented, chevron,
  busyIndicator, bindClickableRows, isRowControlTarget
} from "./settings-ui.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import { openPluginInstallSheet } from "./plugin-install-sheet.js";
import { bundleText } from "../../../features/settings/plugin-meta.js";
import { createPluginDetailView, updateAvailable } from "./plugin-detail-view.js";
import { packageArtwork, cardArtwork } from "./plugin-artwork.js";

/// 宿主给的是机器码,展示要落到本地文案。认不出的码原样显示 —— 编一个更好听的
/// 说法会掩盖"宿主加了一条新的只读原因"。
const READ_ONLY_TEXT = {
  "management-required": "plug.readOnlyManagement",
  "unaddressable": "plug.readOnlyUnaddressable"
};

/// 变更结果 → 就地提示的文案。restart-required 是最常见的一种:装上了但当前
/// profile 还没重启,如实说明比假装成功好。
const APPLICATION_TEXT = {
  applied: "plug.changedApplied",
  "restart-required": "plug.changedRestart",
  overridden: "plug.changedOverridden",
  failed: "plug.changedFailed"
};
/// 结果的语气:成功 / 需要注意 / 失败,决定就地提示的颜色。
const APPLICATION_KIND = { applied: "ok", "restart-required": "warn", overridden: "warn", failed: "err" };

export function createMarketplaceView({
  host: initialHost, sheet, deps, settingsService, showToast, settingsDialog, cards,
  onOpenCard, onInstalled, onChange, schemaConfig, renderSlot
}) {
  let host = initialHost;
  // cards 传函数而不是数组:哪几张卡可用取决于当次 settings/describe 的命名空间快照,
  // 而那个快照在 pane 创建时还没回来。解构一个 getter 只在创建那一刻取一次值 ——
  // 那样卡片永远看不到自己的命名空间,表现为"官方组里一张配置卡都没有"。
  const cardsOf = typeof cards === "function" ? cards : () => cards ?? [];
  let bundles = [];
  let entries = [];
  let loading = true;
  let loadError = null;
  let loadGeneration = 0;
  // 正在启停/卸载的 bundle 名:行内显示忙碌并禁用开关,避免连点。
  const busy = new Set();
  // 最近一次变更的结果,按 bundle 名就地显示(整页 toast 会立刻消失,用户
  // 从弹窗回到列表时看不到它)。
  const notices = new Map();
  const noticeKinds = new Map();
  // 列表筛选:搜索词 + 启用状态。只影响列表视图,详情页不受影响。
  let query = "";
  let filter = "all";
  // 首次载入完成之前才画整页 loading;之后的刷新(启停、广播)保留列表,
  // 只让刷新键转起来 —— 否则每拨一次开关整页都会闪一下「加载中」。
  let loadedOnce = false;
  let opened = null;
  let disposed = false;
  const details = createPluginDetailView({ settingsService, sheet, deps, schemaConfig, renderSlot,
    onBack() { opened = opened?.rowId ? { name: opened.name } : null; renderHost(); scrollToTop(); },
    onOpenRow(name, rowId) { opened = { name, rowId }; renderHost(); scrollToTop(); },
    onChange(options) { if (options?.refresh) return refresh({ keepNotices: true }); renderHost(); },
    onEnable: setEnabled, onInstall: installTarget, onRemove: confirmRemove
  });
  function openBundle(name, rowId) { opened = { name, rowId }; details.refreshExemptions(); renderHost(); scrollToTop(); }
  /// 进入 / 离开详情回到顶部:沿用列表的滚动位置会让详情从半截开始。
  function scrollToTop() {
    const scroller = host?.closest?.("#management-content, #settings-body");
    if (scroller) scroller.scrollTop = 0;
  }
  function installTarget(bundle) {
    if (!bundle.installTarget || !sheet) return;
    openPluginInstallSheet({ sheet, settingsDialog, deps, settingsService, showToast,
      initialSpec: bundle.installTarget.spec, enabled: bundle.availability === "missing" ? true : bundle.enabled, saveExact: true,
      catalog: { name: bundle.name, version: bundle.installTarget.version, description: bundle.description, bundle: true },
      onInstalled: async result => { await refresh(); onInstalled?.(result); }
    });
  }

  function noteHtml(name) {
    const text = notices.get(name);
    if (!text) return "";
    const kind = noticeKinds.get(name) ?? "muted";
    const icon = kind === "ok" ? "check" : kind === "muted" ? "info" : "triangle-alert";
    return `<div class="set-row-note ${kind}">${lucideIconSvg(icon, { size: 12 })}<span>${escapeHtml(text)}</span></div>`;
  }

  function bundleRow(bundle) {
    const isBusy = busy.has(bundle.name);
    const readOnlyReason = bundle.readOnlyReason;
    const version = bundle.version ? tag(t("plug.versionTag", { version: bundle.version }), "muted") : "";
    // 名称与说明取包自带的多语言 meta(0.1.7),按扩展当前语言回退;技术名留给 title 提示。
    const text = bundleText(bundle);
    // 整行是"打开详情"的点击目标;开关 / 更新 / 卸载是行内独立控件。
    return row({
      // 图标直接用接口自带的 meta.icon(与 DSH web 一致),没有就用 web 的默认图。
      leading: packageArtwork(bundle.meta?.icon),
      label: `<span class="set-row-title" title="${escapeHtml(bundle.name)}">${escapeHtml(text.title)}</span>` + version
        + (updateAvailable(bundle) ? tag(t("plug.updateAvailable"), "accent") : ""),
      hint: `<span class="set-clamp">${escapeHtml(text.description || t("plug.noDescription"))}</span>`
        + (readOnlyReason
          ? `<div class="set-row-note muted">${lucideIconSvg("info", { size: 12 })}<span>${escapeHtml(readOnlyKey(readOnlyReason))}</span></div>`
          : "")
        + noteHtml(bundle.name),
      control: (isBusy ? busyIndicator(t("plug.busy")) : "")
        + (updateAvailable(bundle) ? button({ id: `plug-bundle-update-${bundle.name}`, label: t("plug.update"), disabled: isBusy }) : "")
        + (bundle.removable && bundle.installed
          ? iconButton({
            id: `plug-bundle-del-${bundle.name}`,
            icon: "trash-2",
            title: t("plug.uninstall"),
            kind: "danger reveal",
            disabled: isBusy
          })
          : "")
        + toggle({
          id: `plug-bundle-${bundle.name}`,
          checked: bundle.enabled,
          disabled: Boolean(readOnlyReason) || isBusy || (bundle.availability === "missing" && !bundle.installTarget),
          ariaLabel: t("plug.enableNamed", { name: text.title })
        })
        + chevron(),
      id: `plug-bundle-row-${bundle.name}`,
      clickable: true,
      className: isBusy ? "busy" : ""
    });
  }

  function readOnlyKey(reason) {
    return READ_ONLY_TEXT[reason] ? t(READ_ONLY_TEXT[reason]) : reason;
  }

  /// 可配置的官方卡片在这里以一行形式出现,点了进配置视图(Mac 的 configRow)。
  /// 它们没有启停开关(随宿主常驻),所以在开关的位置放一枚"设置"标签。
  function cardRow(card) {
    return row({
      leading: cardArtwork(card.id),
      label: `<span class="set-row-title">${escapeHtml(t(card.title))}</span>` + tag(t("plug.configurable"), "muted"),
      hint: `<span class="set-clamp">${escapeHtml(t(card.description))}</span>`,
      control: chevron(),
      id: `plug-card-row-${card.id}`,
      clickable: true
    });
  }

  function officialBundles() {
    return bundles.filter((bundle) => bundle.official === true || (bundle.official === undefined && bundle.optional === true));
  }

  function installedBundles() {
    return bundles.filter((bundle) => !officialBundles().includes(bundle) && bundle.installed);
  }

  function matchesQuery(values) {
    const needle = query.trim().toLowerCase();
    return !needle || values.some((value) => String(value ?? "").toLowerCase().includes(needle));
  }

  function bundleVisible(bundle) {
    if (filter === "enabled" && !bundle.enabled) return false;
    if (filter === "disabled" && bundle.enabled) return false;
    const text = bundleText(bundle);
    return matchesQuery([bundle.name, text.title, text.description]);
  }

  function cardVisible(card) {
    // 配置卡片没有启停态:只在「全部」里出现。
    if (filter !== "all") return false;
    return matchesQuery([card.id, t(card.title), t(card.description)]);
  }

  /// 列表顶栏:搜索 + 状态筛选 + 刷新 / 添加。放在顶部而不是列表末尾 ——
  /// 十几个插件时,底部的「添加插件」要滚到底才看得见。
  function renderToolbar() {
    const listed = [...officialBundles(), ...installedBundles()];
    const enabledCount = listed.filter((bundle) => bundle.enabled).length;
    const refreshing = loading && loadedOnce;
    return `<div class="set-toolbar">`
      + searchField({
        id: "plug-search", value: query, placeholder: t("plug.searchPlaceholder"),
        clearId: "plug-search-clear", clearLabel: t("plug.searchClear")
      })
      + `<div class="set-toolbar-row">`
      + segmented({
        id: "plug-filter",
        ariaLabel: t("plug.filterAria"),
        value: filter,
        options: [
          { value: "all", label: t("plug.filterAll"), count: listed.length + cardsOf().length },
          { value: "enabled", label: t("plug.filterEnabled"), count: enabledCount },
          { value: "disabled", label: t("plug.filterDisabled"), count: listed.length - enabledCount }
        ]
      })
      + `<span class="set-spacer"></span>`
      + `<button class="set-icon-btn${refreshing ? " spinning" : ""}" type="button" id="plug-refresh"`
      + ` title="${escapeHtml(t("plug.refresh"))}" aria-label="${escapeHtml(t("plug.refresh"))}"${refreshing ? " disabled" : ""}>`
      + `${lucideIconSvg("refresh", { size: 14 })}</button>`
      + `<button class="set-btn primary with-icon" type="button" id="plug-add">`
      + `${lucideIconSvg("plus", { size: 13 })}<span>${escapeHtml(t("plug.addTitle"))}</span></button>`
      + `</div></div>`;
  }

  function render() {
    if (loading && !loadedOnce) return spinner();
    if (loadError && !loadedOnce) {
      return section({
        body: notice(loadError)
          + `<div class="set-form-footer"><span class="set-spacer"></span>`
          + button({ id: "plug-market-retry", label: t("set.retry"), kind: "primary" })
          + `</div>`
      });
    }
    if (opened) {
      const bundle = bundles.find(item => item.name === opened.name);
      if (bundle) return details.render(bundle, entries, opened.rowId, notices.get(bundle.name));
      opened = null;
    }
    const official = officialBundles();
    const installed = installedBundles();
    const available = cardsOf();
    const officialCount = official.length + available.length;
    if (!officialCount && !installed.length) {
      return renderToolbar() + section({ body: `<div class="set-empty">${escapeHtml(t("plug.marketEmpty"))}</div>` });
    }
    const officialRows = official.filter(bundleVisible).map(bundleRow).join("")
      + available.filter(cardVisible).map(cardRow).join("");
    const installedRows = installed.filter(bundleVisible).map(bundleRow).join("");
    const groups = [];
    // 刷新失败但已有数据:保留列表,只在顶部给一条可重试的提示。
    if (loadError) {
      groups.push(section({
        body: notice(loadError)
          + `<div class="set-form-footer"><span class="set-spacer"></span>`
          + button({ id: "plug-market-retry", label: t("set.retry"), kind: "primary" }) + `</div>`
      }));
    }
    if (officialCount) {
      groups.push(section({
        headerHtml: groupHeader(t("plug.official"), officialCount, "plug-count-official"),
        body: officialRows || `<div class="set-empty">${escapeHtml(t("plug.noMatches"))}</div>`
      }));
    }
    if (installed.length) {
      groups.push(section({
        headerHtml: groupHeader(t("plug.installedGroup"), installed.length, "plug-count-installed"),
        body: installedRows || `<div class="set-empty">${escapeHtml(t("plug.noMatches"))}</div>`
      }));
    }
    return renderToolbar() + groups.join("");
  }

  function bind() {
    if (opened) { details.bind(host); return; }
    host.querySelector("#plug-market-retry")?.addEventListener("click", () => refresh({ keepNotices: true }));
    host.querySelector("#plug-refresh")?.addEventListener("click", () => refresh({ keepNotices: true }));
    host.querySelector("#plug-add")?.addEventListener("click", () => {
      openPluginInstallSheet({
        sheet, settingsDialog, deps, settingsService, showToast,
        onInstalled: async (result) => {
          await refresh();
          onInstalled?.(result);
        }
      });
    });
    bindToolbar();
    for (const card of cardsOf()) {
      host.querySelector(`#plug-card-row-${selectorEscape(card.id)}`)?.addEventListener("click", () => onOpenCard?.(card));
    }
    for (const bundle of bundles) {
      host.querySelector(`#plug-bundle-row-${selectorEscape(bundle.name)}`)?.addEventListener("click", (event) => {
        if (isRowControlTarget(event)) return;
        openBundle(bundle.name);
      });
      host.querySelector(`#plug-bundle-update-${selectorEscape(bundle.name)}`)?.addEventListener("click", () => installTarget(bundle));
      host.querySelector(`#plug-bundle-${selectorEscape(bundle.name)}`)?.addEventListener("change", (event) => {
        setEnabled(bundle, event.target.checked);
      });
      host.querySelector(`#plug-bundle-del-${selectorEscape(bundle.name)}`)?.addEventListener("click", () => {
        confirmRemove(bundle);
      });
    }
    bindClickableRows(host);
  }

  /// 搜索与筛选。重画由 pane 整块完成(host.innerHTML),所以每次重画后把焦点
  /// 与光标还给搜索框;输入法组合期间不重画,组合结束再应用,避免打断拼音。
  function bindToolbar() {
    const search = host.querySelector("#plug-search");
    const apply = (value) => {
      query = value;
      const caret = search.selectionStart;
      renderHost();
      const fresh = host.querySelector("#plug-search");
      if (fresh) { fresh.focus(); try { fresh.setSelectionRange(caret, caret); } catch { /* 非文本框 */ } }
    };
    search?.addEventListener("input", (event) => { if (!event.isComposing) apply(search.value); });
    search?.addEventListener("compositionend", () => apply(search.value));
    search?.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); apply(""); }
    });
    host.querySelector("#plug-search-clear")?.addEventListener("click", () => {
      query = "";
      renderHost();
      host.querySelector("#plug-search")?.focus();
    });
    for (const segment of host.querySelectorAll("#plug-filter [data-segment]")) {
      segment.addEventListener("click", (event) => {
        filter = segment.dataset.segment;
        renderHost();
        // 键盘触发(detail 为 0)时把焦点还给新画出的同一段;鼠标点击不抢焦点,免得出现焦点框。
        if (event.detail === 0) host.querySelector(`#plug-filter [data-segment="${filter}"]`)?.focus();
      });
    }
  }

  async function setEnabled(bundle, enabled, selected) {
    if (disposed || busy.has(bundle.name) || bundle.readOnlyReason || selected?.readOnlyReason) return;
    if (!selected && enabled && bundle.availability === "missing") { installTarget(bundle); renderHost(); return; }
    busy.add(bundle.name);
    notices.delete(bundle.name);
    renderHost();
    try {
      const result = selected
        ? await settingsService.setPluginEnabled(selected.entry.entryId, enabled)
        : await settingsService.setBundleEnabled(bundle.name, enabled);
      notices.set(bundle.name, applicationText(result));
      noticeKinds.set(bundle.name, applicationKind(result));
      await refresh({ keepNotices: true });
    } catch (error) {
      // 失败时刷新会把开关拨回宿主的真实状态 —— 乐观留下的位置是假的。
      notices.set(bundle.name, deps.formatErrorDetails(error));
      noticeKinds.set(bundle.name, "err");
      showToast?.(deps.formatErrorDetails(error));
      await refresh({ keepNotices: true });
    } finally {
      busy.delete(bundle.name);
      renderHost();
    }
  }

  function applicationKind(result) {
    if (!result) return "muted";
    if (result.error) return "err";
    return APPLICATION_KIND[result.application] ?? "muted";
  }

  function applicationText(result) {
    if (!result) return "";
    if (result.error?.diagnostic) return result.error.diagnostic;
    if (result.error?.code) return result.error.code;
    const key = APPLICATION_TEXT[result.application];
    return key ? t(key) : "";
  }

  /// 卸载确认。Mac 用的是带 destructive 角色的确认框;这里复用设置页的 sheet。
  function confirmRemove(bundle) {
    if (!sheet) return;
    const token = sheet.open({
      title: t("plug.uninstall"),
      body: `<p class="set-sheet-text">${escapeHtml(t("plug.uninstallMessage", { name: bundle.name }))}</p>`
        + `<div class="set-sheet-error" id="plug-remove-error"></div>`,
      actions: button({ id: "plug-remove-cancel", label: t("set.cancel") })
        + button({ id: "plug-remove-confirm", label: t("plug.uninstallNamed", { name: bundle.name }), kind: "danger" }),
      bind(root) {
        root.querySelector("#plug-remove-cancel").addEventListener("click", () => sheet.close(token));
        const confirm = root.querySelector("#plug-remove-confirm");
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          confirm.textContent = t("plug.removing");
          busy.add(bundle.name);
          try {
            const result = await settingsService.removeBundle(bundle.name);
            if (!sheet.owns(token)) return;
            sheet.close(token);
            notices.set(bundle.name, applicationText(result));
            noticeKinds.set(bundle.name, applicationKind(result));
            await refresh({ keepNotices: true });
          } catch (error) {
            if (!sheet.owns(token)) return;
            root.querySelector("#plug-remove-error").textContent = deps.formatErrorDetails(error);
            confirm.disabled = false;
            confirm.textContent = t("plug.uninstallNamed", { name: bundle.name });
          } finally {
            busy.delete(bundle.name);
            renderHost();
          }
        });
      }
    });
  }

  // 本模块不拥有整块 host(那里还画着页签),所以状态一变就请调用方重画整页,
  // 由它再把 HTML 拼回去。自己偷偷改 host.innerHTML 会把页签抹掉。
  // paint() 是"只画这一块"的入口,给测试与没有页签的场景用。
  function paint() {
    host.innerHTML = render();
    bind();
  }

  function renderHost() {
    if (disposed) return;
    if (onChange) onChange();
    else paint();
  }

  async function refresh({ keepNotices = false } = {}) {
    const generation = ++loadGeneration;
    loading = true;
    if (!keepNotices) { notices.clear(); noticeKinds.clear(); }
    renderHost();
    try {
      const [nextBundles, nextEntries] = await Promise.all([
        settingsService.pluginBundles(),
        settingsService.pluginEntries().catch(() => [])
      ]);
      if (generation !== loadGeneration) return;
      bundles = Array.isArray(nextBundles) ? nextBundles : [];
      entries = Array.isArray(nextEntries) ? nextEntries : [];
      loadError = null;
      loadedOnce = true;
    } catch (error) {
      if (generation !== loadGeneration) return;
      loadError = deps.formatErrorDetails(error);
    } finally {
      if (generation !== loadGeneration) return;
      loading = false;
      renderHost();
    }
  }

  // 安装/启停会改 profile 并触发 plugin-manager/changed;订阅由 plugins-pane 统一持有,
  // 它会在事件到达时调这里的 refresh。这里只暴露只读清单给调试/测试。
  return {
    refresh,
    openBundle,
    openRow: (name, rowId) => openBundle(name, rowId),
    dispose() { disposed = true; loadGeneration++; details.dispose(); },
    /// 市场列表的 HTML(plugins-pane 把它拼进页签内容里)。
    render,
    /// 只画这一块(不含页签)并绑定。
    paint,
    /// 绑定市场列表里的开关 / 卸载 / 添加 / 卡片跳转。
    bindInto(container) {
      host = container;
      bind();
    },
    get bundles() { return bundles; },
    get entries() { return entries; }
  };
}