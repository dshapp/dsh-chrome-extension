/**
 * 排队面板的就地更新契约。
 *
 * 侧栏每个渲染帧都会重画队列面板(流式输出时约每 16ms 一帧)。面板若整块重建,
 * 行内编辑的输入框会被换回只读文本 —— 用户刚敲进去的字连同光标一起消失。
 * 这组用例把"内容没变就不重画、正在编辑就更不重画"钉住。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><ol id="prompt-queue"></ol></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { createQueuePanel } = await import("../src/features/prompt-queue/queue-panel.js");

/** 一行 queued 消息。 */
function queuedRow(id, text) {
  return { id, placement: "queued", message: { id, role: "user", content: [{ type: "text", text }] } };
}

/** 构造 queued 行(m1, m2, … 按位置命名)。 */
function rows(texts) {
  return texts.map((text, index) => queuedRow(`m${index + 1}`, text));
}

/** 挂一个面板;返回 { host, panel }。 */
function mount(items, options = {}) {
  const host = document.getElementById("prompt-queue");
  const panel = createQueuePanel(items, { onAction: async () => {}, ...options });
  host.replaceChildren(panel);
  return { host, panel };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("内容没变时 update 不碰 DOM", () => {
  const { panel } = mount(rows(["第一条"]), { running: true });
  const rowBefore = panel.querySelector(".queue-row");
  assert.equal(panel.update(rows(["第一条"]), { running: true }), false);
  assert.equal(panel.querySelector(".queue-row"), rowBefore, "同一个行节点应原样保留");
});

test("编辑中的行不会被下一次快照刷掉(回归)", async () => {
  const calls = [];
  const { panel } = mount(rows(["第一条", "第二条"]), {
    running: true,
    onAction: async (itemId, action) => { calls.push([itemId, action]); }
  });
  panel.querySelector('[data-item-id="m1"] [data-action="edit"]').click();
  const input = panel.querySelector(".queue-edit-input");
  assert.ok(input, "点编辑后应出现输入框");

  // 用户正在打字时,流式帧又推进了一帧 —— 内容与开关都没变。
  input.value = "改过的草稿";
  assert.equal(panel.update(rows(["第一条", "第二条"]), { running: true, mutable: true }), false);
  const stillThere = panel.querySelector(".queue-edit-input");
  assert.ok(stillThere, "编辑输入框不能被快照刷掉");
  assert.equal(stillThere.value, "改过的草稿", "已敲进去的字不能丢");

  // 提交仍然生效。
  stillThere.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  assert.deepEqual(calls, [["m1", { kind: "edit", text: "改过的草稿" }]]);
  assert.equal(panel.querySelector(".queue-edit-input"), null, "提交后应退出编辑态");
});

test("队列内容变化时重画", () => {
  const { panel } = mount(rows(["第一条"]), { running: true });
  assert.equal(panel.update(rows(["第一条", "第二条"]), { running: true }), true);
  const texts = [...panel.querySelectorAll(".queue-text")].map((node) => node.textContent);
  assert.deepEqual(texts, ["第一条", "第二条"]);
});

test("running 变化就地更新插队按钮的可用性", () => {
  const { panel } = mount(rows(["第一条"]), { running: false });
  const steer = () => panel.querySelector('[data-item-id="m1"] [data-action="steer"]');
  assert.equal(steer().disabled, true, "不在运行中时插队不可用");
  assert.equal(panel.update(rows(["第一条"]), { running: true }), true);
  assert.equal(steer().disabled, false, "运行中时插队恢复可用");
});

test("编辑中的行离开队列时结束编辑态", () => {
  const { panel } = mount(rows(["第一条", "第二条"]), { running: true });
  panel.querySelector('[data-item-id="m1"] [data-action="edit"]').click();
  assert.ok(panel.querySelector(".queue-edit-input"));
  // 宿主取走了 m1(插队/撤回),下一帧队列里只剩 m2 —— id 必须是 m2,不能按
  // 位置重新编号,否则 m1 看起来还在队列里。
  assert.equal(panel.update([queuedRow("m2", "第二条")], { running: true }), true);
  assert.equal(panel.querySelector(".queue-edit-input"), null, "编辑目标没了就该退出编辑态");
});

test("队列清空后面板隐藏,重新排入后再显示", () => {
  const { host, panel } = mount(rows(["第一条"]), { running: true });
  assert.equal(host.hidden, false);
  panel.update([], {});
  host.hidden = panel.hidden;
  assert.equal(panel.hidden, true);
  panel.update(rows(["又一条"]), {});
  host.hidden = panel.hidden;
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelector(".queue-text").textContent, "又一条");
});

test("编辑框是多行 textarea:原文换行(含首行换行)原样回填", () => {
  const { panel } = mount(rows(["\n第一行\n第二行"]), { running: true });
  panel.querySelector('[data-item-id="m1"] [data-action="edit"]').click();
  const input = panel.querySelector(".queue-edit-input");
  assert.equal(input.tagName, "TEXTAREA");
  assert.equal(input.value, "\n第一行\n第二行");
});

test("Shift+Enter 换行不提交;Enter 保存时保留换行与首尾空白,全空白不提交", async () => {
  const calls = [];
  const { panel } = mount(rows(["原文"]), {
    running: true,
    onAction: async (itemId, action) => { calls.push([itemId, action]); }
  });
  panel.querySelector('[data-item-id="m1"] [data-action="edit"]').click();
  const input = panel.querySelector(".queue-edit-input");
  const shiftEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(shiftEnter);
  assert.equal(shiftEnter.defaultPrevented, false, "Shift+Enter 交给 textarea 自己换行");
  input.value = "  \n\t";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  assert.deepEqual(calls, [], "全空白不提交");
  input.value = " 第一行\n第二行 ";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  assert.deepEqual(calls, [["m1", { kind: "edit", text: " 第一行\n第二行 " }]]);
});
