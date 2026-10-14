/**
 * 已归档会话:会话服务保住归档摘要 + 取消归档;会话抽屉的「筛选会话」轴。
 *
 * 对齐 Mac:没有独立的已归档会话入口,归档行由视图选项里的「筛选会话」决定
 * 隐藏(默认)/ 一并显示 / 只显示;归档行变暗、打不开、只能取消归档,
 * 只看归档且为空时给「查看其他会话」。
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
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { createSessionService } = await import("../src/features/sessions/session-service.js");
const { renderSections, renderResultRows } = await import("../src/app/sidepanel/session-drawer-view.js");
const { buildSidebarSections, visibleSessions, ArchivedFilter, archivedVisible, SidebarGroupBy, PINNED_GROUP_ID } =
  await import("../src/features/sessions/sidebar-sections.js");
const { deriveSearchResults } = await import("../src/features/sessions/session-search.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const summary = (id, title, extra = {}) => ({ sessionId: id, updatedAt: Date.now(), projections: { values: { title } }, ...extra });

/// 假宿主:session/list 返回 rows(含归档行),workspace/unarchiveSession 从 archived 里删掉。
function fakeHost({ rows, archived, failUnarchive = false }) {
  const calls = [];
  const host = { archived: [...archived] };
  const connection = {
    subscribe() {}, unsubscribe() {},
    async call(method, args) {
      calls.push([method, args]);
      if (method === "session/list") return { items: rows };
      if (method === "workspace/unarchiveSession") {
        if (failUnarchive) throw new Error("unknown method");
        host.archived = host.archived.filter((id) => id !== args.request.sessionId);
        return { archivedSessionIds: host.archived };
      }
      return {};
    }
  };
  return { connection, calls, host };
}

test("service:归档行被滤出活动列表,但摘要留在 archivedItems 里,最近归档在前", async () => {
  const { connection } = fakeHost({
    rows: [summary("a", "A"), summary("b", "B"), summary("c", "C")],
    archived: ["b", "c"]
  });
  const service = createSessionService(connection);
  service.setArchivedSessionIds(["b", "c"]);
  await service.refreshList();
  assert.deepEqual(service.listStore.get().map((item) => item.sessionId), ["a"]);
  assert.deepEqual(service.archivedItems().map((item) => item.sessionId), ["c", "b"]);
});

test("service:先有列表、后到归档集合时,也能把摘要挪进归档", async () => {
  const { connection } = fakeHost({ rows: [summary("a", "A"), summary("b", "B")], archived: [] });
  const service = createSessionService(connection);
  await service.refreshList();
  let notified = 0;
  service.onArchivedChange(() => notified++);
  service.setArchivedSessionIds(["b"]);
  assert.deepEqual(service.listStore.get().map((item) => item.sessionId), ["a"]);
  assert.deepEqual(service.archivedItems().map((item) => item.sessionId), ["b"]);
  assert.ok(notified >= 1);
});

test("service:unarchive 调 workspace/unarchiveSession,应用回包,行回到活动列表", async () => {
  const { connection, calls } = fakeHost({
    rows: [summary("a", "A"), summary("b", "B", { archived: true })],
    archived: ["b"]
  });
  const service = createSessionService(connection);
  service.setArchivedSessionIds(["b"]);
  await service.refreshList();
  const ids = await service.unarchive("b");
  assert.deepEqual(ids, []);
  assert.deepEqual(calls.find(([method]) => method === "workspace/unarchiveSession")[1], { request: { sessionId: "b" } });
  assert.deepEqual(service.archivedSessionIds(), []);
  assert.deepEqual(service.archivedItems(), []);
  assert.ok(service.listStore.get().some((item) => item.sessionId === "b"));
});

const list = () => document.getElementById("history-list-inner");
const ctx = (pinned = []) => ({
  listStore: null, pinnedStore: { isPinned: (id) => pinned.includes(id) },
  activeSessionId: null, selectedIndex: -1, shortcutLabels: null, draggable: true
});
const ws = (workspaceId, sessionIds) => ({ workspaceId, title: workspaceId, path: `/r/${workspaceId}`, sessionIds });

test("筛选取值与 Mac SidebarViewOptions.archivedVisible 同义", () => {
  assert.deepEqual(Object.values(ArchivedFilter), ["default", "show", "only"]);
  assert.equal(archivedVisible(true, ArchivedFilter.hide), false);
  assert.equal(archivedVisible(false, ArchivedFilter.hide), true);
  assert.equal(archivedVisible(true, ArchivedFilter.show), true);
  assert.equal(archivedVisible(false, ArchivedFilter.show), true);
  assert.equal(archivedVisible(true, ArchivedFilter.only), true);
  assert.equal(archivedVisible(false, ArchivedFilter.only), false);
});

test("visibleSessions:默认隐藏归档;显示时归档行带 archived:true", () => {
  const rows = [summary("a", "A"), summary("b", "B")];
  assert.deepEqual(visibleSessions(rows, { archivedIds: ["b"] }).map((item) => item.sessionId), ["a"]);
  const shown = visibleSessions(rows, { archivedIds: ["b"], archivedFilter: ArchivedFilter.show });
  assert.deepEqual(shown.map((item) => [item.sessionId, Boolean(item.archived)]), [["a", false], ["b", true]]);
  const only = visibleSessions(rows, { archivedIds: ["b"], archivedFilter: ArchivedFilter.only });
  assert.deepEqual(only.map((item) => item.sessionId), ["b"]);
});

test("分区:归档行留在自己的组、不进置顶区;只看归档时去掉没有归档的组和置顶区", () => {
  const sessions = [summary("a", "A"), summary("b", "B"), summary("c", "C")];
  const input = {
    sessions, archivedIds: ["b"], pinnedIds: ["a", "b"],
    workspaces: [ws("w1", ["a", "b"]), ws("w2", ["c"])], sortRows: (rows) => rows
  };
  const shown = buildSidebarSections({ ...input, archivedFilter: ArchivedFilter.show });
  assert.deepEqual(shown.sections.map((item) => [item.id, item.rows.map((row) => row.sessionId)]),
    [[PINNED_GROUP_ID, ["a"]], ["w1", ["b"]], ["w2", ["c"]]]);
  const only = buildSidebarSections({ ...input, archivedFilter: ArchivedFilter.only });
  assert.deepEqual(only.sections.map((item) => [item.id, item.rows.map((row) => row.sessionId)]), [["w1", ["b"]]]);
});

test("视图:归档行变暗、不可拖、行尾只有「取消归档」", () => {
  const built = buildSidebarSections({
    sessions: [summary("a", "A"), summary("b", "B")], archivedIds: ["b"],
    archivedFilter: ArchivedFilter.show, groupBy: SidebarGroupBy.flat
  });
  renderSections(list(), { sections: built.sections, groupBy: SidebarGroupBy.flat, archivedFilter: ArchivedFilter.show, ctx: ctx() });
  const row = list().querySelector('[data-session-id="b"]');
  assert.ok(row.classList.contains("archived"));
  assert.equal(row.dataset.archived, "true");
  assert.equal(row.getAttribute("draggable"), null);
  assert.deepEqual([...row.querySelectorAll("button[data-action]")].map((node) => node.dataset.action), ["unarchive"]);
  const live = list().querySelector('[data-session-id="a"]');
  assert.equal(live.getAttribute("draggable"), "true");
  assert.ok([...live.querySelectorAll("button[data-action]")].some((node) => node.dataset.action === "archive"));
});

test("视图:只看归档且为空时,空态给「查看其他会话」", () => {
  const built = buildSidebarSections({ sessions: [summary("a", "A")], archivedIds: [], archivedFilter: ArchivedFilter.only });
  renderSections(list(), { sections: built.sections, groupBy: SidebarGroupBy.workspace, archivedFilter: ArchivedFilter.only, ctx: ctx() });
  assert.ok(list().querySelector('.history-empty [data-action="show-other-sessions"]'));
  renderSections(list(), { sections: [], groupBy: SidebarGroupBy.workspace, ctx: ctx() });
  assert.equal(list().querySelector('[data-action="show-other-sessions"]'), null);
});

test("搜索:与侧栏同一个筛选,归档命中带 archived:true", () => {
  const sessions = [summary("a", "修登录"), summary("b", "修登录页")];
  const search = (archivedFilter) => deriveSearchResults({
    sessions, workspaces: [], archivedIds: ["b"], archivedFilter, query: "修登录", remote: { items: [], hasMore: false }
  }).items.map((item) => [item.sessionId, Boolean(item.archived)]);
  assert.deepEqual(search(undefined), [["a", false]]);
  assert.deepEqual(search(ArchivedFilter.show).sort(), [["a", false], ["b", true]]);
  assert.deepEqual(search(ArchivedFilter.only), [["b", true]]);
  renderResultRows(list(), { items: [{ ...summary("b", "修登录页"), archived: true }], ctx: ctx() });
  assert.ok(list().querySelector('[data-session-id="b"]').classList.contains("archived"));
});
