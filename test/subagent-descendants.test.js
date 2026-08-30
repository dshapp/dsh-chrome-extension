import { describe, it, expect } from "vitest";
import {
  indexSubagentChildren, walkSubagentChildren, indexSubagentDescendants
} from "../src/features/sessions/session-list-store.js";

function s(sessionId, parentSessionId, overrides = {}) {
  return { sessionId, parentSessionId, origin: "subagent", running: false, ...overrides };
}

describe("indexSubagentChildren", () => {
  it("只保留 origin==subagent 且有 parent 的边", () => {
    const by = indexSubagentChildren([
      s("a", "root"),
      s("fork", "root", { origin: undefined }),
      s("orphan", undefined),
      s("b", "a")
    ]);
    expect([...by.keys()].sort()).toEqual(["a", "root"]);
    expect(by.get("root").map((x) => x.sessionId)).toEqual(["a"]);
    expect(by.get("a").map((x) => x.sessionId)).toEqual(["b"]);
  });
});

describe("indexSubagentDescendants", () => {
  it("统计 count 与 runningCount(链式)", () => {
    const d = indexSubagentDescendants([
      s("a", "root", { running: true }),
      s("b", "a"),
      s("c", "b")
    ], "root");
    expect(d).toEqual({ count: 3, runningCount: 1 });
  });

  it("普通 fork 处停下:fork 的子代理不计入祖先", () => {
    const d = indexSubagentDescendants([
      s("a", "root"),
      s("fork", "a", { origin: undefined }),
      s("fchild", "fork")
    ], "root");
    expect(d).toEqual({ count: 1, runningCount: 0 });
  });

  it("异常环不 hang、不重复计数", () => {
    // a(子于 root) -> x(子于 a) -> a2(同名 a 又宣称子于 x):visited 应跳过 a2。
    const d = indexSubagentDescendants([
      s("a", "root"),
      s("x", "a"),
      s("a", "x")
    ], "root");
    expect(d).toEqual({ count: 2, runningCount: 0 });
  });
});

describe("walkSubagentChildren", () => {
  it("空入参安全", () => {
    expect(walkSubagentChildren(null, "root")).toEqual({ count: 0, runningCount: 0 });
    expect(walkSubagentChildren(new Map(), undefined)).toEqual({ count: 0, runningCount: 0 });
  });
});
