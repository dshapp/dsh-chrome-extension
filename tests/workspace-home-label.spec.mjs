/**
 * 临时目录(宿主 cwd = 用户 home)的显示名契约。
 *
 * 未选工作目录建的会话落在用户 home。以前直接取 basename:mac 上显示成裸用户名,
 * Windows 上只按 "/" 切,整条 C:\\Users\\<name> 被原样摆进标题。现在统一叫 Home。
 *
 * 跑法:node --test tests/workspace-home-label.spec.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { isHomePath, pathBasename, workspaceDisplayName } = await import("../src/shared/workspace-path.js");
const { buildSidebarSections } = await import("../src/features/sessions/sidebar-sections.js");
const { deriveSearchResults } = await import("../src/features/sessions/session-search.js");

test("宿主报了 home:按它精确比较,分隔符/末尾斜杠/Windows 大小写都不影响", () => {
  assert.equal(isHomePath("/Users/alice", "/Users/alice"), true);
  assert.equal(isHomePath("/Users/alice/", "/Users/alice"), true);
  assert.equal(isHomePath("C:\\Users\\Alice", "C:\\Users\\Alice"), true);
  assert.equal(isHomePath("c:/users/alice\\", "C:\\Users\\Alice"), true);
  // home 之下的项目目录、别人的 home 都不是
  assert.equal(isHomePath("/Users/alice/repo", "/Users/alice"), false);
  assert.equal(isHomePath("/Users/bob", "/Users/alice"), false);
  assert.equal(isHomePath("C:\\Users\\Alice\\repo", "C:\\Users\\Alice"), false);
});

test("宿主还没报 home:按 mac / Windows / Linux 用户目录的形状兜底", () => {
  assert.equal(isHomePath("/Users/alice"), true);
  assert.equal(isHomePath("C:\\Users\\Alice"), true);
  assert.equal(isHomePath("D:/Users/Alice/"), true);
  assert.equal(isHomePath("/home/alice"), true);
  assert.equal(isHomePath("/Users/alice/repo"), false);
  assert.equal(isHomePath("C:\\Users\\Alice\\Desktop"), false);
  assert.equal(isHomePath("/tmp/x"), false);
  assert.equal(isHomePath(""), false);
});

test("显示名:home 简称 Home;其余取标题或目录名,Windows 路径也只取末段", () => {
  assert.equal(workspaceDisplayName({ path: "C:\\Users\\Alice" }), "Home");
  assert.equal(workspaceDisplayName({ path: "/Users/alice" }, { home: "/Users/alice", homeLabel: "Home" }), "Home");
  // 宿主自动起的标题(目录名 / 整条路径)同样换成 Home
  assert.equal(workspaceDisplayName({ title: "alice", path: "/Users/alice" }), "Home");
  assert.equal(workspaceDisplayName({ title: "C:\\Users\\Alice", path: "C:\\Users\\Alice" }), "Home");
  // 用户自己改过的标题照常尊重
  assert.equal(workspaceDisplayName({ title: "我的主目录", path: "/Users/alice" }), "我的主目录");
  assert.equal(workspaceDisplayName({ path: "C:\\Users\\Alice\\code\\repo" }), "repo");
  assert.equal(workspaceDisplayName({ path: "/Users/alice/repo/" }), "repo");
  assert.equal(pathBasename("C:\\Users\\Alice\\"), "Alice");
});

test("侧栏分组:home 工作区的组标题是 Home,其余不变", () => {
  const { sections } = buildSidebarSections({
    sessions: [{ sessionId: "a", updatedAt: 2 }, { sessionId: "b", updatedAt: 1 }],
    workspaces: [
      { workspaceId: "w-home", title: "Alice", path: "C:\\Users\\Alice", sessionIds: ["a"] },
      { workspaceId: "w-repo", title: "", path: "C:\\Users\\Alice\\repo", sessionIds: ["b"] }
    ],
    home: "C:\\Users\\Alice",
    homeLabel: "Home"
  });
  assert.deepEqual(sections.map((item) => item.title), ["Home", "repo"]);
  // 悬停提示仍给完整路径
  assert.equal(sections[0].hint, "C:\\Users\\Alice");
});

test("搜索:临时会话按 Home 命中,不再按用户名", () => {
  const sessions = [{ sessionId: "tmp", cwd: "/Users/alice", updatedAt: 1, projections: { values: { title: "x" } } }];
  const run = (query) => deriveSearchResults({
    sessions, workspaces: [], archivedIds: [], query, remote: { items: [], hasMore: false }, home: "/Users/alice", homeLabel: "Home"
  }).items.map((item) => item.sessionId);
  assert.deepEqual(run("home"), ["tmp"]);
  assert.deepEqual(run("alice"), []);
});
