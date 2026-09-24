/**
 * 会话列表的分区派生契约(置顶 / 按工作区分组 / 单列表)。
 *
 * 这一层决定"屏幕上会出现哪些行、按什么顺序、哪些被折起来",而快捷键
 *(⌘K+数字、⌘[ / ⌘])与拖拽锚点都读同一份 renderedIds —— 一旦这里和视图
 * 对不上,用户按下的数字就会打开另一个会话。所以规则全部钉在这里。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  buildSidebarSections, visibleSessions, COLLAPSED_GROUP_ROW_LIMIT,
  UNGROUPED_GROUP_ID, PINNED_GROUP_ID, FLAT_GROUP_ID, SidebarGroupBy
} = await import("../src/features/sessions/sidebar-sections.js");

/** 一行会话摘要。updatedAt 默认按 id 序递减,方便断言"最近优先"。 */
function session(sessionId, extra = {}) {
  return { sessionId, updatedAt: 1000, ...extra };
}

/** 一个工作区。 */
function workspace(workspaceId, sessionIds, title = workspaceId) {
  return { workspaceId, title, path: `/repo/${workspaceId}`, sessionIds };
}

test("子代理 / 归档 / 非当前的空白行都不进列表", () => {
  const rows = visibleSessions([
    session("a"),
    session("sub", { origin: "subagent" }),
    session("archived"),
    session("blank-other", { blank: true }),
    session("blank-current", { blank: true })
  ], { archivedIds: ["archived"], activeSessionId: "blank-current" });
  assert.deepEqual(rows.map((item) => item.sessionId), ["a", "blank-current"]);
});

test("按工作区分组:每组按宿主 sessionIds 的成员名单划分,余下的进未分组", () => {
  const { sections, renderedIds } = buildSidebarSections({
    sessions: [session("a"), session("b"), session("loose")],
    workspaces: [workspace("ws1", ["a"]), workspace("ws2", ["b"])],
    groupBy: SidebarGroupBy.workspace,
    orderBy: "manual"
  });
  assert.deepEqual(sections.map((item) => item.id), ["ws1", "ws2", UNGROUPED_GROUP_ID]);
  assert.deepEqual(sections[0].rows.map((item) => item.sessionId), ["a"]);
  assert.deepEqual(sections[2].rows.map((item) => item.sessionId), ["loose"]);
  assert.deepEqual(renderedIds, ["a", "b", "loose"]);
});

test("manual 档下工作区内的顺序就是宿主 sessionIds 的顺序", () => {
  const { sections } = buildSidebarSections({
    // 名册顺序与 sessionIds 故意相反:排出来的必须听宿主的。
    sessions: [session("x", { updatedAt: 9 }), session("y", { updatedAt: 1 })],
    workspaces: [workspace("ws1", ["y", "x"])],
    groupBy: SidebarGroupBy.workspace,
    orderBy: "manual",
    sortRows: (rows) => rows            // manual:原样(真实实现里由 listStore.sortBy 负责)
  });
  assert.deepEqual(sections[0].rows.map((item) => item.sessionId), ["y", "x"]);
});

test("折叠的分组一行不画,但 total 仍报完整成员数", () => {
  const { sections, renderedIds } = buildSidebarSections({
    sessions: [session("a"), session("b")],
    workspaces: [workspace("ws1", ["a", "b"])],
    collapsedGroupIds: ["ws1"]
  });
  assert.equal(sections[0].collapsed, true);
  assert.deepEqual(sections[0].rows, []);
  assert.equal(sections[0].total, 2);
  assert.deepEqual(renderedIds, []);
});

test("含当前会话的分组照样可以折叠,并通过 activeGroupId 报告它在哪组", () => {
  // 回归:以前每次渲染都强行展开这个组,点它的标题永远没反应。
  // 现在只报告位置,由抽屉在打开那一下决定展开(Mac onAppear 的 containsCurrent)。
  const { sections, activeGroupId } = buildSidebarSections({
    sessions: [session("a"), session("b")],
    workspaces: [workspace("ws1", ["a"]), workspace("ws2", ["b"])],
    collapsedGroupIds: ["ws1"],
    activeSessionId: "a"
  });
  assert.equal(sections[0].collapsed, true);
  assert.deepEqual(sections[0].rows, []);
  assert.equal(activeGroupId, "ws1");
});

