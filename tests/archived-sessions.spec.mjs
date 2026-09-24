/**
 * 已归档会话:会话服务保住归档摘要 + 取消归档;抽屉底部的归档页渲染与交互。
 *
 * 对齐 Mac ArchivedSessionsView:归档集合与摘要求交、最近归档在前、三种空态、
 * 每行一个「取消归档」,成功后该行回到活动列表。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><aside id="session-drawer"></aside></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { createSessionService } = await import("../src/features/sessions/session-service.js");
const { mountArchivedSessions } = await import("../src/app/sidepanel/archived-sessions-view.js");

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

function mountView({ rows, archived, failUnarchive = false, workspaces = [] }) {
  document.body.innerHTML = '<aside id="session-drawer"></aside>';
  const drawer = document.getElementById("session-drawer");
  const harness = fakeHost({ rows, archived, failUnarchive });
  const service = createSessionService(harness.connection);
  service.setArchivedSessionIds(archived);
  const toasts = [];
  const view = mountArchivedSessions({
    drawer, sessions: service, workspaces: () => workspaces, showToast: (message) => toasts.push(message)
  });
  return { drawer, service, view, toasts, harness };
}

test("view:底部入口打开归档页,行带工作区名,搜索按标题或工作区过滤", async () => {
  const { drawer, service, view } = mountView({
    rows: [summary("a", "活跃"), summary("b", "修登录"), summary("c", "写文档", { cwd: "/x/docs-repo" })],
    archived: ["b", "c"],
    workspaces: [{ workspaceId: "w1", title: "pacific", sessionIds: ["b"] }]
  });
  await service.refreshList();
  const entry = drawer.querySelector("#history-archived-btn");
  assert.ok(entry, "入口在抽屉里");
  entry.click();
  assert.ok(view.isActive());
  assert.ok(drawer.classList.contains("archived-mode"));
  const names = () => [...drawer.querySelectorAll(".archived-name")].map((node) => node.textContent);
  assert.deepEqual(names(), ["写文档", "修登录"]);
  const metas = [...drawer.querySelectorAll(".archived-meta")].map((node) => node.textContent.split(" · ")[0]);
  assert.deepEqual(metas, ["docs-repo", "pacific"]);
  const search = drawer.querySelector("#archived-search");
  search.value = "pacific";
  search.dispatchEvent(new window.Event("input"));
  assert.deepEqual(names(), ["修登录"]);
  search.value = "nothing-matches";
  search.dispatchEvent(new window.Event("input"));
  assert.equal(drawer.querySelectorAll(".archived-item").length, 0);
  assert.ok(drawer.querySelector(".history-empty"));
  // 返回按钮退回会话列表。
  drawer.querySelector("#archived-back").click();
  assert.equal(view.isActive(), false);
});

test("view:点「取消归档」后该行从归档页消失", async () => {
  const { drawer, service, view } = mountView({ rows: [summary("b", "修登录")], archived: ["b"] });
  await service.refreshList();
  view.open();
  drawer.querySelector('button[data-action="unarchive"]').click();
  // 在途:按钮禁用,防连点。
  assert.equal(drawer.querySelector('button[data-action="unarchive"]')?.disabled, true);
  await flush(); await flush();
  assert.equal(drawer.querySelectorAll(".archived-item").length, 0);
  assert.ok(service.listStore.get().some((item) => item.sessionId === "b"));
});

test("view:取消归档失败时给 toast,行保留可重试", async () => {
  const { drawer, service, view, toasts } = mountView({ rows: [summary("b", "修登录")], archived: ["b"], failUnarchive: true });
  await service.refreshList();
  view.open();
  drawer.querySelector('button[data-action="unarchive"]').click();
  await flush(); await flush();
  assert.equal(toasts.length, 1);
  const button = drawer.querySelector('button[data-action="unarchive"]');
  assert.ok(button);
  assert.equal(button.disabled, false);
});

test("view:空态区分「没有归档」与「归档集合非空但一行都拼不出来」", () => {
  const empty = mountView({ rows: [], archived: [] });
  empty.view.open();
  const emptyText = empty.drawer.querySelector(".history-empty").textContent;
  const orphan = mountView({ rows: [], archived: ["gone"] });
  orphan.view.open();
  const orphanText = orphan.drawer.querySelector(".history-empty").textContent;
  assert.notEqual(emptyText, orphanText);
});
