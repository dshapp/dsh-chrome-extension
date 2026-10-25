/**
 * 打开侧栏时焦点落进聊天输入框(composer-focus.js)。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { focusComposerOnOpen } = await import("../src/app/sidepanel/composer-focus.js");

function harness() {
  document.body.className = "";
  document.body.innerHTML = `
    <div id="composer"><textarea id="input"></textarea></div>
    <input id="search">
    <dialog id="key-onboarding"><input id="key"></dialog>`;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  return {
    composer: document.querySelector("#composer"),
    input: document.querySelector("#input"),
    search: document.querySelector("#search"),
    dialog: document.querySelector("#key-onboarding")
  };
}

test("焦点无主时聚焦输入框", () => {
  const h = harness();
  assert.equal(document.activeElement, document.body);
  assert.equal(focusComposerOnOpen(h), true);
  assert.equal(document.activeElement, h.input);
});

test("已在输入框里时视为成功且不打断", () => {
  const h = harness();
  h.input.focus();
  h.input.value = "草稿";
  h.input.setSelectionRange(1, 1);
  assert.equal(focusComposerOnOpen(h), true);
  assert.equal(h.input.selectionStart, 1);
});

test("用户已聚焦别的控件时不抢焦点", () => {
  const h = harness();
  h.search.focus();
  assert.equal(focusComposerOnOpen(h), false);
  assert.equal(document.activeElement, h.search);
});

test("输入框让位给交互卡片 / 子代理只读时不聚焦", () => {
  let h = harness();
  h.composer.hidden = true;
  assert.equal(focusComposerOnOpen(h), false);
  assert.equal(document.activeElement, document.body);
  h = harness();
  h.input.disabled = true;
  assert.equal(focusComposerOnOpen(h), false);
  assert.equal(document.activeElement, document.body);
});

test("模态框开着或安装引导在场时不聚焦", () => {
  let h = harness();
  h.dialog.setAttribute("open", "");
  assert.equal(focusComposerOnOpen(h), false);
  assert.equal(document.activeElement, document.body);
  h = harness();
  document.body.classList.add("setup-required");
  assert.equal(focusComposerOnOpen(h), false);
  assert.equal(document.activeElement, document.body);
});
