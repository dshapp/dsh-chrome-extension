import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServerOps } from "../src/features/host-proxy/server-ops.js";
import { createServerPane } from "../src/app/sidepanel/settings/server-pane.js";
import { HostProxyError, HostProxyReason } from "../src/platform/dsh/host-proxy-client.js";
import { createWebSupervisor, isServerUp } from "../sw/server-supervisor.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const unsupported = () => new HostProxyError(HostProxyReason.UNSUPPORTED, "unreachable", null);

// ---- 重启:本地启动器优先,老宿主退回 chrome-daemon ----

test("restart goes through the native launcher and never touches the daemon when it can", async () => {
  const calls = [];
  const ops = createServerOps({
    client: { serverRestart: () => assert.fail("daemon restart") },
    nativeRestart: async (target) => { calls.push(target); return { ok: true, stopped: true, previousPid: 1, pid: 2, log: "/l/dsh-web.log" }; }
  });
  assert.deepEqual(await ops.restart(), { stopped: true, started: true, pid: 2, log: "/l/dsh-web.log", via: "native" });
  assert.deepEqual(calls, ["web"]);
});

test("a launcher whose new server never came up reports started:false with the log, not an exception", async () => {
  const ops = createServerOps({ client: {}, nativeRestart: async () => ({ ok: false, reason: "port-stayed-down", stopped: true, pid: 9, log: "/l/x.log" }) });
  assert.deepEqual(await ops.restart(), { stopped: true, started: false, pid: 9, log: "/l/x.log", via: "native" });
});

test("an old launcher, an unsupported platform or a missing host falls back to the daemon", async () => {
  for (const reason of ["unknown-cmd", "unsupported-platform", "host-missing", "native-messaging-unavailable"]) {
    let daemon = 0;
    const ops = createServerOps({ client: { serverRestart: async () => { daemon++; return { started: true }; } }, nativeRestart: async () => ({ ok: false, reason }) });
    assert.deepEqual(await ops.restart(), { started: true }, reason);
    assert.equal(daemon, 1, reason);
  }
});

test("the launcher refusing to kill a non-dsh process is an error, not a silent daemon retry", async () => {
  const ops = createServerOps({ client: { serverRestart: () => assert.fail("daemon restart") },
    nativeRestart: async () => ({ ok: false, reason: "not-dsh-web", port: 3080, pid: 42 }) });
  await assert.rejects(ops.restart(), (error) => error.reason === "not-dsh-web" && /3080/.test(error.message) && /42/.test(error.message));
});

// ---- 服务端页:重启段不再只看 chrome-daemon ----

