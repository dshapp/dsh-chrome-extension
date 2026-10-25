/**
 * 设置页「浏览器」→「网页搜索」:开关即 web.searchProvider 是否选中 chrome-browser,
 * 关闭是删掉覆盖(回到默认后端)而不是写回某个具体后端;引擎写 chrome-web-search.engine。
 * 插件太旧(缺命名空间)时只给一行更新提示,只读文档时控件全部禁用。
 * Agent 浏览器控制(CDP 桥)的状态灯也在这一页,服务端页不再画它。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><section id="pane"></section></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CSS = dom.window.CSS ?? { escape: (value) => String(value) };

const { setLang } = await import("../src/shared/i18n.js");
setLang?.("zh");
const { createBrowserPane } = await import("../src/app/sidepanel/settings/browser-pane.js");
const { readWebSearchSettings, webSearchEngineOps } = await import("../src/features/settings/web-search-settings.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/// 一个按 mutate 改值的假宿主,记下每次写入。
function fakeHost({ searchProvider = "deepseek-official", engine, rowPresent = true, writable = true } = {}) {
  const state = { web: { searchProvider, fetchProvider: "http" }, row: engine === undefined ? {} : { engine } };
  const writes = [];
  const service = {
    async describe() {
      const namespaces = [{ ns: "web", revision: 1, value: { ...state.web } }];
      if (rowPresent) namespaces.push({ ns: "chrome-web-search", revision: 1, value: { engine: state.row.engine ?? "google" } });
      return { writable, namespaces };
    },
    async mutate(ns, ops, revision) {
      writes.push({ ns, ops, revision });
      const target = ns === "web" ? state.web : state.row;
      for (const op of ops) {
        if (op.op === "set") target[op.path[0]] = op.value;
        else delete target[op.path[0]];
      }
    }
  };
  return { service, writes, state };
}

/// 每个 pane 的桥轮询都会一直跑到 stop();共用同一个 #pane,所以挂新的之前先停掉旧的。
const mounted = [];
function stopAll() {
  while (mounted.length) mounted.pop().stop();
}

async function mount(host) {
  stopAll();
  const node = document.getElementById("pane");
  node.innerHTML = "";
  const pane = createBrowserPane({ host: node, deps: { formatErrorDetails: (e) => String(e) }, settingsService: host.service });
  mounted.push(pane);
  await pane.refresh();
  return node;
}

function change(element, patch) {
  Object.assign(element, patch);
  element.dispatchEvent(new window.Event("change"));
}

test("默认关闭、引擎谷歌", async () => {
  const node = await mount(fakeHost());
  assert.equal(node.querySelector("#set-web-search").checked, false);
  assert.equal(node.querySelector("#set-web-search-engine").value, "google");
  assert.deepEqual([...node.querySelectorAll("#set-web-search-engine option")].map((o) => o.textContent),
    ["谷歌", "必应", "百度", "搜狗", "头条搜索"]);
});

test("打开写 searchProvider=chrome-browser,关闭删掉覆盖", async () => {
  const host = fakeHost();
  let node = await mount(host);
  change(node.querySelector("#set-web-search"), { checked: true });
  await flush(); await flush();
  assert.deepEqual(host.writes.at(-1), { ns: "web", ops: [{ op: "set", path: ["searchProvider"], value: "chrome-browser" }], revision: 1 });
  node = document.getElementById("pane");
  assert.equal(node.querySelector("#set-web-search").checked, true);
  change(node.querySelector("#set-web-search"), { checked: false });
  await flush(); await flush();
  assert.deepEqual(host.writes.at(-1).ops, [{ op: "unset", path: ["searchProvider"] }]);
  assert.equal(host.state.web.searchProvider, undefined);
  assert.equal(host.state.web.fetchProvider, "http");
});

test("选引擎写 chrome-web-search.engine", async () => {
  const host = fakeHost({ searchProvider: "chrome-browser" });
  const node = await mount(host);
  change(node.querySelector("#set-web-search-engine"), { value: "baidu" });
  await flush(); await flush();
  assert.deepEqual(host.writes.at(-1), { ns: "chrome-web-search", ops: [{ op: "set", path: ["engine"], value: "baidu" }], revision: 1 });
  assert.equal(document.querySelector("#set-web-search-engine").value, "baidu");
});

test("插件缺 chrome-web-search 命名空间时只提示更新", async () => {
  const node = await mount(fakeHost({ rowPresent: false }));
  assert.equal(node.querySelector("#set-web-search"), null);
  assert.match(node.textContent, /更新 Chrome 控制插件/);
});

test("只读文档时控件禁用且不写", async () => {
  const host = fakeHost({ writable: false });
  const node = await mount(host);
  assert.equal(node.querySelector("#set-web-search").disabled, true);
  assert.equal(node.querySelector("#set-web-search-engine").disabled, true);
});

test("桥状态行在浏览器页:没有 worker 时不画,有 worker 时按状态画,stop 后停止轮询", async () => {
  const node = await mount(fakeHost());
  assert.equal(node.querySelector("#set-bridge-state"), null);
  stopAll();

  let calls = 0;
  let state = { connected: true, status: "connected", url: "ws://127.0.0.1:37086/chrome/ws" };
  globalThis.chrome = { runtime: { sendMessage: async () => { calls++; return state; } } };
  try {
    const host = document.getElementById("pane");
    host.innerHTML = "";
    const pane = createBrowserPane({ host, deps: { formatErrorDetails: String }, settingsService: fakeHost().service });
    await pane.refresh();
    await flush();
    assert.match(host.querySelector("#set-bridge-state").textContent, /已连接/);
    assert.match(host.querySelector("#set-bridge-detail").textContent, /37086/);
    // 状态变化只补那一行,开关节点保持原样。
    const toggleNode = host.querySelector("#set-web-search");
    state = { connected: false, status: "unresponsive", url: state.url };
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.match(host.querySelector("#set-bridge-state").textContent, /无响应/);
    assert.equal(host.querySelector("#set-web-search"), toggleNode);
    pane.stop();
    const stopped = calls;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls, stopped);
  } finally {
    delete globalThis.chrome;
  }
});

test("服务端页不再有桥状态行", async () => {
  stopAll();
  const { createServerPane } = await import("../src/app/sidepanel/settings/server-pane.js");
  globalThis.chrome = { runtime: { sendMessage: async () => ({ connected: true, status: "connected", url: "ws://x" }) } };
  try {
    const host = document.getElementById("pane");
    host.innerHTML = "";
    const pane = createServerPane({
      host,
      deps: { connection: { streamState: "connected", baseUrl: "http://127.0.0.1:3080" }, DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting" } },
      probe: async () => null
    });
    await pane.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(host.querySelector("#set-bridge-state"), null);
    pane.stop();
  } finally {
    delete globalThis.chrome;
  }
});

test("未知引擎值按谷歌显示,写入时拒绝未知引擎", () => {
  stopAll();
  const namespaces = new Map([["web", { value: {} }], ["chrome-web-search", { value: { engine: "yahoo" } }]]);
  assert.deepEqual(readWebSearchSettings(namespaces), { enabled: false, engine: "google" });
  assert.throws(() => webSearchEngineOps("yahoo"), RangeError);
});
