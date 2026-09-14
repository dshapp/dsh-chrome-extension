import { describe, it, expect } from "vitest";
import { clipTurnPreview, mergeTurnRailItems, TurnRailPreview } from "../src/features/sessions/turn-rail.js";
import { resolveActiveTurn } from "../src/features/chat/turn-rail-view.js";

describe("clipTurnPreview", () => {
  it("空格拼接、折叠空白、截断加省略号", () => {
    expect(clipTurnPreview(["a   b", "c\n d"], 100)).toBe("a b c d");
    expect(clipTurnPreview(["x".repeat(200)], 50)).toBe(`${"x".repeat(49)}…`);
    expect(clipTurnPreview([], 50)).toBe("");
  });
});

describe("resolveActiveTurn", () => {
  const items = [
    { turn: 0, anchorRow: "a-0" },
    { turn: 1, anchorRow: null },
    { turn: 2, anchorRow: "a-2" },
    { turn: 3, anchorRow: "a-3" }
  ];
  const tops = { "a-0": -400, "a-2": 20, "a-3": 300 };

  it("取顶边越过视口顶部的最后一轮", () => {
    expect(resolveActiveTurn(items, 10, (row) => tops[row] ?? null)).toBe(2);
    expect(resolveActiveTurn(items, 400, (row) => tops[row] ?? null)).toBe(3);
  });

  it("全部在视口下方时回退第一个有锚点的轮", () => {
    expect(resolveActiveTurn(items, -1000, (row) => tops[row] ?? null)).toBe(0);
  });

  it("无锚点项直接跳过", () => {
    expect(resolveActiveTurn(items, 10, (row) => (row === "a-2" ? 20 : null))).toBe(2);
  });
});

describe("mergeTurnRailItems", () => {
  it("投影命名整本、窗口供锚点,合并且升序", () => {
    const outline = [
      { turn: 0, seq: 5, prompt: "p0", response: "r0" },
      { turn: 1, seq: 12, prompt: "p1", response: "" },
      { turn: 2, seq: 20, prompt: "p2", response: "r2" }
    ];
    const items = mergeTurnRailItems(outline, new Map([[1, "a-1:0"]]), (turn) => (turn === 1 ? { prompt: "loaded-p1", response: "loaded-r1" } : { prompt: "", response: "" }));
    expect(items).toEqual([
      { turn: 0, prompt: "p0", response: "r0", anchorRow: null, seq: 5 },
      { turn: 1, prompt: "loaded-p1", response: "loaded-r1", anchorRow: "a-1:0", seq: 12 },
      { turn: 2, prompt: "p2", response: "r2", anchorRow: null, seq: 20 }
    ]);
  });

  it("损坏的投影 entry(缺 turn/seq)丢弃,预览坏掉降级空串", () => {
    const outline = [
      { turn: 0, seq: 5, prompt: 42, response: null },
      { turn: 1, prompt: "no-seq" },
      { turn: -1, seq: 3, prompt: "", response: "" },
      { turn: 2, seq: 9, prompt: "p2", response: "r2" }
    ];
    const items = mergeTurnRailItems(outline, {}, () => ({ prompt: "", response: "" }));
    expect(items.map((i) => i.turn)).toEqual([0, 2]);
    expect(items[0].prompt).toBe("");
    expect(items[0].response).toBe("");
    expect(items[1].prompt).toBe("p2");
  });

  it("无投影时退化为仅加载窗口的轮", () => {
    const items = mergeTurnRailItems(null, new Map([[3, "a-3:0"], [4, "a-4:1"]]), (t) => ({ prompt: `p${t}`, response: `r${t}` }));
    expect(items.map((i) => i.turn)).toEqual([3, 4]);
    expect(items[0].anchorRow).toBe("a-3:0");
    expect(items[0].seq).toBeNull();
  });

  it("窗口预览为空时回退投影预览", () => {
    const outline = [{ turn: 1, seq: 12, prompt: "op", response: "or" }];
    const items = mergeTurnRailItems(outline, new Map([[1, "a-1:0"]]), () => ({ prompt: "", response: "" }));
    expect(items[0].prompt).toBe("op");
    expect(items[0].response).toBe("or");
    expect(items[0].anchorRow).toBe("a-1:0");
  });
});
