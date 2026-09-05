// Same-origin WebSocket carrier for DSH 0.1.2. The extension parent may send
// mux open/cancel frames; server frames are relayed back unchanged.
(() => {
  if (window.top === window) return;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const parentOK = (origin) => origin === extensionOrigin;
  let socket = null;
  const send = (payload) => window.parent.postMessage({ source: "dsh-relay", ...payload }, "*");
  const connect = () => {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/remote.mux`);
    socket.onopen = () => send({ type: "open" });
    socket.onclose = () => { socket = null; send({ type: "close" }); };
    socket.onerror = () => send({ type: "error" });
    socket.onmessage = (event) => send({ type: "frame", envelope: event.data });
  };
  window.addEventListener("message", (event) => {
    if (!parentOK(event.origin) || event.source !== window.parent) return;
    const data = event.data;
    if (data?.source !== "dsh-relay-parent") return;
    if (data.type === "connect") connect();
    else if (data.type === "frame" && socket?.readyState === WebSocket.OPEN && typeof data.envelope === "string") socket.send(data.envelope);
    else if (data.type === "close") { socket?.close(); socket = null; }
  });
  send({ type: "ready" });
})();
