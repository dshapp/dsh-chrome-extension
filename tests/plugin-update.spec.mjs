/**
 * 设置页「浏览器」「移动端访问」的插件更新:已装版本以宿主 listBundles 为准,最新版问 npm
 * registry 的 dist-tags.latest;有新版时页顶给一行「更新」,一键 installBundle(name@latest)
 * 并保留启停,宿主答 restart-required 时重启服务,重启不了就说"重启后生效"。
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
const {
  installedFromRegistry, fetchLatestVersion, createPluginUpdate, serverRestarter, UPDATE_REGISTRIES
} = await import("../src/features/settings/plugin-update.js");
const { pluginUpdateSection } = await import("../src/app/sidepanel/settings/plugin-update-row.js");
const { createMobilePane } = await import("../src/app/sidepanel/settings/mobile-pane.js");
const { createBrowserPane } = await import("../src/app/sidepanel/settings/browser-pane.js");

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function bundle(name, patch = {}) {
  return { name, installed: true, enabled: true, version: "0.3.13", source: name + "@^0.3.13", ...patch };
}

/// 假 plugin-manager-service:记下每次装包。
function fakeManager({ bundles, install = { application: "restart-required" } }) {
  const installs = [];
  return {
    installs,
    async pluginBundles() { if (bundles instanceof Error) throw bundles; return bundles; },
    async installBundle(spec, options) {
      installs.push({ spec, options });
      if (install instanceof Error) throw install;
      return install;
    }
  };
}

test("installedFromRegistry:只认按版本范围从 registry 装的", () => {
  assert.equal(installedFromRegistry(bundle("dsh-chrome-control")), true);
  assert.equal(installedFromRegistry(bundle("dsh-chrome-control", { source: "dsh-chrome-control@0.3.13" })), true);
  assert.equal(installedFromRegistry(bundle("dsh-mobile-bridge", { source: "link:/Users/me/dsh-mobile-bridge" })), false);
  assert.equal(installedFromRegistry(bundle("x", { source: "x@file:/tmp/x.tgz" })), false);
  assert.equal(installedFromRegistry(bundle("x", { source: "x@npm:y@1" })), false);
  assert.equal(installedFromRegistry(bundle("x", { source: "github:me/x" })), false);
  // 随安装本体附带的包没有 source:不归这一页更新。
  assert.equal(installedFromRegistry(bundle("x", { source: undefined })), false);
});

test("fetchLatestVersion:问 dist-tags,官方源不通换 npmmirror,都不通给 null", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.startsWith(UPDATE_REGISTRIES[0])) throw new TypeError("offline");
    return { ok: true, json: async () => ({ latest: "0.3.14", next: "0.4.0-rc.1" }) };
  };
  assert.equal(await fetchLatestVersion("dsh-chrome-control", { fetchImpl }), "0.3.14");
  assert.deepEqual(urls, [
    "https://registry.npmjs.org/-/package/dsh-chrome-control/dist-tags",
    "https://registry.npmmirror.com/-/package/dsh-chrome-control/dist-tags"
  ]);
  assert.equal(await fetchLatestVersion("@s/p", { fetchImpl: async (url) => { urls.push(url); return { ok: false }; } }), null);
  assert.ok(urls.at(-1).endsWith("/-/package/@s%2fp/dist-tags"));
  // 回包里 latest 不是确切版本号就不当真。
  assert.equal(await fetchLatestVersion("x", { fetchImpl: async () => ({ ok: true, json: async () => ({ latest: "beta" }) }) }), null);
});

test("check:有新版才 available;本地链接装的、没装的、registry 问不到的都不提示", async () => {
  const name = "dsh-chrome-control";
  const ready = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)] }), fetchLatest: async () => "0.3.14" });
  await ready.check();
  assert.equal(ready.available, true);
  assert.equal(ready.visible, true);
  assert.deepEqual([ready.state.installed, ready.state.latest], ["0.3.13", "0.3.14"]);

  const same = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)] }), fetchLatest: async () => "0.3.13" });
  await same.check();
  assert.equal(same.visible, false);

  // 降级(registry 的 latest 比已装的旧)不是更新。
  const older = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name, { version: "0.4.0" })] }), fetchLatest: async () => "0.3.14" });
  await older.check();
  assert.equal(older.available, false);

  let asked = 0;
  const linked = createPluginUpdate({
    name, pluginManager: fakeManager({ bundles: [bundle(name, { source: "link:/dev/" + name })] }),
    fetchLatest: async () => { asked += 1; return "9.9.9"; }
  });
  await linked.check();
  const missing = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [] }), fetchLatest: async () => { asked += 1; return "9.9.9"; } });
  await missing.check();
  assert.equal(asked, 0, "不是从 registry 装的就不该去问 registry");
  assert.equal(linked.visible || missing.visible, false);

  const offline = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)] }), fetchLatest: async () => null });
  await offline.check();
  assert.equal(offline.visible, false);
});

test("update:装 name@latest 并保留启停;restart-required 时重启,重启不了就记下要重启", async () => {
  const name = "dsh-mobile-bridge";
  const manager = fakeManager({ bundles: [bundle(name, { enabled: false })] });
  let restarts = 0;
  const update = createPluginUpdate({ name, pluginManager: manager, fetchLatest: async () => "0.3.14", restart: async () => { restarts += 1; return true; } });
  await update.check();
  await update.update();
  assert.equal(manager.installs.length, 1);
  assert.equal(manager.installs[0].spec, "dsh-mobile-bridge@0.3.14");
  assert.equal(manager.installs[0].options.enabled, false);
  assert.match(manager.installs[0].options.requestId, /^plugin-update-/);
  assert.equal(restarts, 1);
  assert.equal(update.available, false);
  assert.equal(update.state.updated, "0.3.14");
  assert.equal(update.state.restartRequired, false);

  const stuck = createPluginUpdate({ name, pluginManager: fakeManager({ bundles: [bundle(name)] }), fetchLatest: async () => "0.3.14", restart: async () => false });
  await stuck.check();
  await stuck.update();
  assert.equal(stuck.state.restartRequired, true);

  // 宿主当场生效(applied)就不必重启。
  let applied = 0;
  const live = createPluginUpdate({
    name, pluginManager: fakeManager({ bundles: [bundle(name)], install: { application: "applied" } }),
    fetchLatest: async () => "0.3.14", restart: async () => { applied += 1; return true; }
  });
  await live.check();
  await live.update();
  assert.equal(applied, 0);
  assert.equal(live.state.updated, "0.3.14");
});

test("update 遇到 HMR 宿主答 already-installed:先卸再装,当场生效不重启;新版装不上就把原版本装回去", async () => {
  const name = "dsh-chrome-control";
  const calls = [];
  let restarts = 0;
  const hmr = (installs) => ({
    async pluginBundles() { return [bundle(name)]; },
    async installBundle(spec, options) { calls.push(["install", spec, options.enabled]); return installs.shift(); },
    async removeBundle(target) { calls.push(["remove", target]); return { application: "applied" }; }
  });
  const update = createPluginUpdate({
    name, fetchLatest: async () => "0.3.15", restart: async () => { restarts += 1; return true; },
    pluginManager: hmr([{ application: "failed", error: { code: "already-installed" } }, { application: "applied" }])
  });
  await update.check();
  await update.update();
  assert.deepEqual(calls, [
    ["install", "dsh-chrome-control@0.3.15", true],
    ["remove", "dsh-chrome-control"],
    ["install", "dsh-chrome-control@0.3.15", true]
  ]);
  assert.equal(restarts, 0);
  assert.equal(update.state.updated, "0.3.15");
  assert.equal(update.state.error, "");

  calls.length = 0;
  const broken = createPluginUpdate({
    name, fetchLatest: async () => "0.3.15",
    pluginManager: hmr([
      { application: "failed", error: { code: "already-installed" } },
      { application: "failed", error: { code: "incompatible-version", diagnostic: "needs dsh 0.3" } },
      { application: "applied" }
    ])
  });
  await broken.check();
  await broken.update();
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ["install", "dsh-chrome-control@0.3.15"],
    ["remove", "dsh-chrome-control"],
    ["install", "dsh-chrome-control@0.3.15"],
    ["install", "dsh-chrome-control@0.3.13"]
  ]);
  assert.equal(broken.state.error, "needs dsh 0.3");
  assert.equal(broken.state.updated, null);

  // 卸不掉的别的原因:原样报出来,停用的开关拨回去。
  calls.length = 0;
  const refused = createPluginUpdate({
    name, fetchLatest: async () => "0.3.15",
    pluginManager: { ...hmr([{ application: "failed", error: { code: "already-installed" } }]),
      async removeBundle(target) { calls.push(["remove", target]); return { application: "failed", error: { code: "not-removable" } }; },
      async setBundleEnabled(target, enabled) { calls.push(["enable", target, enabled]); return { application: "applied" }; } }
  });
  await refused.check();
  await refused.update();
  assert.deepEqual(calls.at(-1), ["enable", "dsh-chrome-control", true]);
  assert.equal(refused.state.error, "not-removable");
  assert.equal(refused.state.restartFirst, false);
});

test("插件正在运行卸不掉(bundle-in-use):开关拨回去,改成「重启服务并更新」,重启后重读再先卸再装", async () => {
  const name = "dsh-chrome-control";
  const calls = [];
  let hostRestarted = false;
  let restartWorks = false;
  const manager = {
    async pluginBundles() { return [bundle(name, { version: "0.3.13" })]; },
    async installBundle(spec) {
      calls.push(["install", spec]);
      return calls.filter((c) => c[0] === "install").length === 1 || !hostRestarted
        ? { application: "failed", error: { code: "already-installed" } }
        : { application: "applied" };
    },
    async removeBundle(target) {
      calls.push(["remove", target]);
      return hostRestarted ? { application: "applied" } : { application: "failed", error: { code: "bundle-in-use" } };
    },
    async setBundleEnabled(target, enabled) { calls.push(["enable", target, enabled]); return { application: "restart-required" }; }
  };
  const update = createPluginUpdate({
    name, pluginManager: manager, fetchLatest: async () => "0.3.15",
    restart: async () => { calls.push(["restart"]); if (restartWorks) hostRestarted = true; return restartWorks; }
  });
  await update.check();
  await update.update();
  assert.deepEqual(calls, [["install", "dsh-chrome-control@0.3.15"], ["remove", "dsh-chrome-control"], ["enable", "dsh-chrome-control", true]]);
  assert.equal(update.state.restartFirst, true);
  assert.equal(update.state.error, "");
  let html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /无法在线替换/);
  assert.match(html, /重启服务并更新/);

  // 这台机器上重启不了:请用户手动重启,按钮还在。
  calls.length = 0;
  await update.update();
  assert.deepEqual(calls, [["restart"]]);
  assert.equal(update.state.restartFailed, true);
  html = pluginUpdateSection(update, { name, buttonId: "u" });
  assert.match(html, /请手动重启/);
  assert.match(html, /id="u"/);

  calls.length = 0;
  restartWorks = true;
  await update.update();
  assert.deepEqual(calls, [
    ["restart"],
    ["install", "dsh-chrome-control@0.3.15"],
    ["remove", "dsh-chrome-control"],
    ["install", "dsh-chrome-control@0.3.15"]
  ]);
  assert.equal(update.state.updated, "0.3.15");
  assert.equal(update.state.restartFirst, false);
});

test("update 失败:原样保留宿主 / pnpm 的说法,按钮还在可以再试", async () => {
  const name = "dsh-chrome-control";
  const failed = createPluginUpdate({
    name, fetchLatest: async () => "0.3.14",
    pluginManager: fakeManager({ bundles: [bundle(name)], install: { application: "failed", error: { code: "incompatible-version", diagnostic: "needs dsh 0.3" } } })
  });
  await failed.check();
  await failed.update();
  assert.equal(failed.state.error, "needs dsh 0.3");
  assert.equal(failed.available, true);
  const html = pluginUpdateSection(failed, { name, buttonId: "u" });
  assert.match(html, /needs dsh 0\.3/);
  assert.match(html, /id="u"/);

  const thrown = createPluginUpdate({ name, fetchLatest: async () => "0.3.14", pluginManager: fakeManager({ bundles: [bundle(name)], install: new Error("socket hang up") }) });
  await thrown.check();
  await thrown.update();
  assert.equal(thrown.state.error, "socket hang up");
  assert.equal(thrown.state.updating, false);
});

test("serverRestarter:started 才算重启成功,没有 serverOps 或抛错都是 false", async () => {
  assert.equal(await serverRestarter(null)(), false);
  assert.equal(await serverRestarter({ restart: async () => ({ started: true }) })(), true);
  assert.equal(await serverRestarter({ restart: async () => ({ started: false }) })(), false);
  assert.equal(await serverRestarter({ restart: async () => { throw new Error("no daemon"); } })(), false);
});

test("pluginUpdateSection:有新版给版本对比 + 更新按钮;更新中换成进度;更新完说清是否要重启", async () => {
  const name = "dsh-chrome-control";
  let release;
  const manager = fakeManager({ bundles: [bundle(name)] });
  manager.installBundle = (spec) => new Promise((resolve) => { release = resolve; manager.installs.push({ spec }); });
  const update = createPluginUpdate({ name, pluginManager: manager, fetchLatest: async () => "0.3.14", restart: async () => false });
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
  release({ application: "restart-required" });
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

/// 页面里的 check() 用真的 fetch 问 registry:测试里换成固定回包。
function stubRegistry(latest) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ latest }) });
  return () => { globalThis.fetch = original; };
}

test("移动端访问页:dsh-mobile-bridge 有新版时页顶一行更新,点了装新版、重启服务、重读桥接", async () => {
  const restore = stubRegistry("0.3.7");
  try {
    const status = { bridgeKey: "k", connected: true, disabled: false, pairing: { url: "dshm://x#t", expiresAt: 1 }, devices: [] };
    const connection = fakeConnection({
      [RPC.mobileBridgeStatus]: status,
      [RPC.pluginManagerListBundles]: [bundle("dsh-mobile-bridge", { version: "0.3.6", source: "dsh-mobile-bridge@^0.3.6" })],
      [RPC.pluginManagerInstallBundle]: { application: "restart-required" }
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
    const statusReads = connection.calls.filter((c) => c.method === RPC.mobileBridgeStatus).length;
    host.querySelector("#mob-plugin-update").click();
    await flush();
    const install = connection.calls.find((c) => c.method === RPC.pluginManagerInstallBundle);
    assert.equal(install.args.spec, "dsh-mobile-bridge@0.3.7");
    assert.equal(install.args.options.enabled, true);
    assert.equal(restarted, 1);
    assert.ok(connection.calls.filter((c) => c.method === RPC.mobileBridgeStatus).length > statusReads, "更新完要重读桥接");
    assert.match(host.textContent, /已更新到 0\.3\.7/);
    assert.equal(host.querySelector("#mob-plugin-update"), null);
  } finally {
    restore();
  }
});

test("浏览器页:dsh-chrome-control 有新版时页顶一行更新,点了装新版、重启服务,网页搜索那一段照常", async () => {
  const restore = stubRegistry("0.3.14");
  try {
    const connection = fakeConnection({
      [RPC.pluginManagerListBundles]: [bundle("dsh-chrome-control")],
      [RPC.pluginManagerInstallBundle]: { application: "restart-required" }
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
    const install = connection.calls.find((c) => c.method === RPC.pluginManagerInstallBundle);
    assert.equal(install.args.spec, "dsh-chrome-control@0.3.14");
    assert.equal(restarted, 1);
    assert.match(host.querySelector("#set-browser-update").textContent, /已更新到 0\.3\.14/);
    assert.ok(host.querySelector("#set-web-search-engine"));
    assert.ok(engine, "网页搜索那一段照常在");
  } finally {
    restore();
  }
});
