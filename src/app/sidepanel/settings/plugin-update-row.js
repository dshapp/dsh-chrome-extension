// 浏览器页与移动端访问页顶上的「插件有新版」一行(状态见 features/settings/plugin-update.js)。
// 没有新版时整段不画 —— 一直挂着一行"已是最新"只是噪音。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import { section, row, button, tag, statusLine, escapeHtml } from "./settings-ui.js";

/// @param update   createPluginUpdate 的返回值。
/// @param name     插件包名(行标题)。
/// @param buttonId 「更新」按钮的 id,调用方据此绑定。
export function pluginUpdateSection(update, { name, buttonId }) {
  if (!update.visible) return "";
  const state = update.state;
  const title = '<span class="set-row-title">' + escapeHtml(name) + "</span>";
  if (state.updated && !state.updating && !update.available) {
    const restart = state.restartRequired;
    return section({
      body: row({
        label: title,
        hint: escapeHtml(t(restart ? "plugUpd.restartRequired" : "plugUpd.updatedTo", { version: state.updated })),
        control: statusLine(t(restart ? "plugUpd.restartNeeded" : "plugUpd.updated"), restart ? "warn" : "ok")
      })
    });
  }
  const versions = state.installed && state.latest
    ? escapeHtml(t("plugUpd.versions", { current: state.installed, latest: state.latest }))
    : "";
  const note = (kind, text) => '<div class="set-row-note ' + kind + '">' + lucideIconSvg("triangle-alert", { size: 12 })
    + "<span>" + escapeHtml(text) + "</span></div>";
  const error = state.error ? note("err", state.error)
    : state.restartFailed ? note("err", t("plugUpd.restartFailed"))
    : state.restartFirst ? note("warn", t("plugUpd.restartFirst"))
    : "";
  return section({
    body: row({
      label: title + tag(t("plug.updateAvailable"), "accent"),
      hint: versions + error,
      control: state.updating
        ? statusLine(t("plug.updating"), "busy")
        : button({ id: buttonId, label: t(state.restartFirst ? "plugUpd.restartAndUpdate" : "plug.update"), kind: "primary" })
    })
  });
}
