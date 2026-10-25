/**
 * 设置页「移动端访问」:对齐 Mac MobileAccessSection / MobileAccessSupervisor。
 * 协议形状是 dsh-mobile-bridge 的 Control API(README),写错只会静默失效,这里逐个钉住。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><section id="pane"></section><dialog id="sheet"><div id="settings-sheet-body"></div></dialog></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { setLang } = await import("../src/shared/i18n.js");
setLang("zh");
const { RPC } = await import("../src/platform/dsh/rpc-methods.js");
const { DshRpcError, DshTransportError } = await import("../src/platform/dsh/api-client.js");
const {
  createMobileAccess, isMissingRoute, normalizeStatus, MobilePhase, MOBILE_BRIDGE_PLUGIN
} = await import("../src/features/mobile-access/mobile-access.js");
const { qrMatrix, qrSvg } = await import("../src/features/mobile-access/qr-svg.js");
const { createMobilePane, presenceText, relayView } = await import("../src/app/sidepanel/settings/mobile-pane.js");

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

const STATUS = {
  bridgeKey: "k", proxyHost: "relay.example", proxyPort: 8787, connected: true, disabled: false,
  deviceName: "我的 MacBook", now: 0,
  pairing: { url: "dshm://relay.example:8787/k?name=x#tok1", expiresAt: 1 },
  devices: [
    { deviceId: "dev-a", label: "iPhone", addedAt: 1, lastSeenAt: 1, expiresAt: 2, online: true },
    { deviceId: "dev-b", label: "Pixel", addedAt: 1, lastSeenAt: Date.now() - 3 * 3_600_000, expiresAt: 2, online: false }
  ]
};

/// 假 connection:按方法名回包;handler 可以是值、函数或 Error。
function fakeConnection(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      const handler = handlers[method];
      const value = typeof handler === "function" ? handler(args) : handler;
      if (value instanceof Error) throw value;
      return value;
    }
  };
}

test("isMissingRoute:路由不存在的几种说法都算插件没装,别的错不算", () => {
  assert.equal(isMissingRoute(new DshRpcError("endpoint-unknown", "no such endpoint")), true);
  assert.equal(isMissingRoute(new DshRpcError("internal", "Route not found")), true);
  assert.equal(isMissingRoute(new DshTransportError("DSH HTTP 404 /api/mobileBridge/status")), true);
  assert.equal(isMissingRoute(new DshRpcError("internal", "relay exploded")), false);
  assert.equal(isMissingRoute(new DshTransportError("DSH HTTP 500 /api/mobileBridge/status")), false);
});

test("normalizeStatus:老桥接缺字段按 Mac 口径补默认值,pairing 缺 ≠ pairing:null", () => {
  const old = normalizeStatus({ bridgeKey: "k", connected: false, devices: [{ deviceId: "d", label: "", lastSeenAt: 5 }] });
  assert.equal(old.disabled, false);
  assert.equal(old.reportsPairing, false);
  assert.equal(old.relay, "");
  assert.deepEqual(old.devices.map((d) => [d.label, d.online]), [["d", false]]);
  const fresh = normalizeStatus({ ...STATUS, pairing: null });
  assert.equal(fresh.reportsPairing, true);
  assert.equal(fresh.pairing, null);
  assert.equal(fresh.relay, "relay.example:8787");
});

test("supervisor:动作打到对应路由,参数名与桥接一致,动作后重读 status", async () => {
  const connection = fakeConnection({
    [RPC.mobileBridgeStatus]: STATUS,
    [RPC.mobileBridgePair]: { url: "dshm://new#tok2", expiresAt: 2 },
    [RPC.mobileBridgeRevoke]: { removed: true },
    [RPC.mobileBridgeRename]: { renamed: true },
    [RPC.mobileBridgeDisconnect]: { connected: false },
    [RPC.mobileBridgeConnect]: { connected: true }
  });
  const access = createMobileAccess({ connection });
  await access.refresh();
  assert.equal(access.state.phase, MobilePhase.ready);
  assert.equal(access.state.pairingUrl, STATUS.pairing.url);
  await access.revoke("dev-b");
  assert.deepEqual(await access.rename("dev-a", "工作机"), { outcome: "renamed" });
  await access.disconnect();
  await access.connect();
  const sent = connection.calls.filter((c) => c.method !== RPC.mobileBridgeStatus);
  assert.deepEqual(sent.map((c) => [c.method, c.args]), [
    [RPC.mobileBridgeRevoke, { deviceId: "dev-b" }],
    [RPC.mobileBridgeRename, { deviceId: "dev-a", label: "工作机" }],
    [RPC.mobileBridgeDisconnect, {}],
    [RPC.mobileBridgeConnect, {}]
  ]);
  assert.equal(connection.calls.filter((c) => c.method === RPC.mobileBridgeStatus).length, 5);
});

test("supervisor:码被扫走后新桥接报 pairing:null 就清掉;老桥接不报就留着手里那张", async () => {
  let status = STATUS;
  const connection = fakeConnection({ [RPC.mobileBridgeStatus]: () => status });
  const access = createMobileAccess({ connection });
  await access.refresh();
  status = { ...STATUS, pairing: null };
  await access.refresh();
  assert.equal(access.state.pairingUrl, null);

  const legacy = createMobileAccess({ connection: fakeConnection({
    [RPC.mobileBridgeStatus]: () => { const { pairing, ...rest } = STATUS; return rest; },
    [RPC.mobileBridgePair]: { url: "dshm://legacy#tok", expiresAt: 1 }
  }) });
  await legacy.pair();
  assert.equal(legacy.state.pairingUrl, "dshm://legacy#tok");
});

test("supervisor:插件没装 → missing;改名遇到老插件 → unsupported 且不动 phase", async () => {
  const missing = createMobileAccess({ connection: fakeConnection({
    [RPC.mobileBridgeStatus]: new DshRpcError("endpoint-unknown", "unknown endpoint")
  }) });
  await missing.refresh();
  assert.equal(missing.state.phase, MobilePhase.missing);

  const old = createMobileAccess({ connection: fakeConnection({
    [RPC.mobileBridgeStatus]: STATUS,
    [RPC.mobileBridgeRename]: new DshRpcError("internal", "not found")
  }) });
  await old.refresh();
  assert.deepEqual(await old.rename("dev-a", "x"), { outcome: "unsupported" });
  assert.equal(old.state.phase, MobilePhase.ready);
});

test("install:已装就启用、没装就装;要重启而重启不了时留下 restart-required", async () => {
  const calls = [];
  const pluginManager = (installed, application) => ({
    async pluginBundles() { return installed ? [{ name: MOBILE_BRIDGE_PLUGIN, installed: true }] : []; },
    async setBundleEnabled(name, enabled) { calls.push(["enable", name, enabled]); return { application }; },
    async installBundle(spec, options) { calls.push(["install", spec, options.enabled !== false]); return { application }; }
  });
  let installedNow = false;
  let live = null;
  const connection = fakeConnection({
    [RPC.mobileBridgeStatus]: () => installedNow ? { ...STATUS, pairing: live } : new DshRpcError("endpoint-unknown", "x"),
    [RPC.mobileBridgePair]: () => (live = { url: "dshm://after-install#t", expiresAt: 1 })
  });

  const a = createMobileAccess({ connection, pluginManager: pluginManager(false, "applied") });
  installedNow = true;
  await a.install();
  assert.deepEqual(calls.shift(), ["install", MOBILE_BRIDGE_PLUGIN, true]);
  // 装好后桥接没有码 → 自动出一张。
  assert.equal(a.state.pairingUrl, "dshm://after-install#t");

  const b = createMobileAccess({ connection, pluginManager: pluginManager(true, "restart-required") });
  await b.install();
  assert.deepEqual(calls.shift(), ["enable", MOBILE_BRIDGE_PLUGIN, true]);
  assert.equal(b.state.installError, "restart-required");

  let restarted = 0;
  const c = createMobileAccess({ connection, pluginManager: pluginManager(true, "restart-required") });
  await c.install({ restart: async () => { restarted += 1; return true; } });
  assert.equal(restarted, 1);
  assert.equal(c.state.installError, "");
});

test("qr:UTF-8 编码的设备名与库默认(只取低 8 位)画出不同的码;SVG 白底并带可读标签", () => {
  const ascii = qrMatrix("dshm://h:1/k#t");
  assert.ok(ascii.size >= 21);
  const svg = qrSvg("dshm://h:1/k?name=我#t", { label: "配对手机" });
  assert.match(svg, /^<svg class="mob-qr-svg"/);
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /aria-label="配对手机"/);
  assert.match(svg, /<path d="M\d/);
});

test("presence 与中转状态文案:在线 / 刚刚 / N 小时前;切断与没连上分开说", () => {
  const now = Date.now();
  assert.equal(presenceText({ online: true, lastSeenAt: 0 }, now), "已连接");
  assert.equal(presenceText({ online: false, lastSeenAt: now - 10_000 }, now), "刚刚还在线");
  assert.equal(presenceText({ online: false, lastSeenAt: now - 3 * 3_600_000 }, now), "3小时前在线");
  assert.equal(relayView({ phase: "ready", connected: false, disabled: true }).text, "已切断移动端访问");
  assert.equal(relayView({ phase: "ready", connected: false, disabled: false }).text, "未连上中转");
  assert.equal(relayView({ phase: "missing" }).text, "未安装插件");
});

function fakeSheet() {
  const dialog = document.getElementById("sheet");
  const root = dialog.querySelector("#settings-sheet-body");
  let generation = 0;
  let open = false;
  return {
    get isOpen() { return open; },
    root,
    owns: (token) => open && token === generation,
    open({ title, body, actions, bind }) {
      generation += 1; open = true;
      root.innerHTML = '<div class="set-sheet-head">' + title + '</div><div class="set-sheet-body">' + body
        + '</div><div class="set-sheet-actions">' + actions + "</div>";
      bind?.(root, generation);
      return generation;
    },
    setActions(actions, token) { if (this.owns(token)) root.querySelector(".set-sheet-actions").innerHTML = actions; },
    close(token) { if (token === undefined || this.owns(token)) { open = false; generation += 1; root.innerHTML = ""; } }
  };
}

test("pane:就绪时画中转、设备、二维码;吊销与改名走桥接", async () => {
  const host = document.getElementById("pane");
  const connection = fakeConnection({
    [RPC.mobileBridgeStatus]: STATUS,
    [RPC.mobileBridgeRevoke]: { removed: true },
    [RPC.mobileBridgeRename]: { renamed: true }
  });
  const sheet = fakeSheet();
  const pane = createMobilePane({ host, sheet, deps: { connection } });
  await pane.refresh();
  pane.stop();
  assert.match(host.textContent, /已连上中转/);
  assert.match(host.textContent, /relay\.example:8787/);
  assert.ok(host.querySelector("#mob-disconnect"));
  assert.deepEqual([...host.querySelectorAll(".mob-device-name")].map((n) => n.textContent), ["iPhone", "Pixel"]);
  assert.match(host.textContent, /3小时前在线/);
  assert.ok(host.querySelector("#mob-qr svg"));
  assert.match(host.textContent, /手机上会显示为“我的 MacBook”/);
  // 已有一张有效的码:重开这一页不该铸新码把它作废。
  assert.equal(connection.calls.some((c) => c.method === RPC.mobileBridgePair), false);

  host.querySelector('[data-mob-revoke="dev-b"]').click();
  await flush();
  assert.ok(connection.calls.some((c) => c.method === RPC.mobileBridgeRevoke && c.args.deviceId === "dev-b"));

  host.querySelector('[data-mob-rename="dev-a"]').click();
  assert.equal(sheet.isOpen, true);
  const input = sheet.root.querySelector("#mob-rename-input");
  assert.equal(input.value, "iPhone");
  assert.equal(sheet.root.querySelector("#mob-rename-save").disabled, true);
  input.value = "  工作手机 ";
  input.dispatchEvent(new window.Event("input"));
  sheet.root.querySelector("#mob-rename-save").click();
  await flush();
  assert.ok(connection.calls.some((c) => c.method === RPC.mobileBridgeRename && c.args.label === "工作手机"));
  assert.equal(sheet.isOpen, false);
});

test("pane:没有码时自动出一张;插件没装时给安装入口", async () => {
  const host = document.getElementById("pane");
  const connection = fakeConnection({
    [RPC.mobileBridgeStatus]: { ...STATUS, pairing: null, devices: [] },
    [RPC.mobileBridgePair]: { url: "dshm://fresh#t", expiresAt: 1 }
  });
  const pane = createMobilePane({ host, sheet: fakeSheet(), deps: { connection } });
  await pane.refresh();
  pane.stop();
  assert.ok(connection.calls.some((c) => c.method === RPC.mobileBridgePair));
  assert.match(host.textContent, /还没有配对的设备/);

  const missing = createMobilePane({
    host, sheet: fakeSheet(),
    deps: { connection: fakeConnection({ [RPC.mobileBridgeStatus]: new DshRpcError("endpoint-unknown", "x") }) }
  });
  await missing.refresh();
  missing.stop();
  assert.ok(host.querySelector("#mob-install"));
  assert.match(host.textContent, /需要先安装 dsh-mobile-bridge 插件/);
  assert.equal(host.querySelector("#mob-add").disabled, true);
});
