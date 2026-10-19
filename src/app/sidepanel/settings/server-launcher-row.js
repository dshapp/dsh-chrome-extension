// 服务端页的「本地启动器」一段。
//
// 从 server-pane.js 拆出来的原因很实际:那个文件原本已经 366 行,加上这一段
// 会越过 400 行的硬上限。拆分线选在这里,是因为这一段有**自己的状态** ——
// 测试启动的进行中与失败就地显示,和上面那些只读事实行不是一类东西。
//
// 这一行回答的是"这台机器上有没有那个 native host,以及它现在能不能把 dsh
// 拉起来"。状态取自 probeHost(cmd:"status")——它只读,不拉起任何进程;真正的
// 拉起动作用户按「测试启动」触发,且带 force 越过 30s 冷却(用户是明确要求
// "现在就试一次",被冷却挡住会看起来像坏了)。
//
// host 没装时不给「测试启动」:点了只会得到 host-missing,而那句是"没装",
// 不是"失败"。改给「安装引导」,打开与侧栏引导同一份内容的欢迎页。
import { t } from "../../../shared/i18n.js";
import { section, row, button, statusLine, escapeHtml } from "./settings-ui.js";
import { ensureServerRunning } from "../../../platform/dsh/native-supervisor.js";
import { NativeHostIssue } from "../../../platform/dsh/native-host-error.js";

const SETUP_ISSUES = new Set(Object.values(NativeHostIssue));

/// 没装好时给一个去处:在新标签页打开欢迎/安装引导页(与侧栏引导同一份内容)。
function openSetupGuide() {
  const runtime = globalThis.chrome?.runtime;
  const url = runtime?.getURL?.("pages/welcome/index.html");
  if (url && globalThis.chrome?.tabs?.create) void globalThis.chrome.tabs.create({ url });
}

/// 宿主失败原因 → 人话。已归类的(没装/没授权/起不来)走引导文案,其余照原文。
function reasonText(reason) {
  if (SETUP_ISSUES.has(reason)) return t("setup.toast." + reason);
  return reason ? String(reason) : t("srv.openFailed");
}

export function createServerLauncherRow({ showToast, formatErrorDetails, onChange }) {
  let status = null;
  let busy = false;
  let error = null;

  function render() {
    if (!status) return "";
    const installed = status.ok === true;
    const control = statusLine(
      installed ? t("srv.launcherInstalled") : t("srv.launcherMissing"),
      installed ? "ok" : "err"
    ) + (installed
      ? button({
        id: "srv-launcher-test",
        label: busy ? t("srv.dshRestarting") : t("srv.launcherTest"),
        kind: "plain",
        disabled: busy
      })
      : button({ id: "srv-launcher-guide", label: t("setup.openGuide"), kind: "plain" }));
    return section({
      header: t("srv.launcher"),
      body: row({
        label: escapeHtml(t("srv.launcherState")),
        hint: error
          ? '<span class="set-danger">' + escapeHtml(error) + '</span>'
          : escapeHtml(t("srv.launcherHint")),
        control
      })
    });
  }

  function bind(host) {
    host.querySelector("#srv-launcher-test")?.addEventListener("click", () => test());
    host.querySelector("#srv-launcher-guide")?.addEventListener("click", () => openSetupGuide());
  }

  /// 测试启动:拉起 dsh web,结果就地显示(成功/已在运行/失败)。
  async function test() {
    if (busy) return;
    busy = true;
    error = null;
    onChange();
    try {
      const result = await ensureServerRunning("web", { force: true });
      if (result?.ok) {
        showToast?.(result.alreadyUp ? t("srv.launcherAlreadyUp") : t("srv.launcherStarted"));
      } else {
        error = reasonText(result?.reason);
        showToast?.(error);
      }
    } catch (failure) {
      error = formatErrorDetails?.(failure) ?? String(failure);
      showToast?.(error);
    } finally {
      busy = false;
      onChange();
    }
  }

  return {
    render,
    bind,
    setStatus(next) { status = next; }
  };
}
