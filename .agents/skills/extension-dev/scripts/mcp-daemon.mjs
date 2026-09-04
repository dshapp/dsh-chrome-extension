#!/usr/bin/env node

// Long-lived chrome-devtools-mcp daemon. Chrome prompts once per browser-level
// CDP connection, so the MCP child is started once and every tool call reuses
// it through a Unix domain socket; the child is only restarted after it dies.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const FIRST_CALL_ID = 100;

export function daemonPaths(tmpdir = os.tmpdir()) {
  const owner = process.getuid ? process.getuid() : "user";
  const base = path.join(tmpdir, `chrome-devtools-mcp-${owner}`);
  return { socket: `${base}.sock`, pid: `${base}.pid`, log: `${base}.log` };
}

export function childCommand(env = process.env) {
  const bin = env.CHROME_DEVTOOLS_MCP_BIN || "npx";
  if (env.CHROME_DEVTOOLS_MCP_ARGS) return { bin, args: JSON.parse(env.CHROME_DEVTOOLS_MCP_ARGS) };
  return {
    bin,
    args: [
      "-y", "chrome-devtools-mcp@latest",
      "--categoryExtensions", "--autoConnect", "--experimentalIncludeAllPages",
      "--no-performance-crux", "--no-usage-statistics",
    ],
  };
}

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

export function startDaemon(options = {}) {
  const env = options.env || process.env;
  const paths = options.paths || daemonPaths();
  const idleMs = options.idleMs ?? Number(env.CHROME_DEVTOOLS_MCP_IDLE_MS ?? DEFAULT_IDLE_MS);
  const root = options.root || process.cwd();
  const logFd = fs.openSync(paths.log, "a");

  let child = null;
  let buffer = "";
  let ready = false;
  let starting = false;
  let bound = false;
  let stopped = false;
  let nextId = FIRST_CALL_ID;
  let handshakeTimer = null;
  let idleTimer = null;
  const pending = new Map();
  const waiting = [];

  const log = (line) => {
    try { fs.appendFileSync(logFd, `${new Date().toISOString()} ${line}\n`); } catch { /* 日志不可写时静默 */ }
  };

  let resolveStopped;
  const daemon = { paths, stop, stopped: new Promise((resolve) => { resolveStopped = resolve; }) };

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleMs > 0 && !stopped) idleTimer = setTimeout(() => stop("idle timeout"), idleMs);
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (child) child.kill();
    server.close(() => {});
    for (const socket of [...pending.values(), ...waiting.map((entry) => entry.socket)]) {
      socket.end();
    }
    if (bound) for (const file of [paths.socket, paths.pid]) fs.rmSync(file, { force: true });
    log(`daemon stopped: ${reason || "requested"}`);
    try { fs.closeSync(logFd); } catch { /* 已关闭 */ }
    resolveStopped();
    if (options.exitProcess) process.exit(0);
  }

  function respond(socket, body) {
    if (!socket.destroyed) socket.end(encode(body));
  }

  function failPending(error) {
    for (const [id, socket] of pending) {
      pending.delete(id);
      respond(socket, { ok: false, error });
    }
    for (const entry of waiting.splice(0)) respond(entry.socket, { ok: false, error });
  }

  function send(message) {
    if (child?.stdin?.writable) child.stdin.write(encode(message));
  }

  function spawnChild() {
    const { bin, args } = childCommand(env);
    starting = true;
    ready = false;
    buffer = "";
    nextId = FIRST_CALL_ID;
    child = spawn(bin, args, { stdio: ["pipe", "pipe", logFd], env, cwd: root });
    log(`spawned ${bin} ${args.join(" ")} pid=${child.pid}`);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onLine(line);
      }
    });
    child.on("exit", () => {
      child = null;
      starting = false;
      ready = false;
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      failPending("chrome-devtools-mcp exited before responding");
      if (!stopped) log("child exited; will restart on next call");
    });
    child.on("error", (error) => {
      log(`spawn error: ${error.message}`);
      failPending(`failed to start chrome-devtools-mcp: ${error.message}`);
      stop("spawn error");
    });
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      log("handshake timed out");
      failPending("chrome-devtools-mcp handshake timed out");
      stop("handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: "chrome-extension-local-dev", version: "1.1.0" },
      },
    });
  }

  function onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === 1 && message.method === undefined) {
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      ready = true;
      starting = false;
      log("handshake complete");
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      for (const entry of waiting.splice(0)) dispatch(entry.socket, entry.tool, entry.arguments);
      return;
    }
    if (message.method === "roots/list" && message.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { roots: [{ uri: pathToFileURL(root).href, name: path.basename(root) }] },
      });
      return;
    }
    if (message.method === "ping" && message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.id >= FIRST_CALL_ID && pending.has(message.id)) {
      const socket = pending.get(message.id);
      pending.delete(message.id);
      const failed = Boolean(message.error || message.result?.isError);
      respond(socket, { ok: true, failed, payload: message.error || message.result });
    }
  }

  function dispatch(socket, tool, args) {
    if (!child) {
      waiting.push({ socket, tool, arguments: args });
      if (!starting) spawnChild();
      return;
    }
    if (!ready) {
      waiting.push({ socket, tool, arguments: args });
      return;
    }
    const id = nextId++;
    pending.set(id, socket);
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args ?? {} } });
  }

  function handleRequest(socket, line) {
    let request;
    try { request = JSON.parse(line); } catch {
      respond(socket, { ok: false, error: "invalid JSON request" });
      return;
    }
    if (request.action === "ping") {
      respond(socket, { ok: true, result: { pid: process.pid, ready, childPid: child?.pid ?? null } });
      return;
    }
    if (request.action === "shutdown") {
      socket.end(encode({ ok: true }), () => stop("shutdown request"));
      return;
    }
    if (request.action === "call" && request.tool) {
      dispatch(socket, request.tool, request.arguments || {});
      return;
    }
    respond(socket, { ok: false, error: `unsupported action: ${request.action ?? "(none)"}` });
  }

  const server = net.createServer((socket) => {
    resetIdle();
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk;
      let newline;
      while ((newline = received.indexOf("\n")) >= 0) {
        const line = received.slice(0, newline).trim();
        received = received.slice(newline + 1);
        if (line) handleRequest(socket, line);
      }
    });
    socket.on("error", () => { /* 客户端断开属正常 */ });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      stop(`server error: ${error.message}`);
      reject(error);
    });
    server.listen(paths.socket, () => {
      bound = true;
      fs.writeFileSync(paths.pid, `${process.pid}\n`);
      log(`daemon listening pid=${process.pid}`);
      resetIdle();
      spawnChild();
      resolve(daemon);
    });
  });
}

function isDaemonAlive(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (alive) => {
      socket.destroy();
      resolve(alive);
    };
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
    setTimeout(() => finish(false), 1_000).unref();
  });
}

export function invokedAsScript(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export async function main() {
  const paths = daemonPaths();
  if (await isDaemonAlive(paths.socket)) process.exit(0);
  fs.rmSync(paths.socket, { force: true });
  try {
    const daemon = await startDaemon({ paths, exitProcess: true });
    process.on("SIGTERM", () => daemon.stop("SIGTERM"));
    process.on("SIGINT", () => daemon.stop("SIGINT"));
  } catch (error) {
    process.exit(error?.code === "EADDRINUSE" ? 0 : 1);
  }
}

if (invokedAsScript(import.meta.url)) {
  await main();
}
