// DSH 0.1.2 真实后端 E2E 传输：browser-session Cookie、slash RPC 信封、
// 单条 remote.mux 与逻辑流 open/cancel。刻意与扩展生产传输保持同一协议。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket } from "ws";

const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:3080";
const ORIGIN = new URL(BASE).origin;
const HOST_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../native-host/dsh-native-host.js");
let cookiePromise = null;
let rpcCounter = 0;
let activeMux = null;
const subscriptions = new Map();

function invokeNativeHost(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`native host exited ${code}: ${stderr}`));
      const output = Buffer.concat(chunks);
      if (output.length < 4) return reject(new Error("native host returned no framed response"));
      const length = output.readUInt32LE(0);
      resolve(JSON.parse(output.subarray(4, 4 + length).toString("utf8")));
    });
    child.stdin.end(Buffer.concat([header, body]));
  });
}

async function browserCookie() {
  if (!cookiePromise) cookiePromise = invokeNativeHost({
    cmd: "cookie", host: new URL(BASE).hostname, port: Number(new URL(BASE).port)
  }).then((signed) => {
    if (!signed?.ok) throw new Error(signed?.reason || "browser-session signing failed");
    return `${signed.name}=${signed.value}`;
  }).catch((error) => { cookiePromise = null; throw error; });
  return cookiePromise;
}

export async function rpc(method, args = {}) {
  const rpcId = `e2e-${Date.now().toString(36)}-${++rpcCounter}`;
  const request = async () => fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: await browserCookie() },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } })
  });
  let res = await request();
  if (res.status === 401) {
    cookiePromise = null;
    res = await request();
  }
  if (!res.ok) throw new Error(`DSH HTTP ${res.status} /api/${method}`);
  const env = await res.json();
  if (env.type !== "server-response" || env.rpcId !== rpcId) throw new Error("bad response envelope");
  if (!env.result?.ok) {
    const err = new Error(`${env.result?.error?.code ?? "unknown"}: ${env.result?.error?.message ?? "RPC failed"}`);
    err.code = env.result?.error?.code;
    throw err;
  }
  return env.result.value;
}

export async function settleRemoteEvent(clientId, eventId, outcome) {
  try {
    await rpc("$events/result", { clientId, eventId, outcome });
    return true;
  } catch (error) {
    if (String(error.code ?? "").endsWith("bad-request")) throw error;
    return false;
  }
}

function sendSubscription(sub) {
  if (activeMux?.readyState !== WebSocket.OPEN) return;
  activeMux.send(JSON.stringify({
    type: "open", streamId: sub.streamId, endpoint: sub.endpoint,
    payload: { args: sub.args ?? {} }
  }));
}

export function subscribe(streamId, endpoint, args = {}) {
  const previous = subscriptions.get(streamId);
  subscriptions.set(streamId, { streamId, endpoint, args });
  if (previous && activeMux?.readyState === WebSocket.OPEN) {
    activeMux.send(JSON.stringify({ type: "cancel", streamId }));
  }
  sendSubscription(subscriptions.get(streamId));
}

export function unsubscribe(streamId) {
  subscriptions.delete(streamId);
  if (activeMux?.readyState === WebSocket.OPEN) {
    activeMux.send(JSON.stringify({ type: "cancel", streamId }));
  }
}

/// 打开一条 0.1.2 mux；session service 会通过 subscribe() 注册逻辑流。
export function openDownlink(onFrame) {
  let socket = null;
  const ready = (async () => {
    const cookie = await browserCookie();
    socket = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/remote.mux`, {
      origin: ORIGIN, headers: { Cookie: cookie }
    });
    activeMux = socket;
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame && ["item", "error", "end"].includes(frame.type)) onFrame(frame, "mux");
    });
    // 先挂 message 再 open 逻辑流；本地服务可能在 send() 后同一事件循环就回 baseline。
    for (const sub of subscriptions.values()) sendSubscription(sub);
  })();
  return {
    ready,
    close() {
      if (activeMux === socket) activeMux = null;
      socket?.removeAllListeners();
      socket?.close();
      subscriptions.clear();
    }
  };
}

export const connection = Object.freeze({ call: rpc, settleRemoteEvent, subscribe, unsubscribe });

/// 等待条件成立,超时抛错并带上诊断。
export async function waitFor(label, predicate, { timeoutMs = 60000, interval = 100, diagnose } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      const extra = diagnose ? `\n诊断: ${JSON.stringify(await diagnose()).slice(0, 800)}` : "";
      throw new Error(`超时等待: ${label}${extra}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
