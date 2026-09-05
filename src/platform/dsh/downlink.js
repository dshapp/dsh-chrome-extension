// DSH 0.1.2 multiplexed downlink. Chrome cannot rewrite a WebSocket Origin,
// so extension pages keep using a same-origin hidden iframe as the carrier.
import { createReconnectBackoff } from "./reconnect-backoff.js";
import { ensureServerRunning } from "./native-supervisor.js";

const OPEN_TIMEOUT_MS = 8000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const STABLE_GENERATION_MS = 30000;

export const DshStreamState = Object.freeze({
  CONNECTING: "connecting", CONNECTED: "connected", DISCONNECTED: "disconnected"
});

function iframeCarrier(baseUrl, onOpen, onMessage, onClose) {
  const origin = new URL(baseUrl).origin;
  const iframe = document.createElement("iframe");
  iframe.src = origin + "/";
  iframe.hidden = true;
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "width:0;height:0;border:0;position:absolute;left:-9999px;";
  let opened = false;
  const handler = (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== origin) return;
    const data = event.data;
    if (data?.source !== "dsh-relay") return;
    if (data.type === "ready") iframe.contentWindow.postMessage({ source: "dsh-relay-parent", type: "connect" }, origin);
    else if (data.type === "open") { opened = true; onOpen(); }
    else if (data.type === "frame" && typeof data.envelope === "string") onMessage(data.envelope);
    else if (data.type === "close" || data.type === "error") { opened = false; onClose(); }
  };
  window.addEventListener("message", handler);
  document.documentElement.appendChild(iframe);
  return {
    send(text) {
      if (!opened) throw new Error("DSH mux is not open");
      iframe.contentWindow.postMessage({ source: "dsh-relay-parent", type: "frame", envelope: text }, origin);
    },
    stop() {
      window.removeEventListener("message", handler);
      try { iframe.contentWindow?.postMessage({ source: "dsh-relay-parent", type: "close" }, origin); } catch {}
      iframe.remove(); opened = false;
    }
  };
}

function directCarrier(baseUrl, onOpen, onMessage, onClose) {
  const socket = new WebSocket(baseUrl.replace(/^http/, "ws") + "/api/remote.mux");
  socket.onopen = onOpen;
  socket.onmessage = (event) => onMessage(event.data);
  socket.onclose = onClose;
  socket.onerror = () => {};
  return {
    send(text) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("DSH mux is not open");
      socket.send(text);
    },
    stop() { socket.onopen = null; socket.onclose = null; socket.close(); }
  };
}

export function exceedsUtf8ByteLimit(text, limit) {
  if (text.length > limit) return true;
  let bytes = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) continue;
    if (unit <= 0x7ff) bytes += 1;
    else if (unit >= 0xd800 && unit <= 0xdbff
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 2;
      index += 1;
    } else bytes += 2;
    if (bytes > limit) return true;
  }
  return false;
}

export function parseMuxFrame(text) {
  if (typeof text !== "string" || exceedsUtf8ByteLimit(text, MAX_FRAME_BYTES)) return undefined;
  let value;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || !["item", "error", "end"].includes(value.type) || typeof value.streamId !== "string") return undefined;
  return value;
}

