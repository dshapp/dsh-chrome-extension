import { describe, it, expect } from "vitest";
import { resolveReorder, applyMove } from "../src/features/sessions/sidebar-reorder.js";

// 锚点用 id 而不是下标:历史浮层只渲染前 500 行,下标会对错数组。
describe("拖放解析", () => {
  const visible = ["a", "b", "c", "d"];

  it("拖到某行上半区 = 插到它前面", () => {
    expect(resolveReorder({ movedId: "d", overId: "b", after: false, visible }))
      .toEqual({ movedId: "d", beforeId: "b" });
  });

  it("拖到某行下半区 = 插到它后面", () => {
    expect(resolveReorder({ movedId: "a", overId: "b", after: true, visible }))
      .toEqual({ movedId: "a", beforeId: "c" });
  });

  it("拖到最后一行之后 = 移到末尾(beforeId 为 null)", () => {
    expect(resolveReorder({ movedId: "a", overId: "d", after: true, visible }))
      .toEqual({ movedId: "a", beforeId: null });
  });

  it("拖到列表空白处 = 移到末尾", () => {
    expect(resolveReorder({ movedId: "a", overId: null, visible }))
      .toEqual({ movedId: "a", beforeId: null });
  });

  it("拖回原位是 no-op", () => {
    expect(resolveReorder({ movedId: "b", overId: "b", visible })).toBeNull();
    expect(resolveReorder({ movedId: "b", overId: "c", after: false, visible })).toBeNull();
  });

  it("被拖的行不在可见集合里 → 拒绝", () => {
    expect(resolveReorder({ movedId: "zz", overId: "a", visible })).toBeNull();
  });

  it("落点行不在可见集合里 → 拒绝", () => {
    expect(resolveReorder({ movedId: "a", overId: "zz", visible })).toBeNull();
  });

  it("拖到最后一条渲染行之后、但后面还有折叠行:锚点取第一条折叠行", () => {
    // 渲染了 a b c,完整列表还有 d e —— 移到"末尾"其实是移到 d 之前,
    // 而不是整个列表的末尾,否则会跳过所有折叠起来的行。
    const move = resolveReorder({
      movedId: "a", overId: "c", after: true,
      visible: ["a", "b", "c"], full: ["a", "b", "c", "d", "e"]
    });
    expect(move).toEqual({ movedId: "a", beforeId: "d" });
  });
});

describe("把移动应用到顺序数组", () => {
  it("插到指定 id 之前", () => {
    expect(applyMove(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("beforeId 为 null 时追加到末尾", () => {
    expect(applyMove(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("beforeId 不存在时追加到末尾,不抛错", () => {
    expect(applyMove(["a", "b"], "a", "zz")).toEqual(["b", "a"]);
  });

  it("不改动原数组", () => {
    const input = ["a", "b", "c"];
    applyMove(input, "c", "a");
    expect(input).toEqual(["a", "b", "c"]);
  });
});
