// 服务端 pane。Mac 的 ServerSettingsSection 讲的是"本次启动自带的本地服务"
// (进程、端口、日志),扩展没有自己的服务进程 —— 它连的是一个已经在跑的
// dsh web。所以这一页讲的是那条连接:后端地址、连接状态、宿主自报的信息,
// 外加一个本地启动器(Native Messaging host)状态行,用于在 dsh web 没起时
// 自启并显示其安装状态。
import { t } from "../../../shared/i18n.js";
import { section, row, stackedRow, textInput, button, statusLine, notice, escapeHtml } from "./settings-ui.js";
import { RPC } from "../../../platform/dsh/rpc-methods.js";
import { probeHost, ensureServerRunning } from "../../../platform/dsh/native-supervisor.js";

/// 每秒复查一次连接状态。与 header 状态点同频:重连是后台发生的,
/// 页面开着时状态必须自己走,而不是等用户切 tab 才更新。
const POLL_INTERVAL_MS = 1000;

/// 下行流三态 → 状态点配色与文案。三态是真实存在的:重连期间是"连接中"
/// (黄、脉冲),把它和"未连接"混为一谈会让正在恢复的连接看起来像挂了。
function connectionView(streamState, DshStreamState) {
  if (streamState === DshStreamState.CONNECTED) return { kind: "ok", text: t("srv.connected") };
  if (streamState === DshStreamState.CONNECTING) return { kind: "busy", text: t("srv.connecting") };
  return { kind: "err", text: t("srv.disconnected") };
}

export function createServerPane({ host, deps, showToast, onBackendChanged }) {
  let hostInfo = null;
  let hostError = null;
  let saveStatus = "";
  let draftUrl = null;
  let timer = null;
  let launcherProbed = false;

  function currentView() {
    return connectionView(deps.connection.streamState, deps.DshStreamState);
  }

  function connectionRow() {
    const view = currentView();
    return row({
      label: escapeHtml(t("srv.state")),
      control: `<span id="srv-state">${statusLine(view.text, view.kind)}</span>`
    });
  }

  /// 只改状态点那一小块,不重画整页 —— 每秒重写 innerHTML 会让输入框失焦、
  /// 也会把光标从后端地址里踢走。
  function paintConnection() {
    const slot = host.querySelector("#srv-state");
    if (!slot) return;
    const view = currentView();
    slot.innerHTML = statusLine(view.text, view.kind);
  }

  /// 宿主自报信息(host.describe)。字段随部署而异,所以按 key/value 平铺,
  /// 只挑标量渲染 —— 嵌套对象在设置行里读不出意义。
  function hostRows() {
    if (hostError) return notice(hostError);
    if (!hostInfo) return "";
    const entries = Object.entries(hostInfo)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value));
    if (!entries.length) return "";
    return entries.map(([key, value]) => row({
      label: escapeHtml(key),
      control: `<span class="set-mono">${escapeHtml(String(value))}</span>`
    })).join("");
  }

  /// 本地启动器状态行。native messaging 不可用(未装 host / 无权限)时
  /// probeHost 立即返回,不抛错,只显示"未安装"。
  function launcherSection() {
    return section({
      header: t("srv.launcher"),
      body: row({
        label: escapeHtml(t("srv.launcherState")),
        hint: escapeHtml(t("srv.launcherHint")),
        control: `<span id="srv-launcher-state">${statusLine(t("srv.launcherUnknown"), "busy")}</span>`
          + button({ id: "srv-launcher-test", label: t("srv.launcherTest"), kind: "plain" })
      })
    });
  }

  async function refreshLauncher() {
    const slot = host.querySelector("#srv-launcher-state");
    if (!slot) return;
    const result = await probeHost();
    if (result?.ok) {
      slot.innerHTML = statusLine(t("srv.launcherInstalled"), "ok");
    } else {
      const reason = result?.reason || "";
      slot.innerHTML = statusLine(t("srv.launcherMissing"), "err")
        + (reason ? ` <span class="set-mono">${escapeHtml(reason)}</span>` : "");
    }
  }

  function render() {
    const currentUrl = draftUrl ?? deps.connection.baseUrl ?? "";
    host.innerHTML = section({
      header: t("srv.title"),
      body: stackedRow({
        label: escapeHtml(t("srv.backendUrl")),
        hint: escapeHtml(t("srv.backendUrlHint")),
        control: `<div class="set-inline">`
          + textInput({ id: "srv-backend", value: currentUrl, placeholder: "http://127.0.0.1:3080" })
          + button({ id: "srv-backend-save", label: t("set.save"), kind: "primary" })
          + `</div>`
      })
      + connectionRow()
      + (saveStatus ? `<div class="set-ok">${escapeHtml(saveStatus)}</div>` : "")
    })
    + section({ header: t("srv.host"), body: hostRows() || `<div class="set-empty">${escapeHtml(t("srv.notConnected"))}</div>` })
    + launcherSection();
    bind();
    if (!launcherProbed) {
      launcherProbed = true;
      refreshLauncher();
    }
  }

  function bind() {
    const input = host.querySelector("#srv-backend");
    input?.addEventListener("input", (event) => { draftUrl = event.target.value; });
    host.querySelector("#srv-backend-save")?.addEventListener("click", async () => {
      try {
        await deps.connection.setBackendUrl(input.value);
        draftUrl = null;
        saveStatus = t("settings.saved");
        onBackendChanged?.();
        await refresh();
        setTimeout(() => { saveStatus = ""; }, 1500);
      } catch (error) {
        showToast?.(deps.formatErrorDetails(error));
      }
    });
    host.querySelector("#srv-launcher-test")?.addEventListener("click", async () => {
      const btn = host.querySelector("#srv-launcher-test");
      if (btn) btn.disabled = true;
      try {
        const result = await ensureServerRunning("web", { force: true });
        if (result?.ok) {
          showToast?.(result.alreadyUp ? t("srv.launcherAlreadyUp") : t("srv.launcherStarted"));
        } else {
          showToast?.(deps.formatErrorDetails({ message: result?.reason || "unknown" }));
        }
        await refreshLauncher();
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  async function refresh() {
    try {
      hostInfo = await deps.connection.call(RPC.hostDescribe, {});
      hostError = null;
    } catch (error) {
      hostInfo = null;
      hostError = deps.formatErrorDetails(error);
    }
    render();
    if (!timer) timer = setInterval(paintConnection, POLL_INTERVAL_MS);
  }

  return {
    refresh,
    /// 离开服务端页时停表:状态点不可见就不该继续跑。
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