test("activeGroupId:未分组桶 / 置顶区 / 无当前会话", () => {
  const base = { sessions: [session("a"), session("b")], workspaces: [workspace("ws1", ["a"])] };
  assert.equal(buildSidebarSections({ ...base, activeSessionId: "b" }).activeGroupId, UNGROUPED_GROUP_ID);
  assert.equal(buildSidebarSections({ ...base, pinnedIds: ["a"], activeSessionId: "a" }).activeGroupId, PINNED_GROUP_ID);
  assert.equal(buildSidebarSections(base).activeGroupId, null);
});

test("超过 5 行的分组只画前 5 行,其余记进 hiddenCount;展开后全画", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
  const input = {
    sessions: ids.map((id) => session(id)),
    workspaces: [workspace("ws1", ids)],
    orderBy: "manual",
    sortRows: (rows) => rows
  };
  const folded = buildSidebarSections(input);
  assert.equal(COLLAPSED_GROUP_ROW_LIMIT, 5);
  assert.deepEqual(folded.sections[0].rows.map((item) => item.sessionId), ids.slice(0, 5));
  assert.equal(folded.sections[0].hiddenCount, 2);
  // allIds 始终是完整成员:拖拽要靠它把锚点落到被折起来的那一段上。
  assert.deepEqual(folded.sections[0].allIds, ids);

  const opened = buildSidebarSections({ ...input, expandedGroupIds: ["ws1"] });
  assert.deepEqual(opened.sections[0].rows.map((item) => item.sessionId), ids);
  assert.equal(opened.sections[0].hiddenCount, 0);
});

test("折叠分组不隐藏运行中会话:运行中 / 子代理在跑 / 当前空白行不占名额,按原序穿插", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
  const live = { s7: { running: true }, s9: { blank: true } };
  const input = {
    sessions: ids.map((id) => session(id, live[id] ?? {})),
    workspaces: [workspace("ws1", ids)],
    orderBy: "manual",
    sortRows: (rows) => rows,
    activeSessionId: "s9",
    isRunningSubagentRoot: (id) => id === "s8"
  };
  const folded = buildSidebarSections(input);
  // 闲置名额 5 个给 s1–s5;s6 被折叠;s7(运行中)、s8(子代理在跑)、s9(当前空白)始终画出。
  assert.deepEqual(folded.sections[0].rows.map((item) => item.sessionId), ["s1", "s2", "s3", "s4", "s5", "s7", "s8", "s9"]);
  assert.equal(folded.sections[0].hiddenCount, 1);
  assert.deepEqual(folded.renderedIds, ["s1", "s2", "s3", "s4", "s5", "s7", "s8", "s9"]);
  // 不注入子代理判定时 s8 当闲置行,名额已满被折叠。
  const plain = buildSidebarSections({ ...input, isRunningSubagentRoot: null });
  assert.deepEqual(plain.sections[0].rows.map((item) => item.sessionId), ["s1", "s2", "s3", "s4", "s5", "s7", "s9"]);
  assert.equal(plain.sections[0].hiddenCount, 2);
});

test("运行中行不占名额,但整组折叠时照样一行不画;单列表上限不受影响", () => {
  const ids = ["s1", "s2", "s3"];
  const sessions = ids.map((id) => session(id, { running: true }));
  const collapsed = buildSidebarSections({
    sessions, workspaces: [workspace("ws1", ids)], collapsedGroupIds: ["ws1"], rowLimit: 1
  });
  assert.deepEqual(collapsed.sections[0].rows, []);
  const flat = buildSidebarSections({ sessions, groupBy: SidebarGroupBy.flat, rowLimit: 1 });
  assert.equal(flat.sections[0].rows.length, 3, "单列表走 FLAT_ROW_LIMIT,与 rowLimit 无关");
});

