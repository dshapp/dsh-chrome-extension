/**
 * 会话抽屉列表的 DOM 结构契约。
 *
 * 行为层(sidepanel-overlays)完全靠这些 class 与 data-* 找东西:
 * .history-group → 折叠、.history-more-row → 展开其余、data-group-id → 拖拽
 * 能不能落、data-index → 键盘高亮。结构一改而它们没跟上,表现是"点了没反应",
 * 不会报错 —— 所以钉在这里。
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

const { renderSections, renderResultRows, SECTION_HEAD_ID } =
  await import("../src/app/sidepanel/session-drawer-view.js");
const { buildSidebarSections, SidebarGroupBy } =
  await import("../src/features/sessions/sidebar-sections.js");

const list = () => document.getElementById("history-list-inner");

/** 最小行渲染上下文:没有 listStore 也要能画(首帧就是这样)。 */
function ctx(extra = {}) {
  return {
    listStore: null,
    pinnedStore: { isPinned: (id) => (extra.pinned ?? []).includes(id) },
    activeSessionId: extra.activeSessionId ?? null,
    selectedIndex: extra.selectedIndex ?? -1,
    shortcutLabels: null,
    draggable: extra.draggable ?? true
  };
}

function session(sessionId, extra = {}) {
  return { sessionId, updatedAt: 1000, ...extra };
}

function render(input, extra = {}) {
  const built = buildSidebarSections(input);
  const rendered = renderSections(list(), {
    sections: built.sections,
    groupBy: input.groupBy ?? SidebarGroupBy.workspace,
    ctx: ctx(extra)
  });
  return { built, rendered };
}

test("分组模式:分区标题带动作槽,每组一行标题,行挂着自己的组 id", () => {
  const { rendered } = render({
    sessions: [session("a"), session("b")],
    workspaces: [{ workspaceId: "ws1", title: "repo", path: "/r", sessionIds: ["a", "b"] }],
    orderBy: "manual",
    sortRows: (rows) => rows
  });
  assert.ok(document.getElementById(SECTION_HEAD_ID), "分区标题行必须带 id,视图选项要搬进去");
  assert.ok(list().querySelector(`#${SECTION_HEAD_ID} .history-section-actions`), "动作槽必须存在");
  const group = list().querySelector(".history-group");
  assert.equal(group.dataset.groupId, "ws1");
  assert.equal(group.getAttribute("aria-expanded"), "true");
  assert.equal(group.querySelector(".history-group-count").textContent, "2");
  const rows = [...list().querySelectorAll(".history-item")];
  assert.deepEqual(rows.map((row) => row.dataset.groupId), ["ws1", "ws1"]);
  assert.deepEqual(rows.map((row) => row.dataset.index), ["0", "1"]);
  assert.ok(rows[0].classList.contains("in-group"), "组内行要缩进");
  assert.equal(rendered.length, 2);
});

test("折叠的组只剩标题行;超出 5 行时画出「展开其余」行", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
  render({
    sessions: ids.map((id) => session(id)),
    workspaces: [{ workspaceId: "ws1", title: "repo", path: "/r", sessionIds: ids }],
    orderBy: "manual",
    sortRows: (rows) => rows
  });
  assert.equal(list().querySelectorAll(".history-item").length, 5);
  const more = list().querySelector(".history-more-row");
  assert.equal(more.dataset.groupId, "ws1");

  render({
    sessions: ids.map((id) => session(id)),
    workspaces: [{ workspaceId: "ws1", title: "repo", path: "/r", sessionIds: ids }],
    collapsedGroupIds: ["ws1"],
    orderBy: "manual",
    sortRows: (rows) => rows
  });
  assert.equal(list().querySelectorAll(".history-item").length, 0);
  assert.equal(list().querySelector(".history-group").getAttribute("aria-expanded"), "false");
});

test("置顶区在最上面,置顶行的行首是图钉、行操作里是「取消置顶」", () => {
  render({
    sessions: [session("a"), session("b")],
    workspaces: [{ workspaceId: "ws1", title: "repo", path: "/r", sessionIds: ["a", "b"] }],
    pinnedIds: ["b"],
    orderBy: "manual",
    sortRows: (rows) => rows
  }, { pinned: ["b"] });
  const rows = [...list().querySelectorAll(".history-item")];
  assert.deepEqual(rows.map((row) => row.dataset.sessionId), ["b", "a"]);
  assert.equal(rows[0].dataset.groupId, "__pinned__");
  assert.ok(rows[0].querySelector(".h-state-pin"), "置顶且无状态要报时,槽位里是图钉");
  assert.ok(rows[0].querySelector('button[data-action="pin"]'), "置顶按钮在行操作里");
});

test("空白(blank)行不给行操作 —— 那上面还什么都没发生", () => {
  render({
    sessions: [session("blank", { blank: true })],
    groupBy: SidebarGroupBy.flat,
    activeSessionId: "blank"
  });
  const row = list().querySelector(".history-item");
  assert.equal(row.dataset.sessionId, "blank");
  assert.equal(row.querySelector(".h-actions"), null);
});

test("状态排序档下行不可拖(顺序是算出来的)", () => {
  render({
    sessions: [session("a")],
    groupBy: SidebarGroupBy.flat
  }, { draggable: false });
  assert.equal(list().querySelector(".history-item").getAttribute("draggable"), null);
});

test("一条会话都没有时给空态,但分区标题仍在(视图选项要有地方挂)", () => {
  render({ sessions: [], workspaces: [] });
  assert.ok(list().querySelector(".history-empty"));
  assert.ok(document.getElementById(SECTION_HEAD_ID));
});

test("搜索结果是一串平铺的行,超出上限时补一行提示", () => {
  const rendered = renderResultRows(list(), {
    items: [session("a"), session("b")],
    hasMore: true,
    limit: 20,
    ctx: ctx()
  });
  assert.equal(rendered.length, 2);
  assert.equal(list().querySelectorAll(".history-group").length, 0, "搜索态没有分组");
  assert.ok(list().querySelector(".history-more"), "被截断的条数要说出来");
});
