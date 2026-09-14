// turn rail 数据层:turnOutline 投影 + 加载窗口锚点合并进 snapshot.turnRail。
import { describe, it, expect } from "vitest";
import { createSessionStore } from "../src/features/sessions/session-store.js";

let seq = 0;
function ev(type, data, extra = {}) {
  return { type, seq: seq++, time: 1000 + seq, data, ...extra };
}
function fresh() {
  seq = 0;
  const store = createSessionStore();
  store.reset("s1");
  return store;
}

function turn(s, turn, text) {
  s.applyEvent(ev("turn/start", { turn }));
  s.applyEvent(ev("user/message", { message: { id: `m${turn}`, content: [{ type: "text", text }], source: { kind: "user" } } }));
  s.applyEvent(ev("turn/end", { turn }));
}

describe("snapshot.turnRail", () => {
  it("无投影时退化为加载窗口内的轮次,anchor 用首个 user 行", () => {
    const s = fresh();
    turn(s, 1, "hello world");
    turn(s, 2, "second turn");
    const rail = s.getSnapshot().turnRail;
    expect(rail.map((i) => i.turn)).toEqual([1, 2]);
    expect(rail[0].anchorRow).toBe("u-m1");
    expect(rail[0].prompt).toContain("hello world");
    expect(rail[1].anchorRow).toBe("u-m2");
    // 无投影时 seq 为 null(没有分页目标)。
    expect(rail[0].seq).toBeNull();
  });

  it("turnOutline 投影补齐窗口外的轮次(带 seq,无 anchor)", () => {
    const s = fresh();
    turn(s, 2, "only loaded turn");
    // 投影命名 turn 1(窗口外,未加载)与 turn 2(已加载)。
    s.applyProjection("turnOutline", [
      { turn: 1, seq: 0, prompt: "outline p1", response: "outline r1" },
      { turn: 2, seq: 9, prompt: "outline p2", response: "outline r2" }
    ], 99);
    const rail = s.getSnapshot().turnRail;
    expect(rail.map((i) => i.turn)).toEqual([1, 2]);
    expect(rail[0]).toMatchObject({ turn: 1, prompt: "outline p1", anchorRow: null, seq: 0 });
    // 已加载轮保留窗口锚点与预览,投影仅作空预览兜底。
    expect(rail[1].anchorRow).toBe("u-m2");
    expect(rail[1].prompt).toContain("only loaded turn");
  });

  it("投影 entry 损坏则丢弃(劣质 turn/seq 不成标)", () => {
    const s = fresh();
    turn(s, 1, "a");
    s.applyProjection("turnOutline", [
      { turn: 2 },                        // 缺 seq
      { turn: 1, seq: -1, prompt: "bad" } // seq 非法
    ], 99);
    const rail = s.getSnapshot().turnRail;
    expect(rail.map((i) => i.turn)).toEqual([1]);
  });
});
