import { describe, it, expect, beforeAll } from "vitest";
import {
  buildTurns, ledgerRows, visibleRows, collapsibleTurns, assistantIdsWithCalls,
  numberRequests, turnStartRowIds, flattenTurns, groupTitle
} from "../src/features/trajectory/trajectory-layout.js";
import { buildSearchMatches } from "../src/features/trajectory/trajectory-search.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));

const snapshot = {
  records: [
    { id: "sys", kind: "system", sourceSeq: 0, turn: null, step: null, previousPrompt: null, text: "sys" },
    { id: "u1", kind: "user", sourceSeq: 1, turn: 1, step: 0, text: "第一问", startedAt: 1000, durationSeconds: 0 },
    { id: "a1", kind: "assistant", sourceSeq: 3, turn: 1, step: 1, text: "回答", startedAt: 1000, durationSeconds: 2, requestId: "req1" },
    { id: "t1", kind: "tool", sourceSeq: 4, turn: 1, step: 1, text: "bash", toolName: "bash", inputDetail: "ls", startedAt: 1000, durationSeconds: 0.5, requestId: "req1" },
    { id: "a2", kind: "assistant", sourceSeq: 6, turn: 2, step: 1, text: "第二答", startedAt: 2000, durationSeconds: 1, requestId: "req2" },
    { id: "sub1", kind: "subtool", sourceSeq: 7, turn: 2, step: 1, text: "nested", toolName: "nested" }
  ],
  requests: [
    { id: "req1", purpose: "assistant", startSeq: 2, turn: 1, step: 1, status: "complete" },
    { id: "req2", purpose: "assistant", startSeq: 5, turn: 2, step: 1, status: "complete" }
  ]
};

describe("轨迹布局", () => {
  it("初始系统提示词排在最前,按轮次分组", () => {
    const turns = buildTurns(snapshot);
    expect(flattenTurns(turns)[0].id).toBe("sys");
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2]);
    const turn1 = turns[0];
    expect(turn1.id).toBe("turn:1");
    expect(turn1.groups.map((group) => group.kind.type)).toEqual(["message", "step"]);
    expect(turn1.groups[1].kind.step).toBe(1);
  });

  it("分组描述含耗时与工具名计数", () => {
    const turns = buildTurns(snapshot);
    const step = turns[0].groups.find((group) => group.kind.type === "step");
    expect(step.description).toContain("2,000 ms");
    expect(step.description).toContain("bash");
  });

  it("轮次/调用折叠集合与请求编号", () => {
    const turns = buildTurns(snapshot);
    expect([...collapsibleTurns(turns)].sort()).toEqual([1, 2]);
    expect([...assistantIdsWithCalls(turns)]).toEqual(["a1", "a2"]);
    const numbers = numberRequests(snapshot.requests);
    expect(numbers.get("req1")).toBe(1);
    expect(numbers.get("req2")).toBe(2);
  });

  it("首个非系统行是轮次起点", () => {
    const rows = ledgerRows(buildTurns(snapshot));
    const starts = turnStartRowIds(rows);
    expect(starts.has("u1")).toBe(true);
    expect(starts.has("sys")).toBe(false);
  });

  it("整轮折叠只留首行与摘要行", () => {
    const turns = buildTurns(snapshot);
    const rows = ledgerRows(turns);
    const visible = visibleRows(rows, turns, { collapsedTurns: new Set([1]) });
    expect(visible[0].id).toBe("sys");
    expect(visible[1].id).toBe("u1-folded");
    expect(visible[1].turnSummary).toContain("1 个步骤");
    expect(visible[1].turnSummary).toContain("1 次工具调用");
    // 第 2 轮未折叠,原样保留。
    expect(visible.some((row) => row.id === "a2")).toBe(true);
  });

  it("调用折叠隐藏助手行之后的工具/子工具行", () => {
    const turns = buildTurns(snapshot);
    const rows = ledgerRows(turns);
    const visible = visibleRows(rows, turns, { collapsedAssistants: new Set(["a1"]) });
    expect(visible.some((row) => row.id === "t1")).toBe(false);
    expect(visible.some((row) => row.id === "a2")).toBe(true);
  });

  it("搜索命中时只留命中行", () => {
    const turns = buildTurns(snapshot);
    const rows = ledgerRows(turns);
    const matches = buildSearchMatches(snapshot, "bash");
    expect(matches.has("t1")).toBe(true);
    const visible = visibleRows(rows, turns, { searchMatches: matches });
    expect(visible.map((row) => row.id)).toEqual(["t1"]);
  });

  it("空查询返回 null(不过滤)", () => {
    expect(buildSearchMatches(snapshot, "")).toBeNull();
  });

  it("分组标题本地化", () => {
    expect(groupTitle({ type: "step", step: 2 })).toBe("步骤 2");
    expect(groupTitle({ type: "message" })).toBe("消息");
  });
});
