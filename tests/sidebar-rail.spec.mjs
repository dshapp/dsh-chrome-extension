/**
 * 左侧图标栏与「最近会话」弹层(sidebar-rail.js)。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const RAIL_HTML = `<nav id="sidebar-rail">
  <button data-rail="expand"></button><button data-rail="new"></button><button data-rail="search"></button>
  <button data-rail="recents" aria-expanded="false"></button>
  <button data-main-surface="plugins" data-rail-icon="puzzle"></button>
  <button data-main-surface="automations" data-rail-icon="clock"></button>
  <button data-rail="settings"></button>
  <div id="sidebar-rail-recents" popover="auto"></div>
</nav>`;

const dom = new JSDOM(`<!doctype html><html><body>${RAIL_HTML}</body></html>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { mountSidebarRail, RECENTS_LIMIT } = await import("../src/app/sidepanel/sidebar-rail.js");

function setup({ recent = [], current = null } = {}) {
  document.body.innerHTML = RAIL_HTML;
  const calls = [];
  const menu = document.querySelector("#sidebar-rail-recents");
  let shown = 0;
  menu.showPopover = () => { shown += 1; };
  menu.hidePopover = () => { shown -= 1; };
  const rail = mountSidebarRail(document, {
    onExpand: () => calls.push("expand"),
    onNew: () => calls.push("new"),
    onSearch: () => calls.push("search"),
    onSettings: () => calls.push("settings"),
    listRecent: (limit) => recent.slice(0, limit),
    currentId: () => current,
    onPick: (id) => calls.push(`pick:${id}`),
    shortcutLabels: { newSession: "⌘N", history: "⌘K" }
  });
  const click = (selector) => document.querySelector(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return { rail, calls, menu, click, shown: () => shown };
}

test("每颗按钮都派到对应回调,并画上图标与可访问名称", () => {
  const { calls, click } = setup();
  for (const action of ["expand", "new", "search", "settings"]) click(`[data-rail="${action}"]`);
  assert.deepEqual(calls, ["expand", "new", "search", "settings"]);
  for (const button of document.querySelectorAll("#sidebar-rail button")) {
    assert.ok(button.querySelector("svg"), "按钮要有图标");
    assert.ok(button.getAttribute("aria-label"), "按钮要有可访问名称");
  }
  assert.match(document.querySelector('[data-rail="new"]').title, /⌘N/);
  assert.match(document.querySelector('[data-rail="expand"]').title, /⌘K/);
});

test("最近会话:条数上限、当前会话打勾、点一项打开并收起", () => {
  const recent = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, title: `会话 ${i}` }));
  const { rail, calls, menu, click, shown } = setup({ recent, current: "s2" });
  click('[data-rail="recents"]');
  assert.equal(rail.isRecentsOpen(), true);
  assert.equal(shown(), 1);
  assert.equal(document.querySelector('[data-rail="recents"]').getAttribute("aria-expanded"), "true");
  const items = menu.querySelectorAll(".menu-item");
  assert.equal(items.length, RECENTS_LIMIT);
  assert.ok(menu.querySelector('[data-item-id="s2"]').classList.contains("selected"));
  assert.equal(document.activeElement, items[0]);
  menu.querySelector('[data-item-id="s3"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(calls, ["pick:s3"]);
  assert.equal(rail.isRecentsOpen(), false);
  assert.equal(shown(), 0);
  assert.equal(document.querySelector('[data-rail="recents"]').getAttribute("aria-expanded"), "false");
});

test("最近会话:再点一下关掉;没有会话时显示空态", () => {
  const { rail, menu, click } = setup();
  click('[data-rail="recents"]');
  assert.ok(menu.querySelector(".menu-empty"));
  click('[data-rail="recents"]');
  assert.equal(rail.isRecentsOpen(), false);
});

test("最近会话:上下方向键在条目间循环", () => {
  const recent = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
  const { menu, click } = setup({ recent });
  click('[data-rail="recents"]');
  const press = (key) => menu.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
  press("ArrowDown");
  assert.equal(document.activeElement.dataset.itemId, "b");
  press("ArrowDown");
  assert.equal(document.activeElement.dataset.itemId, "a");
  press("ArrowUp");
  assert.equal(document.activeElement.dataset.itemId, "b");
});

test("最近会话:行首状态灯与行尾内容画在标题两侧,弹层开着时 refreshRecents 就地重画", () => {
  const recent = [
    { id: "a", title: "A", leadingHtml: '<span class="h-state h-state-ongoing"></span>', trailingHtml: '<span class="h-when-row"><span class="h-when">1m</span></span>' },
    { id: "b", title: "B" }
  ];
  const { rail, menu, click } = setup({ recent });
  rail.refreshRecents();
  assert.equal(menu.querySelector(".menu-item"), null, "关着时不重画");
  click('[data-rail="recents"]');
  const row = menu.querySelector('[data-item-id="a"]');
  assert.ok(row.classList.contains("rail-recent-item"));
  assert.deepEqual([...row.children].map((el) => el.className), ["h-state h-state-ongoing", "menu-item-label", "h-when-row"]);
  assert.equal(menu.querySelector('[data-item-id="b"] .h-state'), null);
  assert.equal(menu.querySelector('[data-item-id="b"] .h-actions'), null);

  menu.querySelector('[data-item-id="b"]').focus();
  recent[0].leadingHtml = '<span class="h-state h-state-error"></span>';
  rail.refreshRecents();
  assert.ok(menu.querySelector('[data-item-id="a"] .h-state-error'), "状态变化重画进来");
  assert.equal(document.activeElement.dataset.itemId, "b", "焦点还回原来那一行");
});