test("拖到最后一条渲染行之后:锚点取完整列表里紧跟其前一行的折叠行", async () => {
  const { resolveReorder } = await import("../src/features/sessions/sidebar-reorder.js");
  // 折叠组画出 s1,s2 与运行中的 s5;s3,s4 被折起。
  const full = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const visible = ["s1", "s2", "s5"];
  // s1 拖到 s5 之后 → 落在 s5 与 s6 之间。
  assert.deepEqual(resolveReorder({ movedId: "s1", overId: "s5", after: true, visible, full }), { movedId: "s1", beforeId: "s6" });
  // s5 拖到 s2 之后 = 原位 → null;拖到 s1 之前 → 锚点取渲染序里的下一行。
  assert.deepEqual(resolveReorder({ movedId: "s5", overId: "s2", after: true, visible, full }), null);
  assert.deepEqual(resolveReorder({ movedId: "s5", overId: "s1", after: false, visible, full }), { movedId: "s5", beforeId: "s1" });
  // 前缀场景保持原语义:s1 拖到 s2 之后 → 锚点是第一条折叠行 s3。
  assert.deepEqual(resolveReorder({ movedId: "s1", overId: "s2", after: true, visible: ["s1", "s2"], full }), { movedId: "s1", beforeId: "s3" });
  // 真到末尾 → null。
  assert.deepEqual(resolveReorder({ movedId: "s1", overId: "s6", after: true, visible: full, full }), { movedId: "s1", beforeId: null });
});

test("置顶区排在最前,并且置顶行不再出现在下面的分组里", () => {
  const { sections, renderedIds } = buildSidebarSections({
    sessions: [session("a"), session("b"), session("loose")],
    workspaces: [workspace("ws1", ["a", "b"])],
    pinnedIds: ["b"],
    orderBy: "manual",
    sortRows: (rows) => rows
  });
  assert.equal(sections[0].kind, "pinned");
  assert.deepEqual(sections[0].rows.map((item) => item.sessionId), ["b"]);
  assert.deepEqual(sections[1].rows.map((item) => item.sessionId), ["a"]);
  assert.deepEqual(renderedIds, ["b", "a", "loose"]);
});

test("置顶账本里已经不在名册上的 id 被跳过,不会凭空多出一行", () => {
  const { sections } = buildSidebarSections({
    sessions: [session("a")],
    pinnedIds: ["gone", "a"],
    groupBy: SidebarGroupBy.flat
  });
  assert.deepEqual(sections[0].rows.map((item) => item.sessionId), ["a"]);
});

test("单列表:没有分组、没有截断,顺序全交给排序器", () => {
  const { sections, renderedIds } = buildSidebarSections({
    sessions: [session("a", { updatedAt: 1 }), session("b", { updatedAt: 9 }), session("c", { updatedAt: 5 })],
    workspaces: [workspace("ws1", ["a"])],
    groupBy: SidebarGroupBy.flat,
    orderBy: "updated"
  });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, FLAT_GROUP_ID);
  assert.deepEqual(renderedIds, ["b", "c", "a"]);
});

test("单列表一次最多画 FLAT_ROW_LIMIT 行,其余记进 hiddenCount", async () => {
  const { FLAT_ROW_LIMIT } = await import("../src/features/sessions/sidebar-sections.js");
  const ids = Array.from({ length: FLAT_ROW_LIMIT + 7 }, (_, index) => `s${index}`);
  const { sections, renderedIds } = buildSidebarSections({
    sessions: ids.map((id) => session(id)),
    groupBy: SidebarGroupBy.flat,
    orderBy: "manual",
    sortRows: (rows) => rows
  });
  assert.equal(sections[0].rows.length, FLAT_ROW_LIMIT);
  assert.equal(sections[0].hiddenCount, 7);
  assert.equal(renderedIds.length, FLAT_ROW_LIMIT);
});

test("单列表模式下置顶区照样在最上面(分组轴不影响它)", () => {
  const { sections } = buildSidebarSections({
    sessions: [session("a"), session("b")],
    pinnedIds: ["b"],
    groupBy: SidebarGroupBy.flat
  });
  assert.deepEqual(sections.map((item) => item.id), [PINNED_GROUP_ID, FLAT_GROUP_ID]);
});

test("排序器拿到的是本组成员与宿主名单,status 档由它自己决定顺序", () => {
  const seen = [];
  buildSidebarSections({
    sessions: [session("a"), session("b")],
    workspaces: [workspace("ws1", ["a", "b"])],
    orderBy: "status",
    sortRows: (rows, orderBy, ids) => { seen.push([rows.map((r) => r.sessionId), orderBy, ids]); return rows; }
  });
  assert.deepEqual(seen, [[["a", "b"], "status", ["a", "b"]]]);
});
