#!/usr/bin/env node

// One-shot MCP tool runner. Reuses the long-lived daemon in mcp-daemon.mjs so
// Chrome only prompts for the browser-level CDP connection once per daemon
// lifetime. Invoked once per tool call; pass --shutdown to stop the daemon.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { daemonPaths, invokedAsScript } from "./mcp-daemon.mjs";

const DAEMON_START_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 90_000;

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

export async function main(argv = process.argv.slice(2)) {
  const wantsShutdown = argv.includes("--shutdown");
  const args = argv.filter((flag) => flag !== "--shutdown");
  const toolName = args[0];
  if (!toolName && !wantsShutdown) {
    console.error("Usage: chrome-devtools-mcp.mjs [--shutdown] <tool-name> [json-arguments]");
    process.exit(2);
  }
  let toolArguments = {};
  try {
    toolArguments = args[1] ? JSON.parse(args[1]) : {};
  } catch (error) {
    console.error(`Invalid JSON arguments: ${error.message}`);
    process.exit(2);
  }
  if (wantsShutdown) {
    await shutdownDaemon();
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