function paneHarness({ serverOps, probe }) {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.querySelector("#host");
  let reconnects = 0;
  const connection = { streamState: "connected", baseUrl: "http://127.0.0.1:3080", restart: () => { reconnects++; } };
  const toasts = [];
  const pane = createServerPane({ host, serverOps, probe, showToast: (text, type) => toasts.push({ text, type }),
    deps: { connection, DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting" } } });
  return { dom, host, pane, toasts, reconnects: () => reconnects };
}

const daemonGone = { version: async () => { throw unsupported(); } };

test("with the daemon gone, a launcher that can restart still gets the restart row", async (t) => {
  let restarts = 0;
  const h = paneHarness({
    serverOps: { ...daemonGone, restart: async () => { restarts++; return { started: true, stopped: true }; } },
    probe: async () => ({ ok: true, commands: ["start", "restart", "status"], logDir: "/l" })
  });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle(); await settle();
  const button = h.host.querySelector("#srv-dsh-restart");
  assert.ok(button, "restart button rendered");
  assert.match(h.host.textContent, /同一地址|same address/);
  button.click(); await settle(); await settle();
  assert.equal(restarts, 1);
  // 重启落地后立刻重连,不等退避;成功提示按 success 样式显示。
  assert.equal(h.reconnects(), 1);
  assert.equal(h.toasts.at(-1)?.type, "success");
});

test("the launcher card only shows whether it is registered: no start button", async (t) => {
  const installed = paneHarness({ serverOps: daemonGone, probe: async () => ({ ok: true, commands: ["restart"] }) });
  const missing = paneHarness({ serverOps: daemonGone, probe: async () => ({ ok: false, reason: "host-missing" }) });
  t.after(() => { for (const h of [installed, missing]) { h.pane.stop(); h.dom.window.close(); } });
  for (const h of [installed, missing]) { await h.pane.refresh(); await settle(); await settle(); }
  assert.equal(installed.host.querySelector("#srv-launcher-test"), null);
  assert.match(installed.host.textContent, /已安装|Installed/);
  assert.equal(missing.host.querySelector("#srv-launcher-test"), null);
  assert.match(missing.host.textContent, /未安装|Not installed/);
});

test("with the daemon gone and an old launcher, there is nothing that can restart: no row", async (t) => {
  const h = paneHarness({ serverOps: daemonGone, probe: async () => ({ ok: true, logDir: "/l" }) });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle(); await settle();
  assert.equal(h.host.querySelector("#srv-dsh-restart"), null);
});

test("a refused restart stays next to the button and does not reconnect", async (t) => {
  const h = paneHarness({
    serverOps: { ...daemonGone, restart: async () => { throw Object.assign(new Error("端口 3080 被占用"), { reason: "not-dsh-web" }); } },
    probe: async () => ({ ok: true, commands: ["restart"] })
  });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle(); await settle();
  h.host.querySelector("#srv-dsh-restart").click(); await settle(); await settle();
  assert.match(h.host.querySelector(".set-danger")?.textContent ?? "", /3080/);
  assert.equal(h.reconnects(), 0);
});

// ---- 自动唤起:直接探 dsh web,而不是看 CDP 桥 ----

test("isServerUp: any HTTP answer is up, a refused connection is down", async () => {
  assert.equal(await isServerUp("http://127.0.0.1:3080", { fetchImpl: async () => ({ status: 401 }) }), true);
  assert.equal(await isServerUp("http://127.0.0.1:3080", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), false);
});

function supervisorHarness({ up = false, reply = { ok: true, pid: 7 } } = {}) {
  let clock = 0;
  const ensures = [];
  let started = 0;
  const state = { up, reply };
  const supervisor = createWebSupervisor({
    probe: async () => state.up,
    ensure: async (target, options) => { ensures.push({ target, ...options }); return typeof state.reply === "function" ? state.reply() : state.reply; },
    backendUrl: async () => "http://127.0.0.1:3080",
    onStarted: () => { started++; },
    now: () => clock
  });
  return { supervisor, ensures, state, started: () => started, advance: (ms) => { clock += ms; } };
}

test("a running dsh web is left alone, whatever the bridge says", async () => {
  const h = supervisorHarness({ up: true });
  assert.equal((await h.supervisor.tick()).state, "up");
  assert.deepEqual(h.ensures, []);
});

test("a dsh web that is down gets started, and the bridge is nudged", async () => {
  const h = supervisorHarness();
  assert.equal((await h.supervisor.tick()).state, "started");
  assert.deepEqual(h.ensures, [{ target: "web", backendUrl: "http://127.0.0.1:3080", force: true }]);
  assert.equal(h.started(), 1);
});

test("failed starts back off (30s, 60s, …) and a server that comes back resets it", async () => {
  const h = supervisorHarness({ reply: { ok: false, reason: "port-stayed-down" } });
  assert.equal((await h.supervisor.tick()).state, "failed");
  h.advance(29_000);
  assert.equal((await h.supervisor.tick()).state, "backoff");
  h.advance(1_000);
  assert.equal((await h.supervisor.tick()).state, "failed");
  h.advance(59_000);
  assert.equal((await h.supervisor.tick()).state, "backoff");
  assert.equal(h.ensures.length, 2);
  h.state.up = true;
  assert.equal((await h.supervisor.tick()).state, "up");
  h.state.up = false;
  h.state.reply = { ok: true };
  assert.equal((await h.supervisor.tick()).state, "started");
  assert.equal(h.ensures.length, 3);
});

test("overlapping ticks share one pass: one start, not two", async () => {
  let release;
  const h = supervisorHarness({ reply: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }) });
  const first = h.supervisor.tick();
  const second = h.supervisor.tick();
  await settle(); await settle();
  release();
  await Promise.all([first, second]);
  assert.equal(h.ensures.length, 1);
});
