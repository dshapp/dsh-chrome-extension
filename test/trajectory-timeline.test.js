import { describe, it, expect } from "vitest";
import {
  TimelineMode, laneFor, deriveTrajectoryTimeline, timelineFocusIds,
  timelineModeLabel, formatTimelineOffset, formatClock
} from "../src/features/trajectory/trajectory-timeline.js";

function record(id, kind, extra = {}) {
  return { id, kind, text: id, ...extra };
}

function turnsWith(records) {
  return [{ id: "turn:1", turn: 1, groups: [{ id: "g", kind: { type: "step", step: 1 }, records }] }];
}

describe("laneFor", () => {
  it("工具/子工具走工具道,助手/压缩走模型道,其余走输入道", () => {
    expect(laneFor("tool")).toBe(2);
    expect(laneFor("subtool")).toBe(2);
    expect(laneFor("assistant")).toBe(1);
    expect(laneFor("compacted")).toBe(1);
    expect(laneFor("user")).toBe(0);
    expect(laneFor("system")).toBe(0);
    expect(laneFor("context")).toBe(0);
  });
});

describe("deriveTrajectoryTimeline sequence", () => {
  it("每个记录一个等宽槽位,跳过 requestOnly", () => {
    const turns = turnsWith([
      record("u", "user", { startedAt: 1000, durationSeconds: 1 }),
      record("a", "assistant", { startedAt: 1500, durationSeconds: 2 }),
      record("t", "tool", { startedAt: 2000, durationSeconds: 0.5 }),
      record("ro", "assistant", { requestOnly: true, startedAt: 1600, durationSeconds: 0 })
    ]);
    const model = deriveTrajectoryTimeline(turns, TimelineMode.sequence);
    expect(model.spans.map((s) => s.id)).toEqual(["u", "a", "t"]);
    expect(model.spans.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(model.spans.map((s) => s.lane)).toEqual([0, 1, 2]);
    expect(model.start).toBe(0);
    expect(model.end).toBe(3);
    expect(model.turnBoundaries).toEqual([{ turn: 1, time: 0 }]);
  });

  it("没有任何记录返回 null", () => {
    expect(deriveTrajectoryTimeline(turnsWith([]))).toBeNull();
  });
});

describe("deriveTrajectoryTimeline duration", () => {
  it("按实际起止时间投影", () => {
    const turns = turnsWith([
      record("u", "user", { startedAt: 1000, durationSeconds: 1 }),
      record("a", "assistant", { startedAt: 1500, durationSeconds: 2 }),
      record("t", "tool", { startedAt: 2000, durationSeconds: 0.5 })
    ]);
    const model = deriveTrajectoryTimeline(turns, TimelineMode.duration);
    expect(model.start).toBe(1000);
    expect(model.end).toBe(3500);
    expect(model.spans.map((s) => [s.id, s.start, s.end])).toEqual([
      ["u", 1000, 2000], ["a", 1500, 3500], ["t", 2000, 2500]
    ]);
  });

  it("压缩空闲间隙", () => {
    const turns = turnsWith([
      record("u", "user", { startedAt: 0, durationSeconds: 1 }),
      record("t", "tool", { startedAt: 3000, durationSeconds: 1 })
    ]);
    const model = deriveTrajectoryTimeline(turns, TimelineMode.duration);
    expect(model.start).toBe(0);
    expect(model.end).toBe(2000);
    expect(model.spans.map((s) => [s.id, s.start, s.end])).toEqual([
      ["u", 0, 1000], ["t", 1000, 2000]
    ]);
  });

  it("没有计时数据返回 null", () => {
    const turns = turnsWith([record("u", "user")]);
    expect(deriveTrajectoryTimeline(turns, TimelineMode.duration)).toBeNull();
  });
});

describe("timelineFocusIds", () => {
  it("闭区间取重叠的记录", () => {
    const turns = turnsWith([record("a", "user"), record("b", "assistant"), record("c", "tool")]);
    const model = deriveTrajectoryTimeline(turns, TimelineMode.sequence);
    expect([...timelineFocusIds(model, { start: 1, end: 1 })]).toEqual(["a", "b"]);
    expect([...timelineFocusIds(model, { start: 2, end: 2 })]).toEqual(["b", "c"]);
  });
  it("没有区间时返回空集合", () => {
    const model = deriveTrajectoryTimeline(turnsWith([record("a", "user")]));
    expect(timelineFocusIds(model, null).size).toBe(0);
  });
});

describe("格式化", () => {
  it("模式名与毫秒/墙钟格式", () => {
    expect(timelineModeLabel(TimelineMode.sequence)).toBe("顺序");
    expect(timelineModeLabel(TimelineMode.duration)).toBe("时长");
    expect(formatTimelineOffset(1500.4)).toBe("1500 ms");
    expect(formatTimelineOffset(null)).toBe("");
    expect(formatClock(Date.UTC(2020, 0, 1, 3, 4, 5, 6))).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});
