/**
 * 分组拖拽:拖工作区标题调整分组顺序(对齐 Mac WorkspaceGroupDrag)。
 *
 * 钉住三件事:只有 workspace 标题可拖;落点按整组的上下半算;
 * 落在「未分组」上 = 移到最后(before = null)。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><ul id="history-list-inner"></ul></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CSS = { escape: (value) => String(value).replace(/"/g, '\\"') };

const { renderSections } = await import("../src/app/sidepanel/session-drawer-view.js");
const { buildSidebarSections } = await import("../src/features/sessions/sidebar-sections.js");
const { mountHistoryGroupDrag } = await import("../src/features/sessions/history-group-drag.js");

const list = () => document.getElementById("history-list-inner");
const session = (id) => ({ sessionId: id, updatedAt: 1, projections: { values: { title: id } } });
const workspace = (id, sessionIds, collapsed = false) => ({ workspaceId: id, title: id, path: `/p/${id}`, sessionIds, collapsed });

function render({ collapsed = [], groupDraggable = true } = {}) {
  const { sections } = buildSidebarSections({
    sessions: ["a1", "a2", "b1", "c1", "u1"].map(session),
    workspaces: [workspace("A", ["a1", "a2"]), workspace("B", ["b1"]), workspace("C", ["c1"])],
    collapsedGroupIds: collapsed
  });
  renderSections(list(), {
    sections,
    groupBy: "workspace",
    ctx: {
      listStore: null, pinnedStore: { isPinned: () => false }, activeSessionId: null,
      selectedIndex: -1, shortcutLabels: null, draggable: true, groupDraggable
    }
  });
}

/// jsdom 不做布局:给每个带 data-group-id 的节点按文档顺序排出 20px 高的盒子。
function layout() {
  [...list().querySelectorAll("[data-group-id]")].forEach((node, index) => {
    node.getBoundingClientRect = () => ({ top: index * 20, bottom: index * 20 + 20, height: 20 });
  });
}

function fire(type, target, { clientY = 0 } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "dataTransfer", { value: { setData() {}, effectAllowed: "", dropEffect: "" } });
  target.dispatchEvent(event);
  return event;
}

const header = (id) => list().querySelector(`.history-group[data-group-id="${id}"]`);
const row = (id) => list().querySelector(`.history-item[data-session-id="${id}"]`);
const centerOf = (node) => node.getBoundingClientRect().top + 10;

function setup(options) {
  render(options);
  layout();
  const drops = [];
  const unmount = mountHistoryGroupDrag(list(), { enabled: () => true, onDrop: (moved, before) => drops.push([moved, before]) });
  return { drops, unmount };
}

test("只有 workspace 标题带 draggable;「未分组」与关掉开关时都不带", () => {
  render();
  assert.equal(header("A").getAttribute("draggable"), "true");
  assert.equal(header("A").dataset.groupKind, "workspace");
  assert.equal(header("__ungrouped__").getAttribute("draggable"), null);
  assert.equal(header("__ungrouped__").dataset.groupKind, "ungrouped");
  render({ groupDraggable: false });
  assert.equal(header("A").getAttribute("draggable"), null);
});

test("落在组的上半 = 插到它前面,并在标题上画 before 线", () => {
  const { drops, unmount } = setup();
  fire("dragstart", header("C"));
  fire("dragover", header("A"), { clientY: centerOf(header("A")) });
  assert.ok(header("A").classList.contains("group-drop-before"));
  fire("drop", header("A"), { clientY: centerOf(header("A")) });
  assert.deepEqual(drops, [["C", "A"]]);
  assert.equal(list().querySelectorAll(".group-drop-before, .group-drop-after").length, 0);
  unmount();
});

test("落在组内会话行的下半 = 插到这一组后面,线画在组的最后一行", () => {
  const { drops, unmount } = setup();
  fire("dragstart", header("A"));
  // A 组 = 标题 + a1 + a2(0..60),落在 a2 上:在组的下半。拖到自己组上不给线、不提交。
  fire("dragover", row("a2"), { clientY: centerOf(row("a2")) });
  assert.equal(row("a2").classList.contains("group-drop-after"), false);
  fire("drop", row("a2"), { clientY: centerOf(row("a2")) });
  assert.deepEqual(drops, [], "A 插到 A 后面 = 原位,不打扰宿主");
  fire("dragstart", header("C"));
  fire("dragover", row("a2"), { clientY: centerOf(row("a2")) });
  assert.ok(row("a2").classList.contains("group-drop-after"));
  fire("drop", row("a2"), { clientY: centerOf(row("a2")) });
  assert.deepEqual(drops, [["C", "B"]]);
  unmount();
});

test("落在「未分组」上 = 移到最后(before = null)", () => {
  const { drops, unmount } = setup();
  fire("dragstart", header("A"));
  fire("dragover", header("__ungrouped__"), { clientY: centerOf(header("__ungrouped__")) });
  assert.ok(header("__ungrouped__").classList.contains("group-drop-before"));
  fire("drop", header("__ungrouped__"), { clientY: centerOf(header("__ungrouped__")) });
  assert.deepEqual(drops, [["A", null]]);
  unmount();
});

test("折叠的组只有标题,下半 = 插到后面", () => {
  const { drops, unmount } = setup({ collapsed: ["B"] });
  fire("dragstart", header("A"));
  const y = header("B").getBoundingClientRect().top + 15;
  fire("drop", header("B"), { clientY: y });
  assert.deepEqual(drops, [["A", "C"]]);
  unmount();
});

test("拖会话行不会触发分组拖拽", () => {
  const { drops, unmount } = setup();
  const start = fire("dragstart", row("b1"));
  fire("drop", header("A"), { clientY: centerOf(header("A")) });
  assert.deepEqual(drops, []);
  assert.equal(start.defaultPrevented, false);
  unmount();
});
