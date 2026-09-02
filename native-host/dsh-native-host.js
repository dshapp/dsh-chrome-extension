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

/**
 * install.sh 落盘的那份配置。它记着本次装出来的 dsh 绝对路径
 * (启动 server 用)。读失败一律返回 null 并回退到候选列表 ——
 * 配置损坏不能让 host 整个连不上,那会连 status 都不通。
 */
function readInstallConfig() {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const raw = fs.readFileSync(path.join(home, "dsh-chrome-update.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 挑一份 dsh 来跑 server。
 *
 * 顺序是有讲究的,不是随手排的:一台机器上完全可能并存 Homebrew、npm -g、
 * pnpm 三份 dsh,而 install.sh 装的、插件 profile 所属的,是 **pnpm 全局** 那份。
 * 挑错了的后果很隐蔽 —— server 照常起、端口照常通,只是跑着旧代码、
 * 找不到刚装的插件,看起来像"装了没生效"。
 *
 * 于是:显式指定 > 安装期落盘的实测路径 > pnpm 的默认位置 > 其它包管理器。
 * 其中 ~/Library/pnpm 是 macOS 上 pnpm 的默认 PNPM_HOME,原先整个漏了,
 * 导致 mac 上必然回退到 /opt/homebrew。
 */
function resolveDsh() {
  const home = os.homedir();
  const configured = readInstallConfig()?.dshBin;
  const candidates = [
    process.env.DSH_BIN,
    configured,
    path.join(home, "Library/pnpm/bin/dsh"),
    path.join(home, "Library/pnpm/dsh"),
    path.join(home, ".local/share/pnpm/bin/dsh"),
    path.join(home, ".local/share/pnpm/dsh"),
    "/opt/homebrew/bin/dsh",
    path.join(home, ".cargo/bin/dsh"),
    path.join(home, ".local/bin/dsh"),
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
