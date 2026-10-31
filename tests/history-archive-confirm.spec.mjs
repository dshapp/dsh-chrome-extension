/**
 * 会话抽屉行尾「归档」:先弹窗确认(防误触),归档后抽屉不收起。
 *
 * 跑法:node --test tests/history-archive-confirm.spec.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><aside id="drawer"><ul id="list"></ul></aside></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CSS = { escape: (value) => String(value).replace(/"/g, '\\"') };

const { createConfirmDialog } = await import("../src/app/sidepanel/confirm-dialog.js");
const { createHistoryRowActions } = await import("../src/app/sidepanel/history-row-actions.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const drawer = document.querySelector("#drawer");
const list = document.querySelector("#list");

function rowFor(id, title) {
  list.innerHTML = `<li class="history-item" data-session-id="${id}"><span class="h-title">${title}</span>`
    + '<span class="h-actions"><button type="button" data-action="archive"></button></span></li>';
  return list.querySelector("li");
}

function setup({ active = "other" } = {}) {
  const calls = [];
  for (const stale of drawer.querySelectorAll("dialog")) stale.remove();
  const confirmDialog = createConfirmDialog(() => drawer);
  const sessions = { async archive(id) { calls.push(["archive", id]); return [id]; } };
  const hooks = {
    hide: () => calls.push(["hide"]),
    openSession: () => calls.push(["openSession"]),
    newSession: async (options) => { calls.push(["newSession", options]); },
    refresh: () => calls.push(["refresh"]),
    paint: () => {},
    showToast: (text) => calls.push(["toast", text]),
    formatErrorDetails: (error) => String(error)
  };
  const actions = createHistoryRowActions({
    list, sessions, pinnedStore: null, activeSessionId: () => active, confirmDialog, hooks
  });
  return { calls, actions, confirmDialog };
}

function dialogNode() { return drawer.querySelector("dialog.confirm-dialog"); }
function press(choice) { dialogNode().querySelector(`[data-confirm="${choice}"]`).click(); }

test("归档先弹确认框:取消就不发归档,行按钮恢复可点", async () => {
  const { calls, actions, confirmDialog } = setup();
  const row = rowFor("s1", "需求评审");
  const done = actions.run("archive", row);
  await flush();
  assert.ok(confirmDialog.isOpen(), "确认框打开");
  assert.ok(dialogNode(), "确认框挂在抽屉里(点它不算点抽屉外)");
  assert.match(dialogNode().textContent, /需求评审/, "文案带上会话标题");
  assert.equal(row.querySelector("button").disabled, true, "确认期间整行禁用,防连点");
  press("cancel");
  await done;
  assert.deepEqual(calls, [], "取消:不归档、不收抽屉、不刷新");
  assert.equal(confirmDialog.isOpen(), false);
  assert.equal(row.querySelector("button").disabled, false);
});

test("确认后归档非当前会话:只刷新列表,抽屉不收起", async () => {
  const { calls, actions } = setup({ active: "other" });
  const done = actions.run("archive", rowFor("s1", "A"));
  await flush();
  press("ok");
  await done;
  assert.deepEqual(calls, [["archive", "s1"], ["refresh"]]);
});

test("确认后归档当前会话:接替进新会话但保持抽屉打开", async () => {
  const { calls, actions } = setup({ active: "s1" });
  const done = actions.run("archive", rowFor("s1", "A"));
  await flush();
  press("ok");
  await done;
  assert.deepEqual(calls, [["archive", "s1"], ["newSession", { keepDrawer: true }], ["refresh"]]);
  assert.ok(!calls.some(([name]) => name === "hide"), "不调用 hide()");
});

test("确认框被程序化取消(抽屉被收起)时按取消结算", async () => {
  const { calls, actions, confirmDialog } = setup();
  const done = actions.run("archive", rowFor("s1", "A"));
  await flush();
  confirmDialog.cancel();
  await done;
  assert.deepEqual(calls, []);
});
