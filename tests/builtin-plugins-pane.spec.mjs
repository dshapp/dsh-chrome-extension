/**
 * 设置页「内置插件」:对齐 DSH web 的插件清单 —— 会话插件(按 Agent 预设)与全局插件两部分。
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
const { createBuiltinPluginsPane } = await import("../src/app/sidepanel/settings/builtin-plugins-pane.js");
const { inventoryShortName } = await import("../src/features/settings/plugin-meta.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const SNAPSHOT = {
  entries: [
    { entryId: "shell", moduleName: "@deepseek-ai/dsh-host-shell", enabled: true, fiberPhase: "active", meta: { title: { en: "Shell", zh: "终端" } } },
    { entryId: "broken", moduleName: "@x/dsh-broken", enabled: true, fiberPhase: "failed" },
    { entryId: "web-search", moduleName: "@deepseek-ai/dsh-web-search", enabled: false, fiberPhase: null },
    { entryId: "worktree", moduleName: "@deepseek-ai/dsh-tool-worktree", enabled: false, fiberPhase: null }
  ],
  agentPresets: [
    { id: "minimal", isDefault: false, rows: [{ entryId: "m1", moduleName: "@deepseek-ai/dsh-tool-read", enabled: true, fiberPhase: null }] },
    {
      id: "standard", isDefault: true, rows: [
        { entryId: "s1", moduleName: "@deepseek-ai/dsh-web-search", enabled: true, fiberPhase: "loading" },
        { entryId: null, moduleName: "cordis:include", enabled: "conditional", condition: "!!js env.CI", fiberPhase: null }
      ]
    },
    { id: "custom", name: "我的预设", isDefault: false, broken: "preset.yaml: parse error", rows: [] }
  ]
};

function mount(snapshot = SNAPSHOT, extra = {}) {
  const host = document.getElementById("pane");
  host.innerHTML = "";
  let calls = 0;
  const pane = createBuiltinPluginsPane({
    host,
    deps: extra.deps ?? {},
    settingsService: { async pluginInventory() { calls++; if (extra.fail) throw new Error("down"); return snapshot; } }
  });
  return { host, pane, calls: () => calls };
}

const groupIds = (host) => [...host.querySelectorAll("[data-plugin-scope]")].map((node) => node.dataset.pluginScope);
const titles = (root) => [...root.querySelectorAll(".inv-card-title")].map((node) => node.textContent);

test("短名与 web 一致:去 scope 与 cordis:/cordis-plugin-/dsh-[host-|client-] 前缀", () => {
  assert.equal(inventoryShortName("@deepseek-ai/dsh-host-shell"), "shell");
  assert.equal(inventoryShortName("@deepseek-ai/dsh-client-ui-chat"), "ui-chat");
  assert.equal(inventoryShortName("cordis:include"), "include");
  assert.equal(inventoryShortName("cordis-plugin-foo"), "foo");
});

test("两部分:会话插件在前、默认展开并选默认预设;全局插件默认折起", async () => {
  const { host, pane } = mount();
  pane.setVisible(true);
  await flush(); await flush();
  assert.match(host.querySelector(".inv-intro").textContent, /查看内置部署的插件列表/);
  assert.deepEqual(groupIds(host), ["preset", "global"]);
  const preset = host.querySelector('[data-plugin-scope="preset"]');
  assert.equal(preset.dataset.presetId, "standard");
  assert.equal(host.querySelector("#inv-preset-switcher").value, "standard");
  const options = [...host.querySelectorAll("#inv-preset-switcher option")].map((o) => o.textContent);
  assert.equal(options.length, 3);
  assert.ok(!/（默认）|（加载失败）/.test(options[0]), options[0]);
  assert.match(options[1], /（默认）$/);
  assert.equal(options[2], "我的预设（加载失败）");
  assert.equal(preset.querySelector("[data-preset-plugin-count]").textContent, "2 个");
  assert.deepEqual(titles(preset), ["web-search", "include"]);
  // 条件启用挂黄色标签,运行中过渡带动画点。
  assert.ok(preset.querySelector(".set-tag.warn"));
  assert.ok(preset.querySelector(".inv-phase-dot.busy"));
  const global = host.querySelector('[data-plugin-scope="global"]');
  assert.equal(global.querySelector("#inv-toggle-global").getAttribute("aria-expanded"), "false");
  assert.equal(global.querySelector(".inv-cards"), null);
  assert.equal(global.querySelector("[data-plugin-count]").textContent, "4 个");
  assert.match(global.querySelector(".inv-failed-count").textContent, /1/);
  pane.dispose();
});

test("全局插件展开:失败的排最前;被预设启用的停用行标「预设中启用」并能跳到该预设", async () => {
  const { host, pane } = mount();
  pane.setVisible(true);
  await flush(); await flush();
  host.querySelector("#inv-toggle-global").click();
  const global = () => host.querySelector('[data-plugin-scope="global"]');
  assert.deepEqual(titles(global()), ["broken", "终端", "web-search", "tool-worktree"]);
  assert.ok(global().querySelector('[data-plugin-entry="broken"] .set-tag.danger'));
  const webSearch = () => global().querySelector('[data-plugin-entry="web-search"]');
  assert.match(webSearch().querySelector(".set-tag").textContent, /预设中启用/);
  assert.match(global().querySelector('[data-plugin-entry="worktree"] .set-tag').textContent, /已停用/);
  // 普通启用行不挂标签。
  assert.equal(global().querySelector('[data-plugin-entry="shell"] .set-tag'), null);
  webSearch().querySelector("[data-inv-card]").click();
  assert.match(webSearch().querySelector(".inv-details").textContent, /启用于/);
  // 「去预设分组查看」切到第一个启用它的预设。
  host.querySelector("#inv-preset-switcher").value = "minimal";
  host.querySelector("#inv-preset-switcher").dispatchEvent(new window.Event("change"));
  webSearch().querySelector(".inv-enabled-in [data-inv-preset]").click();
  assert.equal(host.querySelector('[data-plugin-scope="preset"]').dataset.presetId, "standard");
  pane.dispose();
});

test("切换预设;坏掉的预设显示原因", async () => {
  const { host, pane } = mount();
  pane.setVisible(true);
  await flush(); await flush();
  const select = host.querySelector("#inv-preset-switcher");
  select.value = "custom";
  select.dispatchEvent(new window.Event("change"));
  assert.equal(host.querySelector('[data-plugin-scope="preset"]').dataset.presetId, "custom");
  assert.match(host.querySelector(".inv-broken").textContent, /parse error/);
  pane.dispose();
});

test("搜索:两组强制展开;当前预设之外的命中给出跳转", async () => {
  const { host, pane } = mount();
  pane.setVisible(true);
  await flush(); await flush();
  const search = host.querySelector("#inv-search");
  search.value = "read";
  search.dispatchEvent(new window.Event("input"));
  assert.equal(host.querySelector("#inv-toggle-global").getAttribute("aria-expanded"), "true");
  const hint = host.querySelector(".inv-hint");
  assert.match(hint.textContent, /其他预设中还有 1 个匹配/);
  hint.querySelector("[data-inv-preset]").click();
  assert.equal(host.querySelector('[data-plugin-scope="preset"]').dataset.presetId, "minimal");
  assert.deepEqual(titles(host.querySelector('[data-plugin-scope="preset"]')), ["tool-read"]);
  search.value = "nothing-like-this";
  host.querySelector("#inv-search").value = "nothing-like-this";
  host.querySelector("#inv-search").dispatchEvent(new window.Event("input"));
  assert.match(host.querySelector(".inv-status").textContent, /没有匹配的插件/);
  pane.dispose();
});

test("卡片详情:entry id、完整名称、来源预设、禁用条件", async () => {
  const { host, pane } = mount();
  pane.setVisible(true);
  await flush(); await flush();
  const conditional = () => host.querySelector('[data-plugin-module="cordis:include"]');
  conditional().querySelector("[data-inv-card]").click();
  const details = conditional().querySelector(".inv-details").textContent;
  assert.match(details, /完整名称cordis:include/);
  assert.match(details, /来自标准/);
  assert.match(details, /禁用条件!!js env.CI/);
  pane.dispose();
});

test("读失败给重试;刷新合并;可见时随插件变更重读;dispose 退订", async () => {
  let changed = null, cleaned = 0;
  const deps = { sessions: { onPluginManagerChanged: (listener) => { changed = listener; return () => cleaned++; } } };
  const failing = mount(SNAPSHOT, { fail: true });
  failing.pane.setVisible(true);
  await flush(); await flush();
  assert.ok(failing.host.querySelector("#inv-retry"));
  failing.pane.dispose();

  const { host, pane, calls } = mount(SNAPSHOT, { deps });
  pane.setVisible(true);
  const first = pane.refresh(); const second = pane.refresh();
  assert.equal(first, second);
  await first;
  assert.equal(calls(), 1);
  assert.ok(host.querySelector('[data-plugin-scope="global"]'));
  changed(); await flush(); await flush();
  assert.equal(calls(), 2);
  pane.setVisible(false); changed(); await flush();
  assert.equal(calls(), 2);
  pane.dispose();
  assert.equal(cleaned, 1);
});
