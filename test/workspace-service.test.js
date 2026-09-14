import { describe, expect, it, vi } from "vitest";
import { createWorkspaceService } from "../src/features/workspaces/workspace-service.js";

function harness() {
  let onFrame;
  const connection = {
    subscribe: vi.fn(),
    onFrame: vi.fn((listener) => { onFrame = listener; return () => {}; }),
    call: vi.fn()
  };
  const onArchivedChange = vi.fn();
  const service = createWorkspaceService(connection, { onArchivedChange });
  return { service, connection, onFrame, onArchivedChange };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function baseline(onFrame, items) {
  onFrame({ type: "item", streamId: "workspaces", value: {
    type: "baseline", value: { items, archivedSessionIds: [] }
  } });
}

function upsert(onFrame, workspace) {
  onFrame({ type: "item", streamId: "workspaces", value: { type: "upsert", workspace } });
}

describe("workspace/follow 归档集合", () => {
  it("从 baseline 读取并发布 archivedSessionIds", () => {
    const { service, onFrame, onArchivedChange } = harness();
    onFrame({ type: "item", streamId: "workspaces", value: {
      type: "baseline",
      value: { items: [{ workspaceId: "w1" }], archivedSessionIds: ["s1"] }
    } });
    expect(service.workspaces).toEqual([{ workspaceId: "w1" }]);
    expect(service.archivedSessionIds).toEqual(["s1"]);
    expect(onArchivedChange).toHaveBeenLastCalledWith(["s1"]);
  });

  it("应用 archived 增量并通知消费者", () => {
    const { service, onFrame, onArchivedChange } = harness();
    onFrame({ type: "item", streamId: "workspaces", value: {
      type: "archived", archivedSessionIds: ["s2", "s3"]
    } });
    expect(service.archivedSessionIds).toEqual(["s2", "s3"]);
    expect(onArchivedChange).toHaveBeenLastCalledWith(["s2", "s3"]);
  });
});

describe("宿主打开路径", () => {
  it("openPath 不带 action;revealPath 带 action:'reveal'", async () => {
    const { service, connection } = harness();
    connection.call.mockResolvedValue({});
    await service.openPath("/work/a.txt");
    expect(connection.call).toHaveBeenLastCalledWith("session/openWorkspacePath", {
      request: { path: "/work/a.txt" }
    });
    await service.revealPath("/work/a.txt");
    expect(connection.call).toHaveBeenLastCalledWith("session/openWorkspacePath", {
      request: { path: "/work/a.txt", action: "reveal" }
    });
  });
});

describe("目录选择器返回值", () => {
  it("接受 DSH 0.1.2 的 string | null 协议", async () => {
    const { service, connection } = harness();
    connection.call.mockResolvedValueOnce("/tmp/picked-workspace");

    await expect(service.pickDirectory()).resolves.toBe("/tmp/picked-workspace");
    expect(connection.call).toHaveBeenCalledWith("directoryPicker/pick", {}, 120000);

    connection.call.mockResolvedValueOnce(null);
    await expect(service.pickDirectory()).resolves.toBeNull();
  });
});

describe("workspace 删除 tombstone", () => {
  it("迟到的 upsert 与旧 baseline 不能复活已删除 workspace", () => {
    const { service, onFrame } = harness();
    baseline(onFrame, [{ workspaceId: "gone", title: "Before" }, { workspaceId: "keep" }]);
    onFrame({ type: "item", streamId: "workspaces", value: {
      type: "remove", workspaceId: "gone"
    } });
    upsert(onFrame, { workspaceId: "gone", title: "Late" });
    baseline(onFrame, [{ workspaceId: "gone", title: "Stale" }, { workspaceId: "keep" }]);
    expect(service.workspaces).toEqual([{ workspaceId: "keep" }]);
  });
});

describe("workspace mutation 与 follow 并发", () => {
  it("upsert 替换原位置，不会把改名的 workspace 推到末尾", () => {
    const { service, onFrame } = harness();
    baseline(onFrame, [{ workspaceId: "a", title: "A" }, { workspaceId: "b", title: "B" }]);
    upsert(onFrame, { workspaceId: "a", title: "Remote" });
    expect(service.workspaces).toEqual([
      { workspaceId: "a", title: "Remote" },
      { workspaceId: "b", title: "B" }
    ]);
  });

  it("成功移动采用宿主权威顺序", async () => {
    const { service, connection, onFrame } = harness();
    baseline(onFrame, ["a", "b", "c"].map((workspaceId) => ({ workspaceId })));
    connection.call.mockResolvedValue({ workspaceIds: ["a", "c", "b"] });
    await expect(service.moveWorkspace("c", "a")).resolves.toBe(true);
    expect(service.workspaces.map((row) => row.workspaceId)).toEqual(["a", "c", "b"]);
  });

  it("失败回滚只恢复原 workspace 顺序，保留并发新增和元数据", async () => {
    const { service, connection, onFrame } = harness();
    baseline(onFrame, [
      { workspaceId: "a", title: "A" },
      { workspaceId: "b", title: "B" }
    ]);
    const gate = deferred();
    connection.call.mockReturnValue(gate.promise);
    const moving = service.moveWorkspace("b", "a");
    expect(service.workspaces.map((row) => row.workspaceId)).toEqual(["b", "a"]);
    upsert(onFrame, { workspaceId: "a", title: "Remote" });
    upsert(onFrame, { workspaceId: "new", title: "New" });
    gate.reject(new Error("offline"));
    await expect(moving).resolves.toBe(false);
    expect(service.workspaces).toEqual([
      { workspaceId: "a", title: "Remote" },
      { workspaceId: "b", title: "B" },
      { workspaceId: "new", title: "New" }
    ]);
  });

  it("较新的 follow 顺序胜出，不被旧 mutation 回包覆盖", async () => {
    const { service, connection, onFrame } = harness();
    baseline(onFrame, ["a", "b", "c"].map((workspaceId) => ({ workspaceId })));
    const gate = deferred();
    connection.call.mockReturnValue(gate.promise);
    const moving = service.moveWorkspace("c", "a");
    onFrame({ type: "item", streamId: "workspaces", value: {
      type: "order", workspaceIds: ["b", "c", "a"]
    } });
    gate.resolve({ workspaceIds: ["a", "c", "b"] });
    await expect(moving).resolves.toBe(true);
    expect(service.workspaces.map((row) => row.workspaceId)).toEqual(["b", "c", "a"]);
  });

  it("成功移动会话只采用权威 sessionIds，保留并发 workspace 元数据", async () => {
    const { service, connection, onFrame } = harness();
    baseline(onFrame, [{ workspaceId: "a", title: "A", sessionIds: ["one", "two"] }]);
    const gate = deferred();
    connection.call.mockReturnValue(gate.promise);
    const moving = service.moveSession("a", "one", null);
    expect(service.workspaces[0].sessionIds).toEqual(["two", "one"]);
    upsert(onFrame, { workspaceId: "a", title: "Remote", sessionIds: ["two", "one"] });
    gate.resolve({ workspace: { workspaceId: "a", title: "Stale", sessionIds: ["one", "two"] } });
    await expect(moving).resolves.toBe(true);
    expect(service.workspaces[0]).toEqual({
      workspaceId: "a", title: "Remote", sessionIds: ["one", "two"]
    });
  });

  it("失败移动会话仅回滚 sessionIds，保留并发 workspace 元数据", async () => {
    const { service, connection, onFrame } = harness();
    baseline(onFrame, [{ workspaceId: "a", title: "A", sessionIds: ["one", "two"] }]);
    const gate = deferred();
    connection.call.mockReturnValue(gate.promise);
    const moving = service.moveSession("a", "one", null);
    upsert(onFrame, { workspaceId: "a", title: "Remote", sessionIds: ["two", "one"] });
    gate.reject(new Error("offline"));
    await expect(moving).resolves.toBe(false);
    expect(service.workspaces[0]).toEqual({
      workspaceId: "a", title: "Remote", sessionIds: ["one", "two"]
    });
  });
});
