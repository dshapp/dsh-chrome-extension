// 服务端页的「本地启动器」一段:只展示启动器的注册状态。
//
// 这一行回答的是"这台机器上有没有注册好那个 native host"。状态取自
// probeHost(cmd:"status")—— 它只读,不拉起任何进程。
//
// 曾经有一个「测试启动」按钮(带 force 越过冷却去拉起 dsh web)。去掉了:
// dsh web 没在跑时后台会自己拉起(sw/server-supervisor.js),要换一个新服务
// 用下方的「重启服务」,这里再放一个"启动"只是同一件事的第三个入口。
//
// host 没装时给「安装引导」:那是没装好时唯一的去处,打开与侧栏引导同一份内容的欢迎页。
import { t } from "../../../shared/i18n.js";
import { section, row, button, statusLine, escapeHtml } from "./settings-ui.js";

/// 没装好时给一个去处:在新标签页打开欢迎/安装引导页(与侧栏引导同一份内容)。
function openSetupGuide() {
  const runtime = globalThis.chrome?.runtime;
  const url = runtime?.getURL?.("pages/welcome/index.html");
  if (url && globalThis.chrome?.tabs?.create) void globalThis.chrome.tabs.create({ url });
}

export function createServerLauncherRow() {
  let status = null;

  function render() {
    if (!status) return "";
    const installed = status.ok === true;
    const control = statusLine(
      installed ? t("srv.launcherInstalled") : t("srv.launcherMissing"),
      installed ? "ok" : "err"
    ) + (installed ? "" : button({ id: "srv-launcher-guide", label: t("setup.openGuide"), kind: "plain" }));
    return section({
      header: t("srv.launcher"),
      body: row({
        label: escapeHtml(t("srv.launcherState")),
        hint: escapeHtml(t("srv.launcherHint")),
        control
      })
    });
  }

  function bind(host) {
    host.querySelector("#srv-launcher-guide")?.addEventListener("click", () => openSetupGuide());
  }

  return {
    render,
    bind,
    setStatus(next) { status = next; }
  };
}
