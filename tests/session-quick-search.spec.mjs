/**
 * 图标栏「搜索」打开的悬浮搜索框(session-quick-search.js)。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const HTML = '<div id="session-quick-search" popover="auto">'
  + '<input id="session-quick-search-input" />'
  + '<div id="session-quick-search-results" hidden></div></div>'
  + '<button id="outside"></button>';

const dom = new JSDOM('<!doctype html><html><body>' + HTML + '</body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { mountSessionQuickSearch } = await import("../src/app/sidepanel/session-quick-search.js");

const title = (text) => ({ values: { title: text } });
const SESSIONS = [
  { sessionId: "a", updatedAt: 3, projections: title("修复登录 bug") },
  { sessionId: "b", updatedAt: 2, projections: title("写周报") },
  { sessionId: "c", updatedAt: 1, projections: title("登录页改版") },
  { sessionId: "arch", updatedAt: 9, projections: title("登录 归档") },
  { sessionId: "sub", updatedAt: 9, origin: "subagent", projections: title("登录 子代理") }
];

function setup({ search = null, sessions = SESSIONS } = {}) {
  document.body.innerHTML = HTML;
  const panel = document.querySelector("#session-quick-search");
  let shown = 0;
  let source = null;
  panel.showPopover = (options) => { shown += 1; source = options?.source ?? null; };
  panel.hidePopover = () => { shown -= 1; };
  const picks = [];
  const quick = mountSessionQuickSearch(document, {
    sessions: () => sessions,
    archivedIds: () => ["arch"],
    search,
    decorate: (item) => ({ leading: '<span class="h-state" data-for="' + item.sessionId + '"></span>', trailing: "" }),
    currentId: () => "c",
    onPick: (id) => picks.push(id)
  });
  const input = document.querySelector("#session-quick-search-input");
  const results = document.querySelector("#session-quick-search-results");
  const type = (value) => {
    input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const press = (key) => input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const rows = () => [...results.querySelectorAll(".quick-search-item")];
  return { quick, panel, input, results, type, press, rows, picks, shown: () => shown, source: () => source };
}

test("打开即聚焦搜索框;没输入时不列任何候选", () => {
  const { quick, input, results, shown, source } = setup();
  const button = document.querySelector("#outside");
  quick.toggle(button);
  assert.equal(shown(), 1);
  assert.equal(source(), button, "触发按钮作为 invoker");
  assert.equal(document.activeElement, input);
  assert.equal(results.hidden, true);
  assert.equal(input.getAttribute("aria-expanded"), "false");
  quick.toggle(button);
  assert.equal(shown(), 0, "开着时再点是关");
  assert.equal(quick.isOpen(), false);
});

test("输入关键字后在下方列出候选:滤掉归档与子代理,带行首状态灯,当前会话有标记", () => {
  const { quick, results, type, rows, input } = setup();
  quick.open();
  type("登录");
  assert.equal(results.hidden, false);
  assert.deepEqual(rows().map((row) => row.dataset.sessionId), ["a", "c"]);
  assert.ok(rows()[0].querySelector('.h-state[data-for="a"]'));
  assert.ok(rows()[0].classList.contains("active"), "高亮落在第一行");
  assert.ok(rows()[1].classList.contains("current"));
  assert.equal(input.getAttribute("aria-activedescendant"), rows()[0].id);
  type("没有这个词");
  assert.equal(rows().length, 0);
  assert.ok(results.querySelector(".quick-search-note"), "无匹配要说出来");
  type("  ");
  assert.equal(results.hidden, true, "清空后候选收起");
});

test("↑ / ↓ 循环移动,回车打开并收起;重新打开时上次的词已清空", () => {
  const { quick, type, press, rows, picks, input, shown } = setup();
  quick.open();
  type("登录");
  press("ArrowDown");
  assert.ok(rows()[1].classList.contains("active"));
  press("ArrowDown");
  assert.ok(rows()[0].classList.contains("active"), "到底绕回开头");
  press("ArrowUp");
  press("Enter");
  assert.deepEqual(picks, ["c"]);
  assert.equal(shown(), 0);
  quick.open();
  assert.equal(input.value, "");
  assert.equal(rows().length, 0);
});

test("点击候选打开;Esc 收起", () => {
  const { quick, type, rows, picks, press, shown } = setup();
  quick.open();
  type("周报");
  rows()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(picks, ["b"]);
  const button = document.querySelector("#outside");
  quick.open(button);
  press("Escape");
  assert.equal(shown(), 0);
  assert.equal(quick.isOpen(), false);
  assert.equal(document.activeElement, button, "Esc 后焦点还给触发按钮");
});

test("宿主内容命中防抖后接在本地命中之后", async () => {
  const calls = [];
  const search = (query) => {
    calls.push(query);
    return Promise.resolve({ items: query === "周" ? [{ sessionId: "c" }] : [], hasMore: false });
  };
  const { quick, type, rows, results } = setup({ search });
  quick.open();
  type("周");
  assert.deepEqual(rows().map((row) => row.dataset.sessionId), ["b"]);
  assert.ok(results.querySelector('.quick-search-note[role="status"]'), "宿主结果未到时显示搜索中");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(calls, ["周"]);
  assert.deepEqual(rows().map((row) => row.dataset.sessionId), ["b", "c"]);
  assert.equal(results.querySelector('.quick-search-note[role="status"]'), null);
});
