// Bridge 状态与开关(设置页区块)。
// 桥的真实状态只在 service worker 里(WebSocket 连接 + chrome.storage),
// 侧栏通过 runtime 消息读写 —— 与 background.js 的 get_state/set_enabled 协议对接。
import { t } from "../../shared/i18n.js";

const POLL_INTERVAL_MS = 1000;

// 桥半部可能整体缺席(例如把侧栏单独跑在普通页面里做调试),此时隐藏整个区块
// 而不是抛错。
function canReachWorker() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

async function requestState() {
  try {
    return await chrome.runtime.sendMessage({ type: "get_state" });
  } catch {
    return null;
  }
}

export function mountBridgeSettings(root = document) {
  const section = root.querySelector("#set-bridge-section");
  // 三态配色现在由包住圆点与文字的 .set-status 承载(圆点是它的 ::before 式 <i>),
  // 这样文字与点同时变色 —— 与设置页其它状态行(提供方密钥、连接态)一致。
  const state = root.querySelector("#set-bridge-state");
  const label = root.querySelector("#set-bridge-status");
  const detail = root.querySelector("#set-bridge-detail");
  const toggle = root.querySelector("#set-bridge-enabled");
  if (!section) return { refresh() {}, stop() {} };

  if (!canReachWorker()) {
    section.hidden = true;
    return { refresh() {}, stop() {} };
  }

  let timer = null;

  function paint(bridgeState) {
    const connected = Boolean(bridgeState?.connected);
    const allowed = bridgeState?.shouldConnect !== false;
    const kind = connected ? "ok" : allowed ? "busy" : "err";
    if (state) state.className = `set-status ${kind}`;
    label.textContent = connected ? t("bridge.connected") : t("bridge.disconnected");
    toggle.checked = allowed;
    detail.textContent = connected
      ? t("bridge.daemonAt", { url: bridgeState.url })
      : allowed
        ? t("bridge.waiting")
        : t("bridge.off");
  }

  async function refresh() {
    paint(await requestState());
  }

  toggle.addEventListener("change", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "set_enabled", enabled: toggle.checked });
    } catch {
      // worker 不可达:下一次轮询会把 UI 收敛回真实状态。
    }
    refresh();
  });

  return {
    // 只在设置页可见时轮询,避免侧栏常驻时每秒唤醒 service worker。
    refresh() {
      refresh();
      if (!timer) timer = setInterval(refresh, POLL_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
