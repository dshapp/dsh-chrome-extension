// DSH 下行连接:两条只读流(mux + host)。浏览器扩展环境下 WebSocket 的 Origin 头
// (chrome-extension://)无法被 declarativeNetRequest 移除(Chromium 保留 WS 握心头),
// 而 DSH 围栏要求 Origin === Host。因此下行流通过「隐藏 iframe 加载后端同源页 +
// content script(dsh-relay.js)内开 WS + postMessage 中继」实现。
// 非 DOM 环境(测试)退回直连 WebSocket。
// 断线 = 整代重开(新 generation),重连成功后由调用方用 session.history 重拉收敛。
import { createReconnectBackoff } from "./reconnect-backoff.js";
import { ensureServerRunning } from "./native-supervisor.js";

const STREAMS = ["mux", "host"];
const STREAM_OPEN_TIMEOUT_MS = 8000;

export const DshStreamState = Object.freeze({
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected"
});

// ---- iframe 中继载体 ----
function createIframeCarrier(baseUrl, onFrame, onStreamDown) {
  // 后端同源 origin:iframe 加载 ${baseUrl}/ 后其页面 origin 就是它,
  // 中继帧必须来自这个 origin,否则任意页面都能伪装成中继向扩展注入帧。
  const iframeOrigin = new URL(baseUrl).origin;
  const iframe = document.createElement("iframe");
  iframe.src = `${baseUrl}/`;
  iframe.hidden = true;
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "width:0;height:0;border:0;position:absolute;left:-9999px;";
  const openedStreams = new Set();
  let ready = false;

  const messageHandler = (event) => {
    if (event.source !== iframe.contentWindow) return;
    // 中继帧只能来自后端同源页(iframe 自己),拒绝其余 origin 的伪造消息。
    if (event.origin !== iframeOrigin) return;
    const data = event.data;
    if (data?.source !== "dsh-relay") return;
    if (data.type === "ready") {
      ready = true;
      for (const stream of STREAMS) iframe.contentWindow.postMessage({ source: "dsh-relay-parent", type: "open", stream }, iframeOrigin);
      return;
    }
    if (data.type === "open") openedStreams.add(data.stream);
    if (data.type === "close") {
      openedStreams.delete(data.stream);
      onStreamDown(data.stream);
    }
    if (data.type === "frame" && typeof data.envelope === "string") {
      onFrame(data.envelope, data.stream);
    }
  };
  window.addEventListener("message", messageHandler);
  document.documentElement.appendChild(iframe);

  return {
    async opened(timeoutMs = STREAM_OPEN_TIMEOUT_MS) {
      const start = Date.now();
      while (openedStreams.size < STREAMS.length) {
        if (Date.now() - start > timeoutMs) throw new Error(`下行流中继打开超时(${[...openedStreams].join("+")})`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    stop() {
      window.removeEventListener("message", messageHandler);
      try {
        iframe.contentWindow?.postMessage({ source: "dsh-relay-parent", type: "close", stream: "mux" }, iframeOrigin);
        iframe.contentWindow?.postMessage({ source: "dsh-relay-parent", type: "close", stream: "host" }, iframeOrigin);
      } catch { /* noop */ }
      iframe.remove();
    },
    get openCount() { return openedStreams.size; }
  };
}

// ---- 直连载体(测试/非扩展环境) ----
function createDirectCarrier(baseUrl, onFrame, onStreamDown) {
  const sockets = new Map();
  // 真正完成握手(OPEN)的流。sockets.size 在 new WebSocket 时就已经 +1,
  // 用它判就绪会在握手尚未完成时误判连接成功,导致后续读取读到一个未就绪的流。
  const openedStreams = new Set();
  const openSocket = (stream) => {
    const url = baseUrl.replace(/^http/, "ws") + `/api/events.${stream}`;
    const socket = new WebSocket(url);
    sockets.set(stream, socket);
    socket.onopen = () => openedStreams.add(stream);
    socket.onmessage = (event) => onFrame(event.data, stream);
    socket.onclose = () => {
      sockets.delete(stream);
      openedStreams.delete(stream);
      onStreamDown(stream);
    };
  };
  for (const stream of STREAMS) openSocket(stream);
  return {
    async opened(timeoutMs = STREAM_OPEN_TIMEOUT_MS) {
      const start = Date.now();
      while (openedStreams.size < STREAMS.length) {
        if (Date.now() - start > timeoutMs) throw new Error("下行流直连打开超时");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    stop() {
      for (const socket of sockets.values()) { socket.onopen = null; socket.onclose = null; socket.close(); }
      sockets.clear();
      openedStreams.clear();
    },
    get openCount() { return openedStreams.size; }
  };
}

function parseDownlinkFrame(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (envelope?.type !== "server-request") return undefined;
  const method = envelope.method;
  const payload = envelope.payload;
  if (typeof method !== "string" || payload?.type !== method) return undefined;
  return { rpcId: envelope.rpcId, method, payload };
}

export function createDownlink(options) {
  const { apiClient, onFrame, onStateChange, onGenerationReady } = options;
  const backoff = createReconnectBackoff(options.backoff || {});
  let generation = 0;
  let generationToken = 0;
  let state = DshStreamState.DISCONNECTED;
  let stopped = true;
  let carrier = null;
  let connectTimer = null;
  // 每代 connect 失败的连续次数。达到阈值后请 native host 拉起 dsh web;
  // 一次抖动不该立刻触发拉起,所以留出一个容忍窗口。
  let consecutiveFailures = 0;

  function setState(next) {
    if (state === next) return;
    state = next;
    onStateChange?.(state, generation);
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = backoff.next();
    connectTimer = setTimeout(() => connect(), delay);
  }

  function handleEnvelope(text, stream) {
    try {
      const frame = parseDownlinkFrame(text);
      if (frame) onFrame(frame, stream);
    } catch (error) {
      console.error("[dsh-downlink] 丢弃无法解析的帧", error);
    }
  }

  async function connect() {
    if (stopped) return;
    const token = ++generationToken;
    generation += 1;
    setState(DshStreamState.CONNECTING);
    try {
      const onStreamDown = () => { if (token === generationToken) teardown(); };
      // 浏览器扩展页面用 iframe 中继;非扩展环境(Node 测试、dev web 模式)退回直连。
      // dev web 模式下 Origin 与 Host 同源(经 dev server 代理),无需绕围栏。
      const isExtension = typeof location !== "undefined" && location.protocol === "chrome-extension:";
      carrier = typeof document !== "undefined" && document.createElement && isExtension
        ? createIframeCarrier(apiClient.baseUrl, handleEnvelope, onStreamDown)
        : createDirectCarrier(apiClient.baseUrl, handleEnvelope, onStreamDown);
      await carrier.opened();
      if (token !== generationToken) return;
      const description = await apiClient.call("host.describe", {});
      if (token !== generationToken) return;
      backoff.reset();
      consecutiveFailures = 0;
      setState(DshStreamState.CONNECTED);
      onGenerationReady?.(description, generation);
    } catch (error) {
      if (token === generationToken) {
        consecutiveFailures += 1;
        teardown();
        // 连续失败大概率是 dsh web 没启动,而非瞬时网络抖动。达到阈值后
        // 请 native host 把它拉起来;supervisor 自带 30s 冷却,故每个 tick
        // 调一次是安全的。native messaging 不可用时此处立即返回,无副作用。
        if (consecutiveFailures >= 2) {
          ensureServerRunning("web", { backendUrl: apiClient.baseUrl }).catch(() => {});
        }
      }
      console.warn("[dsh-downlink] 连接失败,稍后重试", error.message);
    }
  }

  function teardown() {
    generationToken += 1;
    carrier?.stop();
    carrier = null;
    setState(DshStreamState.DISCONNECTED);
    scheduleReconnect();
  }

  return Object.freeze({
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
      generationToken += 1;
      carrier?.stop();
      carrier = null;
      setState(DshStreamState.DISCONNECTED);
    },
    restart() {
      this.stop();
      stopped = false;
      connect();
    },
    // 应用层请求重建连接(stream/error 帧触发)。与 restart 不同:走 teardown 的
    // 指数退避阶梯,而不是立即 connect,这样突发错误帧只会调度一次重连。
    forceReconnect() {
      teardown();
    },
    get state() {
      return state;
    },
    get generation() {
      return generation;
    }
  });
}

export { parseDownlinkFrame };
