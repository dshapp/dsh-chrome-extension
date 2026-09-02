// 插件清单里的「装 / 更 / 删」控件。
//
// 从 plugins-pane.js 拆出来的原因很实际:那个文件原本已经 368 行,加上这套控件
// 会越过 400 行的硬上限。拆分线选在这里,是因为这三个动作与清单的**只读**渲染
// 关注点不同 —— 它们经 chrome-daemon 执行(要跑 pnpm),而清单本身来自 dsh web。
//
// 本模块只管「画按钮 + 跑动作」,不持有清单数据:状态由调用方(plugins-pane)
// 保管并在每次 render 时传入,避免同一份数据出现两个副本。
import { t } from "../../../shared/i18n.js";
import { section, row, button, textInput, escapeHtml } from "./settings-ui.js";

/// 一个清单条目对应的 npm 包名,没有则返回 null。
///
/// 只有"看得出包名"的条目才给按钮:内置层(`cordis:include` 这类带冒号的
/// 模块名)不是 profile 的依赖,`pnpm remove` 它们只会失败 —— 给一个注定失败的
/// 按钮比不给更糟。
export function packageNameOf(entry) {
  const raw = String(entry?.moduleName ?? "");
  if (!raw || raw.includes(":")) return null;
  return raw;
}

/// 创建控件组。`state` 是 plugins-pane 里那份唯一的状态对象。
export function createPluginActionsUi({ host, pluginActions, showToast, state, render }) {
  /// 探一次代理是否可用。
  ///
  /// 清单与代理是两条独立链路(前者走 dsh web,后者走 daemon),所以代理不可用
  /// 时只收回这几个按钮,清单照常显示。
  async function probe() {
    if (!pluginActions) {
      state.actionsAvailable = false;
      return;
    }
    try {
      await pluginActions.list();
      state.actionsAvailable = true;
    } catch {
      state.actionsAvailable = false;
    }
  }

  /// 展开的条目里那一行操作按钮。
  function renderRowActions(entry) {
    if (!state.actionsAvailable) return "";
    const name = packageNameOf(entry);
    if (!name) return "";
    const busy = state.actionBusy === name;
    return row({
      label: escapeHtml(t("plug.manage")),
      hint: escapeHtml(name),
      control: button({ id: `plug-update-${name}`, label: t("plug.update"), kind: "plain", disabled: busy })
        + button({ id: `plug-remove-${name}`, label: t("plug.removeAction"), kind: "danger", disabled: busy })
    });
  }

  /// 清单顶部的安装输入行。
  function renderInstallRow() {
    if (!state.actionsAvailable) return "";
    return section({
      header: t("plug.installTitle"),
      body: row({
        label: escapeHtml(t("plug.installLabel")),
        hint: escapeHtml(t("plug.installHint")),
        control: textInput({ id: "plug-install-name", value: state.installName, placeholder: "@scope/package" })
          + button({
              id: "plug-install",
              label: t("plug.install"),
              kind: "primary",
              disabled: Boolean(state.actionBusy) || !state.installName.trim()
            })
      })
    });
  }

  /// 跑一个变更动作。
  ///
  /// pnpm 装包可能要几十秒,期间必须让用户看到"在做事",否则会重复点击 ——
  /// 所以先置 actionBusy 再重画,并给一条进行中的提示。
  async function runAction(name, progressText, run) {
    if (state.actionBusy) return;
    state.actionBusy = name;
    render();
    showToast?.(progressText);
    try {
      await run();
      state.installName = "";
      showToast?.(t("plug.actionDone"));
    } catch (error) {
      // 代理整体不可用时收回控件,而不是让用户反复点到同一个错误。
      if (error?.isUnsupported) state.actionsAvailable = false;
      showToast?.(error?.message || String(error));
    } finally {
      state.actionBusy = null;
      render();
    }
  }

  function bind(inventory) {
    if (!state.actionsAvailable) return;
    const input = host.querySelector("#plug-install-name");
    input?.addEventListener("input", (event) => {
      state.installName = event.target.value;
      // 只切换按钮可用态,不重画 —— 重画会让正在输入的框失焦。
      const install = host.querySelector("#plug-install");
      if (install) install.disabled = Boolean(state.actionBusy) || !state.installName.trim();
    });
    host.querySelector("#plug-install")?.addEventListener("click", () => {
      const name = state.installName.trim();
      if (name) runAction(name, t("plug.installing"), () => pluginActions.install(name));
    });
    for (const entry of inventory) {
      const name = packageNameOf(entry);
      if (!name) continue;
      host.querySelector(`#plug-update-${CSS.escape(name)}`)?.addEventListener("click", () =>
        runAction(name, t("plug.updating"), () => pluginActions.update(name))
      );
      host.querySelector(`#plug-remove-${CSS.escape(name)}`)?.addEventListener("click", () =>
        runAction(name, t("plug.removing"), () => pluginActions.remove(name))
      );
    }
  }

  return { probe, renderRowActions, renderInstallRow, bind };
}
