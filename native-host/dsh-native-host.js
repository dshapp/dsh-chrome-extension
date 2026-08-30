#!/usr/bin/env node
/* DSH Chrome Bridge — Native Messaging host.
 *
 * Receives one JSON message from the extension on stdin (Chrome Native
 * Messaging framing: 4-byte LE length + JSON), spawns the local DSH server
 * (dsh web) detached, probes the port until it answers, and writes one JSON
 * response back. The Chrome bridge endpoint (/chrome/ws) is served by dsh web
 * itself, so there is no separate daemon target anymore. The detached child survives
 * this host's exit because it is spawned detached and unref'd — Native
 * Messaging kills the host the moment the response is flushed, so the
 * server must not be its child in the lifecycle sense.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.dsh.chrome";

function resolveDsh() {
  const candidates = [
    process.env.DSH_BIN,
    "/opt/homebrew/bin/dsh",
    path.join(os.homedir(), ".cargo/bin/dsh"),
    path.join(os.homedir(), ".local/bin/dsh"),
    path.join(os.homedir(), ".local/share/pnpm/bin/dsh"),
    path.join(os.homedir(), ".local/share/pnpm/dsh"),
    "/usr/local/bin/dsh",
    "/usr/bin/dsh",
    "dsh",
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return "dsh";
}
function logDir() {
  const dir = path.join(os.homedir(), ".dsh-chrome", "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function readMessage() {
  return new Promise((resolve) => {
    let header = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let bodyLen = 0;
    let gotLen = false;
    const onData = (chunk) => {
      if (!gotLen) {
        header = Buffer.concat([header, chunk]);
        if (header.length >= 4) {
          bodyLen = header.readUInt32LE(0);
          const rest = header.subarray(4);
          header = Buffer.alloc(0);
          gotLen = true;
          if (rest.length) {
            body = Buffer.concat([body, rest]);
            if (body.length >= bodyLen) {
              process.stdin.removeListener("data", onData);
              resolve(JSON.parse(body.subarray(0, bodyLen).toString("utf8")));
            }
          }
        }
      } else {
        body = Buffer.concat([body, chunk]);
        if (body.length >= bodyLen) {
          process.stdin.removeListener("data", onData);
          resolve(JSON.parse(body.subarray(0, bodyLen).toString("utf8")));
        }
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", () => resolve(null));
  });
}
function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function probePort(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}
async function waitForPort(port, host, budgetMs) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await probePort(port, host, 800)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startWeb(opts) {
  const host = opts.host || "127.0.0.1";
  const port = Number(opts.port) || 3080;
  if (await probePort(port, host, 800)) return { ok: true, alreadyUp: true, host, port };
  const bin = resolveDsh();
  const logPath = path.join(logDir(), "dsh-web.log");
  let logFd = null;
  try { logFd = fs.openSync(logPath, "a"); } catch {}
  const out = logFd != null ? logFd : "ignore";
  const err = logFd != null ? logFd : "ignore";
  const child = spawn(bin, ["web", "--no-open", "--host", String(host), "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, err],
    cwd: os.homedir(),
    env: { ...process.env },
  });
  child.unref();
  try { child.on("error", () => {}); } catch {}
  const pid = child.pid ?? null;
  const up = await waitForPort(port, host, 20000);
  return up
    ? { ok: true, pid, host, port, log: logPath }
    : { ok: false, pid, host, port, log: logPath, reason: "port-stayed-down" };
}

async function status() {
  const dshBin = resolveDsh();
  return {
    ok: true,
    host: HOST_NAME,
    version: "1.0.0",
    dsh: fs.existsSync(dshBin) ? dshBin : null,
    logDir: logDir(),
  };
}

async function dispatch(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, reason: "bad-message" };
  switch (msg.cmd) {
    case "start":
      if (msg.target === "web") return await startWeb(msg);
      return { ok: false, reason: "unknown-target" };
    case "status": return await status();
    default: return { ok: false, reason: "unknown-cmd" };
  }
}

const msg = await readMessage();
if (msg != null) {
  let result;
  try { result = await dispatch(msg); }
  catch (e) { result = { ok: false, reason: String((e && e.message) || e) }; }
  writeMessage(result);
  await sleep(50);
  process.exit(0);
}
