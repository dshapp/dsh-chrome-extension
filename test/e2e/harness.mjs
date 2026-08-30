// 真实后端 E2E 探针。不 mock 任何东西:开真会话、开真下行 WS、跑真 turn。
// 用途:验证重写后的 store/渲染/交互在**真实 wire 数据**下与 Mac 语义一致。
import { WebSocket } from "ws";

const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:3080";
const ORIGIN = BASE;

export async function rpc(method, payload = {}) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ type: "client-request", rpcId: `e2e-${Math.random()}`, method, payload })
  });
  const env = await res.json();
  if (env.type !== "server-response") throw new Error("bad envelope");
  if (!env.result.ok) {
    const err = new Error(`${env.result.error.code}: ${env.result.error.message}`);
    err.code = env.result.error.code;
    throw err;
  }
  return env.result.value;
}

export async function respond(rpcId, result) {
  const res = await fetch(`${BASE}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ type: "client-response", rpcId, result })
  });
  return res.json();
}

/// 打开 mux + host 两条下行流,把帧派发给订阅者。
export function openDownlink(onFrame) {
  const sockets = [];
  const ready = [];
  for (const stream of ["mux", "host"]) {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/events.${stream}`, { origin: ORIGIN });
    sockets.push(ws);
    ready.push(new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }));
    ws.on("message", (raw) => {
      let env;
      try { env = JSON.parse(raw.toString()); } catch { return; }
      if (env?.type !== "server-request") return;
      onFrame({ rpcId: env.rpcId, method: env.method, payload: env.payload }, stream);
    });
  }
  return {
    ready: Promise.all(ready),
    close() { for (const ws of sockets) { ws.removeAllListeners(); ws.close(); } }
  };
}

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
