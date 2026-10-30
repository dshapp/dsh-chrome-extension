/**
 * 设置页「浏览器」「移动端访问」的插件更新:已装版本与能否更新以宿主 listBundles 为准(updatable),
 * 新版本问宿主 listVersions,换版交给宿主 updateBundle(卸旧装新、失败回装都在宿主);有新版时页顶给
 * 一行「更新」,保留启停,宿主答 restart-required 时重启服务,重启不了就说"重启后生效"。
 * 对齐 Mac PluginUpdateChecker。
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
globalThis.CSS = dom.window.CSS ?? { escape: (value) => String(value) };

const { setLang } = await import("../src/shared/i18n.js");
setLang("zh");
const { RPC } = await import("../src/platform/dsh/rpc-methods.js");
const { pickUpdate, createPluginUpdate, serverRestarter } = await import("../src/features/settings/plugin-update.js");
const { pluginUpdateSection } = await import("../src/app/sidepanel/settings/plugin-update-row.js");
const { createMobilePane } = await import("../src/app/sidepanel/settings/mobile-pane.js");
const { createBrowserPane } = await import("../src/app/sidepanel/settings/browser-pane.js");

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function bundle(name, patch = {}) {
  return { name, installed: true, enabled: true, updatable: true, version: "0.3.13", source: name + "@^0.3.13", ...patch };
}

/// 宿主 listVersions 的回包:列出的版本都比已装的新。
function listed(versions, registry = null) {
  return {
    status: "listed", installed: "0.3.13", registry, attempts: [], omitted: 0,
    versions: versions.map((v) => typeof v === "string" ? { version: v, tags: [], prerelease: false, bundle: true } : v)
  };
}

/// 宿主 updateBundle 的回包。
function outcome(application, { step = "install", error } = {}) {
  return { from: "0.3.13", to: "x", step, result: { application, ...(error ? { error } : {}) } };
}

/// 假 plugin-manager-service:记下每次列版本、换版与开关。
function fakeManager({ bundles, versions = listed(["0.3.14"]), update = outcome("restart-required") }) {
  const calls = [];
  return {
    calls,
    async pluginBundles() { if (bundles instanceof Error) throw bundles; return bundles; },
    async listVersions(name) { calls.push(["list", name]); return versions; },
    async updateBundle(name, version, options) {
      calls.push(["update", name, version, options]);
      const value = typeof update === "function" ? update() : update;
      if (value instanceof Error) throw value;
      return value;
    },
    async setBundleEnabled(name, enabled) { calls.push(["enable", name, enabled]); return { application: "applied" }; }
  };
}

test("pickUpdate:latest 标签优先,否则最新稳定版;跳过预发布、弃用、不兼容与没声明 bundle 的", () => {
  assert.deepEqual(
    pickUpdate(listed(["0.4.0", { version: "0.3.20", tags: ["latest"], prerelease: false, bundle: true }], "https://r/")),
    { version: "0.3.20", registry: "https://r/" }
  );
  assert.deepEqual(pickUpdate(listed(["0.3.15", "0.3.14"])), { version: "0.3.15", registry: null });
  assert.equal(pickUpdate(listed([
    { version: "0.4.0-rc.1", tags: ["next"], prerelease: true, bundle: true },
    { version: "0.3.16", tags: [], prerelease: false, bundle: true, deprecated: "broken" },
    { version: "0.3.15", tags: [], prerelease: false, bundle: true, incompatible: { name: "x" } },
    { version: "0.3.14", tags: [], prerelease: false, bundle: false }
  ])), null);
  assert.equal(pickUpdate({ status: "refused", problem: "network", reason: "offline", attempts: [] }), null);
  assert.equal(pickUpdate(null), null);
});

test("check:宿主列出新版才 available;不可更新(本地链接等)、没装的不去问宿主,宿主答不上也不提示", async () => {
  const name = "dsh-chrome-control";
  const ready = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)] }) });
  await ready.check();
  assert.equal(ready.available, true);
  assert.equal(ready.visible, true);
  assert.deepEqual([ready.state.installed, ready.state.latest], ["0.3.13", "0.3.14"]);

  const none = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)], versions: listed([]) }) });
  await none.check();
  assert.equal(none.visible, false);

  const linkedManager = fakeManager({ bundles: [bundle(name, { updatable: false, source: "link:/dev/" + name })] });
  const linked = createPluginUpdate({ name, pluginManager: linkedManager });
  await linked.check();
  const missingManager = fakeManager({ bundles: [] });
  const missing = createPluginUpdate({ name, pluginManager: missingManager });
  await missing.check();
  assert.equal(linkedManager.calls.length + missingManager.calls.length, 0, "不能更新的就不该去问宿主");
  assert.equal(linked.visible || missing.visible, false);

  const refused = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)], versions: { status: "refused", problem: "network", reason: "x", attempts: [] } }) });
  await refused.check();
  assert.equal(refused.visible, false);
});

test("update:交给宿主 updateBundle,带上列版本时答出的源;restart-required 时重启,重启不了就记下要重启", async () => {
  const name = "dsh-mobile-bridge";
  const manager = fakeManager({ bundles: [bundle(name, { enabled: false })], versions: listed(["0.3.14"], "https://registry.npmmirror.com/") });
  let restarts = 0;
  const update = createPluginUpdate({ name, pluginManager: manager, restart: async () => { restarts += 1; return true; } });
  await update.check();
  await update.update();
  const call = manager.calls.find((c) => c[0] === "update");
  assert.deepEqual(call.slice(0, 3), ["update", name, "0.3.14"]);
  assert.equal(call[3].registry, "https://registry.npmmirror.com/");
  assert.match(call[3].requestId, /^plugin-update-/);
  assert.equal(restarts, 1);
  assert.equal(update.available, false);
  assert.equal(update.state.updated, "0.3.14");
  assert.equal(update.state.restartRequired, false);

  const stuck = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)] }), restart: async () => false });
  await stuck.check();
  await stuck.update();
  assert.equal(stuck.state.restartRequired, true);

  // 宿主当场生效(applied)就不必重启。
  let applied = 0;
  const live = createPluginUpdate({
    name, pluginManager: fakeManager({ bundles: [bundle(name)], update: outcome("applied") }),
    restart: async () => { applied += 1; return true; }
  });
  await live.check();
  await live.update();
  assert.equal(applied, 0);
  assert.equal(live.state.updated, "0.3.14");
});

test("卸旧版失败:开关拨回去;正在运行(bundle-in-use)改成「重启服务并更新」,重启后重读再交给宿主", async () => {
  const name = "dsh-chrome-control";
  let hostRestarted = false;
  let restartWorks = false;
  let restartReason = false;
  const manager = fakeManager({
    bundles: [bundle(name)],
    update: () => hostRestarted ? outcome("applied") : outcome("failed", { step: "remove", error: { code: "bundle-in-use" } })
  });
  const update = createPluginUpdate({
    name, pluginManager: manager,
    restart: async () => { manager.calls.push(["restart"]); if (restartWorks) hostRestarted = true; return restartWorks || restartReason; }
  });
  await update.check();
  await update.update();
  assert.deepEqual(manager.calls.slice(1).map((c) => c.slice(0, 3)), [["update", name, "0.3.14"], ["enable", name, true]]);
  assert.equal(update.state.restartFirst, true);
  assert.equal(update.state.error, "");
  let html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /无法在线替换/);
  assert.match(html, /重启服务并更新/);

  // 这台机器上重启不了:请用户手动重启,按钮还在。
  manager.calls.length = 0;
  await update.update();
  assert.deepEqual(manager.calls, [["restart"]]);
  assert.equal(update.state.restartFailed, true);
  html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /请手动重启/);
  assert.match(html, /id="u"/);

  // 重启了但新服务没起来:把原因说出来,而不是只说"重启不了"。
  restartReason = "新服务没有启动，日志在 /tmp/dsh-web.log。";
  await update.update();
  assert.equal(update.state.restartError, restartReason);
  html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /重启后没能起来：新服务没有启动，日志在 \/tmp\/dsh-web\.log。/);
  restartReason = false;

  manager.calls.length = 0;
  restartWorks = true;
  await update.update();
  assert.deepEqual(manager.calls.map((c) => c.slice(0, 3)), [["restart"], ["list", name], ["update", name, "0.3.14"]]);
  assert.equal(update.state.updated, "0.3.14");
  assert.equal(update.state.restartFirst, false);

  // 卸不掉的别的原因:原样报出来,停用的开关拨回去,不改成重启。
  const refusedManager = fakeManager({ bundles: [bundle(name)], update: outcome("failed", { step: "remove", error: { code: "not-removable" } }) });
  const refused = createPluginUpdate({ name, pluginManager: refusedManager });
  await refused.check();
  await refused.update();
  assert.deepEqual(refusedManager.calls.at(-1), ["enable", name, true]);
  assert.match(refused.state.error, /\S/);
  assert.equal(refused.state.restartFirst, false);
});

test("update 失败:原样保留宿主 / pnpm 的说法,按钮还在可以再试", async () => {
  const name = "dsh-chrome-control";
  const failed = createPluginUpdate({
    name,
    pluginManager: fakeManager({ bundles: [bundle(name)], update: outcome("failed", { error: { code: "incompatible-version", diagnostic: "needs dsh 0.3" } }) })
  });
  await failed.check();
  await failed.update();
  assert.equal(failed.state.error, "needs dsh 0.3");
  assert.equal(failed.available, true);
  const html = pluginUpdateSection(failed, { name, buttonId: "u" });
  assert.match(html, /needs dsh 0\.3/);
  assert.match(html, /id="u"/);

  const thrown = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)], update: new Error("socket hang up") }) });
  await thrown.check();
  await thrown.update();
  assert.equal(thrown.state.error, "socket hang up");
  assert.equal(thrown.state.updating, false);
});

test("serverRestarter:started 才算重启成功,否则带回原因(说不出时为空串)", async () => {
  assert.equal(await serverRestarter(null)(), "");
  assert.equal(await serverRestarter({ restart: async () => ({ started: true }) })(), true);
  assert.equal(await serverRestarter({ restart: async () => ({ started: false }) })(), "");
  // 旧服务停了、新服务没起来:把日志位置说出来。
  assert.equal(await serverRestarter({ restart: async () => ({ stopped: true, started: false, log: "/tmp/dsh-web.log" }) })(),
    "新服务没有启动，日志在 /tmp/dsh-web.log。");
  assert.equal(await serverRestarter({ restart: async () => { throw new Error("no daemon"); } })(), "no daemon");
});

test("pluginUpdateSection:有新版给版本对比 + 更新按钮;更新中换成进度;更新完说清是否要重启", async () => {
  const name = "dsh-chrome-control";
  let release;
  const manager = fakeManager({ bundles: [bundle(name)], update: () => new Promise((resolve) => { release = resolve; }) });
  const update = createPluginUpdate({ name, pluginManager: manager, restart: async () => false });
  assert.equal(pluginUpdateSection(update, { name, buttonId: "u" }), "");
  await update.check();
  let html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /有更新/);
  assert.match(html, /当前版本 0\.3\.13，最新版本 0\.3\.14/);
  assert.match(html, /id="u"/);
  const running = update.update();
  html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /正在更新/);
  assert.doesNotMatch(html, /id="u"/);
  await flush();
  release(outcome("restart-required"));
  await running;
  html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /已更新到 0\.3\.14，重启 DSH Server 后生效/);
  assert.match(html, /需要重启/);
});

/// 假 connection:按方法名回包。
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

test("移动端访问页:dsh-mobile-bridge 有新版时页顶一行更新,点了交给宿主换版、重启服务、重读桥接", async () => {
  const status = { bridgeKey: "k", connected: true, disabled: false, pairing: { url: "dshm://x#t", expiresAt: 1 }, devices: [] };
  const connection = fakeConnection({
    [RPC.mobileBridgeStatus]: status,
    [RPC.pluginManagerListBundles]: [bundle("dsh-mobile-bridge", { version: "0.3.6", source: "dsh-mobile-bridge@^0.3.6" })],
    [RPC.pluginManagerListVersions]: listed(["0.3.7"]),
    [RPC.pluginManagerUpdateBundle]: outcome("restart-required")
  });
  let restarted = 0;
  const host = document.getElementById("pane");
  const sheet = { open() {}, close() {}, owns() { return true; }, setActions() {} };
  const pane = createMobilePane({ host, sheet, deps: { connection }, serverOps: { restart: async () => { restarted += 1; return { started: true }; } } });
  await pane.refresh();
  await flush();
  pane.stop();
  assert.match(host.textContent, /dsh-mobile-bridge/);
  assert.match(host.textContent, /当前版本 0\.3\.6，最新版本 0\.3\.7/);
  const listCall = connection.calls.find((c) => c.method === RPC.pluginManagerListVersions);
  assert.deepEqual(listCall.args, { name: "dsh-mobile-bridge", options: {} });
  const statusReads = connection.calls.filter((c) => c.method === RPC.mobileBridgeStatus).length;
  host.querySelector("#mob-plugin-update").click();
  await flush();
  const update = connection.calls.find((c) => c.method === RPC.pluginManagerUpdateBundle);
  assert.equal(update.args.name, "dsh-mobile-bridge");
  assert.equal(update.args.version, "0.3.7");
  assert.equal(update.args.options.registry, null);
  assert.equal(connection.calls.some((c) => c.method === RPC.pluginManagerInstallBundle || c.method === RPC.pluginManagerRemoveBundle), false);
  assert.equal(restarted, 1);
  assert.ok(connection.calls.filter((c) => c.method === RPC.mobileBridgeStatus).length > statusReads, "更新完要重读桥接");
  assert.match(host.textContent, /已更新到 0\.3\.7/);
  assert.equal(host.querySelector("#mob-plugin-update"), null);
});

test("浏览器页:dsh-chrome-control 有新版时页顶一行更新,点了交给宿主换版、重启服务,网页搜索那一段照常", async () => {
  const connection = fakeConnection({
    [RPC.pluginManagerListBundles]: [bundle("dsh-chrome-control")],
    [RPC.pluginManagerListVersions]: listed(["0.3.14"]),
    [RPC.pluginManagerUpdateBundle]: outcome("restart-required")
  });
  const settingsService = {
    async describe() {
      return { writable: true, namespaces: [{ ns: "web", revision: 1, value: {} }, { ns: "chrome-web-search", revision: 1, value: { engine: "bing" } }] };
    },
    async mutate() {}
  };
  let restarted = 0;
  const host = document.getElementById("pane");
  host.innerHTML = "";
  const pane = createBrowserPane({
    host, deps: { connection, formatErrorDetails: String }, settingsService,
    serverOps: { restart: async () => { restarted += 1; return { started: true }; } }
  });
  await pane.refresh();
  await flush();
  assert.match(host.querySelector("#set-browser-update").textContent, /dsh-chrome-control/);
  assert.match(host.textContent, /当前版本 0\.3\.13，最新版本 0\.3\.14/);
  const engine = host.querySelector("#set-web-search-engine");
  host.querySelector("#set-browser-plugin-update").click();
  await flush();
  pane.stop();
  const update = connection.calls.find((c) => c.method === RPC.pluginManagerUpdateBundle);
  assert.deepEqual([update.args.name, update.args.version], ["dsh-chrome-control", "0.3.14"]);
  assert.equal(restarted, 1);
  assert.match(host.querySelector("#set-browser-update").textContent, /已更新到 0\.3\.14/);
  assert.ok(host.querySelector("#set-web-search-engine"));
  assert.ok(engine, "网页搜索那一段照常在");
});
