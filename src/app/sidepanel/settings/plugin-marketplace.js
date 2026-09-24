// 插件市场。对齐 Mac PluginsPage(Components/Plugins/PluginsPage.swift):
// 「官方」与「已安装」两个分组 + 行内启停 + 添加插件 + 卸载确认。
//
// 分组口径按 Mac:
//   official  = 安装随附的 bundle(optional=true)以及**可在本页配置**的官方卡片;
//   installed = 其余已经装上的 bundle。
// bundle 行显示 name + vX.Y.Z + 描述;有 readOnlyReason 时开关禁用并显示原因
// (management-required 这类 bundle 由安装本身管,启停它只会失败)。
import { t } from "../../../shared/i18n.js";
import {
  section, row, button, iconButton, toggle, tag, notice, spinner,
  escapeHtml, groupHeader, selectorEscape
} from "./settings-ui.js";
import { openPluginInstallSheet } from "./plugin-install-sheet.js";
import { bundleText } from "../../../features/settings/plugin-meta.js";

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

export function createMarketplaceView({
  host: initialHost, sheet, deps, settingsService, showToast, settingsDialog, cards,
  onOpenCard, onInstalled, onChange
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

  function bundleRow(bundle) {
    const isBusy = busy.has(bundle.name);
    const readOnlyReason = bundle.readOnlyReason;
    const version = bundle.version ? tag(t("plug.versionTag", { version: bundle.version }), "muted") : "";
    const result = notices.get(bundle.name);
    // 名称与说明取包自带的多语言 meta(0.1.7),按扩展当前语言回退;技术名留给 title 提示。
    const text = bundleText(bundle);
    return row({
      label: `<span title="${escapeHtml(bundle.name)}">${escapeHtml(text.title)}</span>` + version,
      hint: escapeHtml(text.description || t("plug.noDescription"))
        + (readOnlyReason
          ? `<div class="set-row-hint">${escapeHtml(readOnlyKey(readOnlyReason))}</div>`
          : "")
        + (result ? `<div class="set-row-hint">${escapeHtml(result)}</div>` : ""),
      control: toggle({
        id: `plug-bundle-${bundle.name}`,
        checked: bundle.enabled,
        disabled: Boolean(readOnlyReason) || isBusy,
        ariaLabel: t("plug.enableNamed", { name: text.title })
      }) + (bundle.removable && bundle.installed
        ? iconButton({
          id: `plug-bundle-del-${bundle.name}`,
          icon: "trash-2",
          title: t("plug.uninstall"),
          kind: "danger",
          disabled: isBusy
        })
        : ""),
      id: `plug-bundle-row-${bundle.name}`
    });
  }

  function readOnlyKey(reason) {
    return READ_ONLY_TEXT[reason] ? t(READ_ONLY_TEXT[reason]) : reason;
  }

  /// 可配置的官方卡片在这里以一行形式出现,点了进配置视图(Mac 的 configRow)。
  function cardRow(card) {
    return row({
      label: escapeHtml(t(card.title)),
      hint: escapeHtml(t(card.description)),
      control: iconButton({
        id: `plug-open-${card.id}`, icon: "chevron-right", title: t(card.title)
      }),
      id: `plug-card-row-${card.id}`,
      clickable: true
    });
  }

  function officialBundles() {
    return bundles.filter((bundle) => bundle.optional === true);
  }

  function installedBundles() {
    return bundles.filter((bundle) => bundle.optional !== true && bundle.installed);
  }

  function render() {
    if (loading) return spinner();
    if (loadError) {
      return section({
        body: notice(loadError)
          + `<div class="set-form-footer"><span class="set-spacer"></span>`
          + button({ id: "plug-market-retry", label: t("set.retry"), kind: "primary" })
          + `</div>`
      });
    }
    const official = officialBundles();
    const installed = installedBundles();
    const available = cardsOf();
    const officialCount = official.length + available.length;
    if (!officialCount && !installed.length) {
      return section({ body: `<div class="set-empty">${escapeHtml(t("plug.marketEmpty"))}</div>` });
    }
    const groups = [];
    if (officialCount) {
      groups.push(section({
        headerHtml: groupHeader(t("plug.official"), officialCount, "plug-count-official"),
        body: official.map(bundleRow).join("") + available.map(cardRow).join("")
      }));
    }
    if (installed.length) {
      groups.push(section({
        headerHtml: groupHeader(t("plug.installedGroup"), installed.length, "plug-count-installed"),
        body: installed.map(bundleRow).join("")
      }));
    }
    return groups.join("")
      + section({
        body: `<div class="set-row stacked"><div class="set-row-control wide">`
          + button({ id: "plug-add", label: `+ ${t("plug.addTitle")}`, kind: "primary" })
          + button({ id: "plug-refresh", label: t("plug.refresh") })
          + `</div></div>`,
        footer: escapeHtml(t("plug.marketIntro"))
      });
  }

  function bind() {
    host.querySelector("#plug-market-retry")?.addEventListener("click", () => refresh());
    host.querySelector("#plug-refresh")?.addEventListener("click", () => refresh());
    host.querySelector("#plug-add")?.addEventListener("click", () => {
      openPluginInstallSheet({
        sheet, settingsDialog, deps, settingsService, showToast,
        onInstalled: async (result) => {
          await refresh();
          onInstalled?.(result);
        }
      });
    });
    for (const card of cardsOf()) {
      host.querySelector(`#plug-card-row-${selectorEscape(card.id)}`)?.addEventListener("click", () => onOpenCard?.(card));
      host.querySelector(`#plug-open-${selectorEscape(card.id)}`)?.addEventListener("click", (event) => {
        event.stopPropagation();
        onOpenCard?.(card);
      });
    }
    for (const bundle of bundles) {
      host.querySelector(`#plug-bundle-${selectorEscape(bundle.name)}`)?.addEventListener("change", (event) => {
        setEnabled(bundle, event.target.checked);
      });
      host.querySelector(`#plug-bundle-del-${selectorEscape(bundle.name)}`)?.addEventListener("click", () => {
        confirmRemove(bundle);
      });
    }
  }

  async function setEnabled(bundle, enabled) {
    if (busy.has(bundle.name)) return;
    busy.add(bundle.name);
    notices.delete(bundle.name);
    renderHost();
    try {
      const result = await settingsService.setBundleEnabled(bundle.name, enabled);
      notices.set(bundle.name, applicationText(result));
      await refresh({ keepNotices: true });
    } catch (error) {
      // 失败时刷新会把开关拨回宿主的真实状态 —— 乐观留下的位置是假的。
      notices.set(bundle.name, deps.formatErrorDetails(error));
      showToast?.(deps.formatErrorDetails(error));
      await refresh({ keepNotices: true });
    } finally {
      busy.delete(bundle.name);
      renderHost();
    }
  }

  function applicationText(result) {
    if (!result) return "";
    if (result.error?.diagnostic) return result.error.diagnostic;
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
    if (onChange) onChange();
    else paint();
  }

  async function refresh({ keepNotices = false } = {}) {
    const generation = ++loadGeneration;
    loading = true;
    if (!keepNotices) notices.clear();
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
