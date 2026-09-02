import { describe, it, expect } from "vitest";
import { rankSession, sortByStatus, SessionStatusRank } from "../src/features/sessions/session-status-order.js";

// 档位顺序是产品规则,逐条钉住 —— 改动这些断言就是在改产品行为。
describe("状态档位", () => {
  it("正在跑排在最前", () => {
    expect(rankSession({ isRunning: true })).toBe(SessionStatusRank.running);
  });

  it("跑完未读:失败排在成功之前", () => {
    expect(rankSession({ isUnread: true, didFail: true })).toBe(SessionStatusRank.failedUnread);
    expect(rankSession({ isUnread: true, didFail: false })).toBe(SessionStatusRank.doneUnread);
  });

  it("审批排在提问之前", () => {
    expect(rankSession({ awaiting: "approval" })).toBe(SessionStatusRank.approval);
    expect(rankSession({ awaiting: "question" })).toBe(SessionStatusRank.question);
  });

  it("没名字的挂起标记按 approval 兜底", () => {
    expect(rankSession({ awaiting: "unknown-kind" })).toBe(SessionStatusRank.approval);
  });

  it("草稿低于一切「别人在等」的档,但高于空闲", () => {
    expect(rankSession({ hasDraft: true })).toBe(SessionStatusRank.draft);
    expect(SessionStatusRank.draft).toBeGreaterThan(SessionStatusRank.question);
    expect(SessionStatusRank.draft).toBeLessThan(SessionStatusRank.idle);
  });

  it("什么都没有就是 idle", () => {
    expect(rankSession({})).toBe(SessionStatusRank.idle);
  });

  it("同时命中多档时报最紧急的那个", () => {
    // 既在跑又带着未读完成、还有草稿 —— 报 running。
    expect(rankSession({ isRunning: true, isUnread: true, hasDraft: true }))
      .toBe(SessionStatusRank.running);
  });
});

describe("按状态排序", () => {
  const rows = [
    { sessionId: "idle-old", updatedAt: 1 },
    { sessionId: "running", updatedAt: 2 },
    { sessionId: "draft", updatedAt: 3 },
    { sessionId: "approval", updatedAt: 4 },
    { sessionId: "idle-new", updatedAt: 9 }
  ];
  const ranks = {
    running: SessionStatusRank.running,
    approval: SessionStatusRank.approval,
    draft: SessionStatusRank.draft,
    "idle-old": SessionStatusRank.idle,
    "idle-new": SessionStatusRank.idle
  };

  it("先按档,档内按最近更新倒序", () => {
    const out = sortByStatus(rows, (s) => ranks[s.sessionId]);
    expect(out.map((s) => s.sessionId))
      .toEqual(["running", "approval", "draft", "idle-new", "idle-old"]);
  });

  it("不改动传入的数组", () => {
    const input = [...rows];
    sortByStatus(input, (s) => ranks[s.sessionId]);
    expect(input.map((s) => s.sessionId)).toEqual(rows.map((s) => s.sessionId));
  });

  it("空输入安全", () => {
    expect(sortByStatus([], () => 0)).toEqual([]);
    expect(sortByStatus(null, () => 0)).toEqual([]);
  });
});
