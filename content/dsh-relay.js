// dsh-origin WS 中继:本脚本运行在 http(s)://127.0.0.1[:port]/(或配置后端域名)的页面/iframe 中。
// 在该同源上下文里开 WebSocket(DSH 围栏要求 Origin === Host,这里天然满足),
// 并通过 window.parent.postMessage 与扩展页面双向中继帧。
//
// 消息协议(postMessage, targetOrigin "*" 但校验 origin 白名单):
//   扩展页 → 本页: { source: "dsh-relay-parent", type: "open"|"close", stream: "mux"|"host" }
//                { source: "dsh-relay-parent", type: "frame", stream, envelope }  (仅诊断;WS 下行只读,无需上行)
//   本页 → 扩展页: { source: "dsh-relay", type: "open"|"close"|"error", stream }
//                { source: "dsh-relay", type: "frame", stream, envelope }
(() => {
  if (window.top === window) return; // 只作为 iframe 中继,顶层 dsh 页面不注入逻辑

  const PARENT_ORIGIN_OK = (origin) => origin?.startsWith("chrome-extension://");

  const sockets = new Set(["mux", "host"]);
  const connections = new Map();

  function sendToParent(payload) {
    window.parent.postMessage({ source: "dsh-relay", ...payload }, "*");
  }

  function openStream(stream) {
    if (connections.has(stream)) return;
    const socket = new WebSocket(`${location.origin}/api/events.${stream}`);
    connections.set(stream, socket);
    socket.onopen = () => sendToParent({ type: "open", stream });
    socket.onclose = () => { connections.delete(stream); sendToParent({ type: "close", stream }); };
    socket.onerror = () => sendToParent({ type: "error", stream, message: "ws error" });
    socket.onmessage = (event) => {
      // 下行只读流:原样转发信封文本。
      sendToParent({ type: "frame", stream, envelope: event.data });
    };
  }

  function closeStream(stream) {
    const socket = connections.get(stream);
    if (socket) {
      socket.onclose = null;
      socket.close();
      connections.delete(stream);
      sendToParent({ type: "close", stream });
    }
  }

  window.addEventListener("message", (event) => {
    if (!PARENT_ORIGIN_OK(event.origin)) return;
    const data = event.data;
    if (data?.source !== "dsh-relay-parent") return;
    if (data.type === "open" && sockets.has(data.stream)) openStream(data.stream);
    if (data.type === "close" && sockets.has(data.stream)) closeStream(data.stream);
  });

  // 父页面可能在 iframe load 前就 postMessage:重复广播就绪,父页面按需 open。
  sendToParent({ type: "ready" });
})();
