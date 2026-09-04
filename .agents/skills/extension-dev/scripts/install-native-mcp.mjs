#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const serverCommand = [
  "npx", "-y", "chrome-devtools-mcp@latest",
  "--categoryExtensions", "--autoConnect", "--experimentalIncludeAllPages",
  "--no-performance-crux", "--no-usage-statistics",
];

const hostIndex = process.argv.indexOf("--host");
const requestedHost = hostIndex >= 0 ? process.argv[hostIndex + 1] : "";
const inferredHost = process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT
  ? "claude"
  : process.env.CODEX_THREAD_ID
    ? "codex"
    : "";
const host = requestedHost || inferredHost;

const hosts = {
  codex: {
    cli: "codex",
    serverName: "chrome-devtools",
    getArgs: (name) => ["mcp", "get", name],
    addArgs: (name) => ["mcp", "add", name, "--", ...serverCommand],
    reloadNote: "Start a new Codex task to load the native tools.",
  },
  claude: {
    cli: "claude",
    serverName: "chrome-extension-devtools",
    getArgs: (name) => ["mcp", "get", name],
    addArgs: (name) => ["mcp", "add", "--scope", "user", name, "--", ...serverCommand],
    reloadNote: "Start a new Claude Code session to load the native tools.",
  },
};

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (!hosts[host]) {
  print({ status: "failed", reason: "Pass --host codex or --host claude." });
  process.exit(2);
}

const config = hosts[host];
const { cli, serverName } = config;
const run = (args) => spawnSync(cli, args, { encoding: "utf8" });

const existing = run(config.getArgs(serverName));
if (existing.error?.code === "ENOENT") {
  print({ status: "skipped", host, reason: `${cli} CLI not found` });
  process.exit(2);
}
if (existing.error) {
  print({ status: "failed", reason: existing.error.message });
  process.exit(1);
}
if (existing.status === 0) {
  print({ status: "already-configured", host, server: serverName });
  process.exit(0);
}

const lookupMessage = `${existing.stdout || ""}\n${existing.stderr || ""}`;
if (!/No MCP server named\b/i.test(lookupMessage)) {
  print({ status: "failed", reason: lookupMessage.trim() || `MCP lookup exited with ${existing.status}` });
  process.exit(existing.status || 1);
}

const added = run(config.addArgs(serverName));
if (added.error || added.status !== 0) {
  print({ status: "failed", reason: added.error?.message || (added.stderr || added.stdout).trim() });
  process.exit(added.status || 1);
}

const verified = run(config.getArgs(serverName));
if (verified.status !== 0) {
  print({ status: "failed", reason: "Server was added but verification failed." });
  process.exit(1);
}

print({ status: "installed", host, server: serverName, note: config.reloadNote });
