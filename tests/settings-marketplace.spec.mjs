/**
 * 插件市场列表的渲染契约。
 *
 * 这里盯的是三件从真实 HTML 才看得出来的事:
 *   1. 分组与计数 —— 官方组里既有随附 bundle,也有本页可配置的官方卡片;
 *      已安装组只放其余装上的 bundle,不能把官方那几项再列一遍。
 *   2. readOnlyReason 的开关必须 disabled 并写出原因 —— 画一个能点但一定会
 *      失败的开关,用户会以为是产品坏了。
 *   3. 卸载只在 removable 且 installed 时出现;卡片行是可点击的整行。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { createMarketplaceView } = await import("../src/app/sidepanel/settings/plugin-marketplace.js");

const FLUSH = () => new Promise((resolve) => setTimeout(resolve, 0));

/// 造一个市场视图。bundles 通过设置的假 service 回给 refresh。
function mount({ bundles = [], entries = [] } = {}) {
  const host = document.getElementById("host");
  host.innerHTML = "";
  const service = {
    async pluginBundles() { return bundles; },
    async pluginEntries() { return entries; }
  };
  let view;
  view = createMarketplaceView({
    host, sheet: null, deps: { formatErrorDetails: (error) => String(error?.message ?? error) },
    settingsService: service, showToast: () => {}, settingsDialog: null,
    cards: [{ id: "bash", title: "plug.bashTitle", description: "plug.bashDescription" }],
    onOpenCard: () => {}, onInstalled: () => {}, onChange: () => view.paint(),
  });
  return { host, view };
}

test("官方组含随附 bundle 与可配置卡片,并给出计数", async () => {
  const { host, view } = mount({
    bundles: [
      { name: "dsh-agent-team", version: "1.2.3", description: "teams", enabled: true, installed: false, optional: true, removable: false },
      { name: "dsh-extra", version: "0.1.0", description: "extra", enabled: true, installed: true, optional: false, removable: true }
    ]
  });
  await view.refresh();
  const text = host.innerHTML;
  assert.match(text, /id="plug-count-official"/);
  assert.match(text, /id="plug-count-installed"/);
  assert.match(text, /dsh-agent-team/);
  assert.match(text, /dsh-extra/);
  // 版本以 v{version} 形态出现。
  assert.match(text, /v1\.2\.3/);
  // 可配置卡片渲染成可点击行。
  assert.match(text, /id="plug-card-row-bash"/);
  assert.match(text, /class="set-row clickable"/);
  // 随附但不可卸载的 bundle 不给删除按钮。
  assert.ok(!text.includes('id="plug-bundle-del-dsh-agent-team"'));
  assert.match(text, /id="plug-bundle-del-dsh-extra"/);
});

test("readOnlyReason 的开关禁用并就地写出原因", async () => {
  const { host, view } = mount({
    bundles: [{
      name: "dsh-core", version: "9.9.9", description: "core", enabled: true,
      installed: false, optional: true, removable: false, readOnlyReason: "management-required"
    }]
  });
  await view.refresh();
  const input = host.querySelector("#plug-bundle-dsh-core");
  assert.ok(input, "开关应存在");
  assert.equal(input.disabled, true);
  // 机器码翻成本地文案,而不是把 management-required 直接糊在界面上。
  assert.ok(host.textContent.includes("插件管理所需"), "应显示本地化的只读原因");
  assert.ok(!host.textContent.includes("management-required"));
});

test("空市场显示空态而不是一张空分组头", async () => {
  const { host, view } = mount({ bundles: [], cards: [] });
  // cards 用 mount 默认那张,所以这里手动清掉:直接用一个没有卡片的视图。
  host.innerHTML = "";
  const service = { async pluginBundles() { return []; }, async pluginEntries() { return []; } };
  let emptyView;
  emptyView = createMarketplaceView({
    host, sheet: null, deps: { formatErrorDetails: String }, settingsService: service,
    showToast: () => {}, settingsDialog: null, cards: [],
    onOpenCard: () => {}, onInstalled: () => {}, onChange: () => emptyView.paint()
  });
  await emptyView.refresh();
  assert.ok(host.textContent.includes("还没有安装任何插件"));
  assert.ok(!host.innerHTML.includes("set-group-header"));
});

test("读取失败时给出重试入口,而不是空列表", async () => {
  const host = document.getElementById("host");
  host.innerHTML = "";
  let failing;
  failing = createMarketplaceView({
    host, sheet: null, deps: { formatErrorDetails: (error) => "boom: " + error.message },
    settingsService: { async pluginBundles() { throw new Error("rpc down"); }, async pluginEntries() { return []; } },
    showToast: () => {}, settingsDialog: null, cards: [], onOpenCard: () => {}, onInstalled: () => {},
    onChange: () => failing.paint()
  });
  await failing.refresh();
  assert.match(host.innerHTML, /id="plug-market-retry"/);
  assert.ok(host.textContent.includes("boom: rpc down"));
});

test("变更结果就地显示:restart-required 不写成成功", async () => {
  const host = document.getElementById("host");
  host.innerHTML = "";
  let enabled = true;
  const service = {
    async pluginBundles() {
      return [{ name: "dsh-extra", version: "1.0.0", description: "x", enabled, installed: true, optional: false, removable: true }];
    },
    async pluginEntries() { return []; },
    async setBundleEnabled(_name, next) {
      enabled = next;
      return { changed: true, application: "restart-required", stage: "enable", target: "dsh-extra", enabled: next };
    }
  };
  const view = createMarketplaceView({
    host, sheet: null, deps: { formatErrorDetails: String }, settingsService: service,
    showToast: () => {}, settingsDialog: null, cards: [],
    onOpenCard: () => {}, onInstalled: () => {}, onChange: () => view.paint()
  });
  await view.refresh();
  host.querySelector("#plug-bundle-dsh-extra").dispatchEvent(new dom.window.Event("change"));
  await FLUSH();
  await FLUSH();
  assert.ok(host.textContent.includes("下次启动生效"), "应显示 restart-required 的本地化文案");
});

test("工具栏:搜索与状态筛选只过滤列表,刷新期间保留列表而不是整页 loading", async () => {
  let release;
  let block = false;
  let toggled = 0;
  const bundles = [
    { name: "dsh-agent-team", version: "1.0.0", description: "teams", enabled: true, installed: false, optional: true, removable: false },
    { name: "dsh-voice", version: "1.0.0", description: "voice input", enabled: false, installed: false, optional: true, removable: false }
  ];
  const host = document.getElementById("host");
  host.innerHTML = "";
  const service = {
    async pluginBundles() { if (block) { block = false; await new Promise((resolve) => { release = resolve; }); } return bundles; },
    async pluginEntries() { return []; },
    async setBundleEnabled() { toggled += 1; return { application: "applied" }; }
  };
  let opened = 0;
  let view;
  view = createMarketplaceView({
    host, sheet: null, deps: { formatErrorDetails: (error) => String(error) }, settingsService: service,
    showToast: () => {}, settingsDialog: null, cards: [{ id: "bash", title: "plug.bashTitle", description: "plug.bashDescription" }],
    onOpenCard: () => { opened += 1; }, onInstalled: () => {}, onChange: () => view.paint()
  });
  await view.refresh();
  const rowIds = () => [...host.querySelectorAll("[id^=plug-bundle-row-], [id^=plug-card-row-]")].map((row) => row.id);
  assert.deepEqual(rowIds(), ["plug-bundle-row-dsh-agent-team", "plug-bundle-row-dsh-voice", "plug-card-row-bash"]);
  const search = host.querySelector("#plug-search");
  search.value = "voice";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.deepEqual(rowIds(), ["plug-bundle-row-dsh-voice"]);
  assert.equal(document.activeElement?.id, "plug-search", "重画后焦点应回到搜索框");
  host.querySelector("#plug-search-clear").click();
  host.querySelector('#plug-filter [data-segment="enabled"]').click();
  assert.deepEqual(rowIds(), ["plug-bundle-row-dsh-agent-team"], "已启用筛选不应包含未启用插件与配置卡片");
  host.querySelector('#plug-filter [data-segment="disabled"]').click();
  assert.deepEqual(rowIds(), ["plug-bundle-row-dsh-voice"]);
  host.querySelector('#plug-filter [data-segment="all"]').click();
  // 后台刷新:列表保留,刷新键进入转圈态。
  block = true;
  const pending = view.refresh({ keepNotices: true });
  assert.equal(rowIds().length, 3, "刷新期间不应退回整页 loading");
  assert.ok(host.querySelector("#plug-refresh").classList.contains("spinning"));
  release(); await pending;
  assert.ok(!host.querySelector("#plug-refresh").classList.contains("spinning"));
  // 整行打开详情,但点开关不应打开详情。
  host.querySelector("#plug-card-row-bash").click();
  assert.equal(opened, 1);
  host.querySelector("#plug-bundle-dsh-voice").closest(".set-switch").click();
  assert.ok(host.querySelector("#plug-bundle-row-dsh-voice"), "点开关不应进入详情");
  await FLUSH(); await FLUSH();
  assert.equal(toggled, 1, "开关仍然独立生效");
  assert.ok(host.querySelector("#plug-bundle-row-dsh-voice .set-row-note.ok"), "启停结果按语气就地提示");
  host.querySelector("#plug-bundle-row-dsh-agent-team .set-row-text").click();
  assert.ok(host.querySelector("#plug-detail-back"), "点行本体应进入详情");
  view.dispose();
});
