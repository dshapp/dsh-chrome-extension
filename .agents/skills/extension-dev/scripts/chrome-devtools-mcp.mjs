#!/usr/bin/env node

// One-shot MCP tool runner. Default mode reuses the long-lived daemon in
// mcp-daemon.mjs so Chrome only prompts for the browser-level CDP connection
// once per daemon lifetime; --isolated keeps the original throwaway spawn.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonPaths, invokedAsScript } from "./mcp-daemon.mjs";

const DAEMON_START_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 90_000;
const ISOLATED_TIMEOUT_MS = 60_000;

export function requestDaemon(paths, body, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let received = "";
    let settled = false;
    const socket = net.connect(paths.socket);
    const timer = setTimeout(() => finish(new Error("daemon request timed out")), timeoutMs);
    function finish(error, response) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    }
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(received.slice(0, newline)));
      } catch {
        finish(new Error("invalid daemon response"));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("daemon closed without responding")));
  });
}

function isRefused(error) {
  return ["ECONNREFUSED", "ENOENT", "ECONNRESET"].includes(error?.code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDaemonAndRequest(paths, body) {
  fs.rmSync(paths.socket, { force: true });
  const daemonPath = fileURLToPath(new URL("./mcp-daemon.mjs", import.meta.url));
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      return await requestDaemon(paths, body);
    } catch (error) {
      if (!isRefused(error)) throw error;
    }
  }
  throw new Error(`daemon did not become ready; check ${paths.log}`);
}

function printDaemonResponse(response) {
  if (!response.ok) {
    process.stderr.write(`chrome-devtools-mcp daemon error: ${response.error}\n`);
    process.stdout.write(`${JSON.stringify({ error: response.error }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(response.payload, null, 2)}\n`);
  process.exit(response.failed ? 1 : 0);
}

async function runViaDaemon(toolName, toolArguments) {
  const paths = daemonPaths();
  const body = { action: "call", tool: toolName, arguments: toolArguments };
  let response;
  try {
    response = await requestDaemon(paths, body);
  } catch (error) {
    if (!isRefused(error)) throw error;
    response = await startDaemonAndRequest(paths, body);
  }
  printDaemonResponse(response);
}

async function shutdownDaemon() {
  const paths = daemonPaths();
  let response;
  try {
    response = await requestDaemon(paths, { action: "shutdown" }, 10_000);
  } catch (error) {
    if (!isRefused(error)) throw error;
    fs.rmSync(paths.socket, { force: true });
    response = { ok: true, note: "daemon not running" };
  }
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

function runOneShot(toolName, toolArguments) {
  const mcpArgs = [
    "-y",
    "chrome-devtools-mcp@latest",
    "--categoryExtensions",
    "--experimentalIncludeAllPages",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];
  const child = spawn("npx", mcpArgs, { stdio: ["pipe", "pipe", "pipe"] });
  const root = path.resolve(process.cwd());
  let stdoutBuffer = "";
  let settled = false;

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function finish(code, result) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    child.kill();
    setTimeout(() => process.exit(code), 100);
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try { message = JSON.parse(line); }
      catch { continue; }

      if (message.id === 1 && !message.method) {
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        send({
          jsonrpc: "2.0",
          id: 100,
          method: "tools/call",
          params: { name: toolName, arguments: toolArguments },
        });
        continue;
      }

      if (message.method === "roots/list") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { roots: [{ uri: pathToFileURL(root).href, name: path.basename(root) }] },
        });
        continue;
      }

      if (message.id === 100) {
        const failed = Boolean(message.error || message.result?.isError);
        finish(failed ? 1 : 0, message.error || message.result);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (/Could not connect|DevToolsActivePort|Error:/i.test(text)) process.stderr.write(text);
  });

  child.on("error", (error) => finish(1, { error: error.message }));
  child.on("exit", (code) => {
    if (!settled) finish(code || 1, { error: "chrome-devtools-mcp exited before responding" });
  });

  const timeout = setTimeout(() => finish(1, { error: "chrome-devtools-mcp timed out" }), ISOLATED_TIMEOUT_MS);

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "chrome-extension-local-dev", version: "1.0.0" },
    },
  });

  process.on("SIGINT", () => finish(130));
  process.on("SIGTERM", () => finish(143));
}

export async function main(argv = process.argv.slice(2)) {
  const takeFlag = (name) => {
    const index = argv.indexOf(name);
    if (index < 0) return false;
    argv.splice(index, 1);
    return true;
  };
  const isolated = takeFlag("--isolated");
  const wantsShutdown = takeFlag("--shutdown");
  const toolName = argv[0];
  if (!toolName && !wantsShutdown) {
    console.error("Usage: chrome-devtools-mcp.mjs [--isolated] [--shutdown] <tool-name> [json-arguments]");
    process.exit(2);
  }
  let toolArguments = {};
  try {
    toolArguments = argv[1] ? JSON.parse(argv[1]) : {};
  } catch (error) {
    console.error(`Invalid JSON arguments: ${error.message}`);
    process.exit(2);
  }
  if (wantsShutdown) {
    await shutdownDaemon();
    return;
  }
  if (isolated) {
    runOneShot(toolName, toolArguments);
    return;
  }
  await runViaDaemon(toolName, toolArguments);
}

if (invokedAsScript(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
    process.exit(1);
  });
}
