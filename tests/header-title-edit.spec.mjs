/**
 * 顶栏会话标题:单击开关左侧抽屉,双击进入行内改名(header-title-edit.js)。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="header"><button id="hdr-title-wrap"><span id="hdr-title">旧标题</span></button></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { mountHeaderTitleEdit, DOUBLE_CLICK_WINDOW_MS } = await import("../src/app/sidepanel/header-title-edit.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ sessionId = "s1", rename = async () => {} } = {}) {
  document.body.innerHTML = '<div id="header"><button id="hdr-title-wrap"><span id="hdr-title">旧标题</span></button></div>';
  const entry = document.querySelector("#hdr-title-wrap");
  const title = document.querySelector("#hdr-title");
  const calls = { toggle: 0, beforeEdit: 0, rename: [], toasts: [] };
  let current = sessionId;
  const edit = mountHeaderTitleEdit({
    entry, title,
    sessionId: () => current,
    rename: (id, name) => { calls.rename.push([id, name]); return rename(id, name); },
    toggle: () => { calls.toggle += 1; },
    beforeEdit: () => { calls.beforeEdit += 1; },
    showToast: (message) => calls.toasts.push(message)
  });
  const click = (detail) => entry.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail }));
  const dblclick = () => entry.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  const key = (input, k) => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { entry, title, calls, edit, click, dblclick, key, setSession: (id) => { current = id; } };
}

test("单击在双击判定窗口后开关抽屉", async () => {
  const h = harness();
  h.click(1);
  assert.equal(h.calls.toggle, 0);
  await wait(DOUBLE_CLICK_WINDOW_MS + 30);
  assert.equal(h.calls.toggle, 1);
  assert.equal(document.querySelector("#hdr-title-input"), null);
});

test("键盘/程序触发的 click(detail=0)与无会话时立即开关", () => {
  const h = harness();
  h.click(0);
  assert.equal(h.calls.toggle, 1);
  const empty = harness({ sessionId: null });
  empty.click(1);
  assert.equal(empty.calls.toggle, 1);
  empty.dblclick();
  assert.equal(document.querySelector("#hdr-title-input"), null, "没有会话就没有可改的标题");
});

test("双击不开抽屉,进入编辑并回车提交", async () => {
  const h = harness();
  h.click(1); h.click(2); h.dblclick();
  await wait(DOUBLE_CLICK_WINDOW_MS + 30);
  assert.equal(h.calls.toggle, 0, "双击不应开关抽屉");
  assert.equal(h.calls.beforeEdit, 1);
  const input = document.querySelector("#hdr-title-input");
  assert.ok(input);
  assert.equal(input.value, "旧标题");
  assert.equal(h.entry.hidden, true);
  input.value = "  新标题  ";
  h.key(input, "Enter");
  assert.equal(document.querySelector("#hdr-title-input"), null);
  assert.equal(h.entry.hidden, false);
  assert.equal(h.title.textContent, "新标题");
  await wait(0);
  assert.deepEqual(h.calls.rename, [["s1", "新标题"]]);
});

test("Esc 取消、空标题与未改动都不发 rename", () => {
  const h = harness();
  h.edit.start();
  let input = document.querySelector("#hdr-title-input");
  input.value = "不要";
  h.key(input, "Escape");
  assert.equal(h.title.textContent, "旧标题");
  h.edit.start();
  input = document.querySelector("#hdr-title-input");
  input.value = "   ";
  h.key(input, "Enter");
  h.edit.start();
  input = document.querySelector("#hdr-title-input");
  h.key(input, "Enter");
  assert.deepEqual(h.calls.rename, []);
});

test("失焦提交;编辑中换会话则放弃", async () => {
  const h = harness();
  h.edit.start();
  const input = document.querySelector("#hdr-title-input");
  input.value = "失焦提交";
  input.dispatchEvent(new window.FocusEvent("blur"));
  await wait(0);
  assert.deepEqual(h.calls.rename, [["s1", "失焦提交"]]);

  h.edit.start();
  document.querySelector("#hdr-title-input").value = "旧会话的输入";
  h.setSession("s2");
  h.edit.cancel();
  assert.equal(document.querySelector("#hdr-title-input"), null);
  assert.equal(h.calls.rename.length, 1);
});

test("rename 失败时还原标题并提示", async () => {
  const h = harness({ rename: async () => { throw new Error("boom"); } });
  h.edit.start();
  const input = document.querySelector("#hdr-title-input");
  input.value = "会失败";
  h.key(input, "Enter");
  await wait(0); await wait(0);
  assert.equal(h.title.textContent, "旧标题");
  assert.deepEqual(h.calls.toasts, ["boom"]);
});