export function createDownlink(options) {
  const { apiClient, onFrame, onStateChange, onGenerationReady } = options;
  const ensureServer = options.ensureServerRunning || ensureServerRunning;
  const recoverConnection = options.recoverConnection
    || (() => ensureServer("web", { backendUrl: apiClient.baseUrl }));
  const backoff = createReconnectBackoff(options.backoff || {});
  const now = options.now || Date.now;
  const stableGenerationMs = options.stableGenerationMs ?? STABLE_GENERATION_MS;
  const subscriptions = new Map();
  let openedIds = new Set();
  let generation = 0;
  let token = 0;
  let state = DshStreamState.DISCONNECTED;
  let stopped = true;
  let carrier = null;
  let reconnectTimer = null;
  let openTimer = null;
  let consecutiveFailures = 0;
  let openedAt = null;

  const setState = (next) => {
    if (state === next) return;
    state = next;
    onStateChange?.(state, generation);
  };
  const openFrame = (sub) => JSON.stringify({
    type: "open", streamId: sub.streamId, endpoint: sub.endpoint, payload: { args: sub.args ?? {} }
  });
  const sendSubscription = (sub) => {
    if (state !== DshStreamState.CONNECTED || openedIds.has(sub.streamId)) return;
    carrier.send(openFrame(sub));
    openedIds.add(sub.streamId);
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff.next());
  };
  const failGeneration = (expectedToken, { countFailure = false } = {}) => {
    if (stopped || expectedToken !== token) return;
    const wasStable = openedAt !== null && now() - openedAt >= stableGenerationMs;
    let recovery = null;
    if (wasStable) {
      backoff.reset();
      consecutiveFailures = 0;
    } else if (countFailure) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) {
        // WebSocket 握手拿不到 HTTP 401 响应体。连续短连接既可能是服务没起，
        // 也可能是 browser-session Cookie 已过期；恢复动作必须在下一次连接前完成。
        recovery = Promise.resolve(recoverConnection()).catch(() => {});
      }
    }
    openedAt = null;
    token += 1;
    clearTimeout(openTimer); openTimer = null;
    carrier?.stop(); carrier = null; openedIds = new Set();
    setState(DshStreamState.DISCONNECTED);
    if (recovery) recovery.finally(scheduleReconnect);
    else scheduleReconnect();
  };

  function connect() {
    if (stopped) return;
    const myToken = ++token;
    generation += 1;
    setState(DshStreamState.CONNECTING);
    const onOpen = () => {
      if (myToken !== token) return;
      clearTimeout(openTimer); openTimer = null;
      openedIds = new Set();
      // 握手成功不等于这一代健康。服务端接受后立刻断开时若在这里清零，
      // 连续失败永远只能数到 1，native supervisor 也就永远不会被唤起。
      openedAt = now();
      setState(DshStreamState.CONNECTED);
      for (const sub of subscriptions.values()) sendSubscription(sub);
      onGenerationReady?.(null, generation);
    };
    const onMessage = (text) => {
      if (myToken !== token) return;
      const frame = parseMuxFrame(text);
      if (!frame) {
        if (typeof text === "string" && exceedsUtf8ByteLimit(text, MAX_FRAME_BYTES)) failGeneration(myToken);
        return;
      }
      onFrame(frame, "mux");
    };
    const onClose = () => {
      if (myToken !== token) return;
      failGeneration(myToken, { countFailure: true });
    };
    const isExtension = typeof location !== "undefined" && location.protocol === "chrome-extension:";
    carrier = typeof document !== "undefined" && document.createElement && isExtension
      ? iframeCarrier(apiClient.baseUrl, onOpen, onMessage, onClose)
      : directCarrier(apiClient.baseUrl, onOpen, onMessage, onClose);
    openTimer = setTimeout(() => failGeneration(myToken, { countFailure: true }), OPEN_TIMEOUT_MS);
  }

  return Object.freeze({
    subscribe(streamId, endpoint, args = {}) {
      const sub = { streamId, endpoint, args };
      const previous = subscriptions.get(streamId);
      subscriptions.set(streamId, sub);
      const changed = previous && (previous.endpoint !== endpoint
        || JSON.stringify(previous.args ?? {}) !== JSON.stringify(args ?? {}));
      if (changed && state === DshStreamState.CONNECTED && openedIds.delete(streamId)) {
        carrier.send(JSON.stringify({ type: "cancel", streamId }));
      }
      sendSubscription(sub);
    },
    unsubscribe(streamId) {
      subscriptions.delete(streamId);
      if (state === DshStreamState.CONNECTED && openedIds.delete(streamId)) {
        carrier.send(JSON.stringify({ type: "cancel", streamId }));
      }
    },
    start() { if (stopped) { stopped = false; connect(); } },
    stop() {
      stopped = true; token += 1;
      clearTimeout(openTimer); clearTimeout(reconnectTimer);
      openTimer = reconnectTimer = null;
      carrier?.stop(); carrier = null; openedIds = new Set();
      setState(DshStreamState.DISCONNECTED);
    },
    restart() { this.stop(); backoff.reset(); stopped = false; connect(); },
    forceReconnect() { failGeneration(token); },
    get state() { return state; },
    get generation() { return generation; }
  });
}

export const MUX_MAX_FRAME_BYTES = MAX_FRAME_BYTES;
export const MUX_STABLE_GENERATION_MS = STABLE_GENERATION_MS;
