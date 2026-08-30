// 会话行尾部判定 —— 用例照搬自 macOS Tests/DSHMacKitTests/SessionAwaitingUserTests.swift,
// 保证两端在同一份语义下不会各自漂移。
import { describe, it, expect } from "vitest";
import {
  resolveSessionRowTrailing, isAwaitingUserTrailing, formatRelativeTime,
  SessionAwaitingKind, SessionRowTrailingKind
} from "../src/features/sessions/session-row-trailing.js";

const base = { isSelected: false, isArchived: false, isBlank: false, updatedAt: 1 };
const T = SessionRowTrailingKind;

describe("会话行尾部内容判定", () => {
  it("后台会话被卡住时,报告卡在哪一类请求,而不是报时间", () => {
    expect(resolveSessionRowTrailing({ ...base, awaitingUser: SessionAwaitingKind.approval }))
      .toEqual({ kind: T.awaitingUser, awaiting: SessionAwaitingKind.approval });
    expect(resolveSessionRowTrailing({ ...base, awaitingUser: SessionAwaitingKind.question }))
      .toEqual({ kind: T.awaitingUser, awaiting: SessionAwaitingKind.question });
  });

  it("打开着的那个会话保留时间戳(卡片已经就在眼前)", () => {
    expect(resolveSessionRowTrailing({
      ...base, awaitingUser: SessionAwaitingKind.approval, isSelected: true, updatedAt: 7
    })).toEqual({ kind: T.time, updatedAt: 7 });
  });

  it("未卡住的行显示时间;归档行与空白行什么都不显示", () => {
    expect(resolveSessionRowTrailing({ ...base, awaitingUser: null, updatedAt: 42 }))
      .toEqual({ kind: T.time, updatedAt: 42 });
    expect(resolveSessionRowTrailing({
      ...base, awaitingUser: SessionAwaitingKind.approval, isArchived: true, updatedAt: 42
    })).toEqual({ kind: T.none });
    expect(resolveSessionRowTrailing({
      ...base, awaitingUser: SessionAwaitingKind.question, isBlank: true, updatedAt: 42
    })).toEqual({ kind: T.none });
  });

  it("有未发送草稿的行,用草稿代替时间", () => {
    expect(resolveSessionRowTrailing({ ...base, hasDraft: true, updatedAt: 42 }))
      .toEqual({ kind: T.draft });
  });

  it("卡住的轮次优先于草稿", () => {
    expect(resolveSessionRowTrailing({
      ...base, awaitingUser: SessionAwaitingKind.question, hasDraft: true
    })).toEqual({ kind: T.awaitingUser, awaiting: SessionAwaitingKind.question });
  });

  it("打开着的会话连草稿徽章也不升起", () => {
    expect(resolveSessionRowTrailing({ ...base, isSelected: true, hasDraft: true, updatedAt: 9 }))
      .toEqual({ kind: T.time, updatedAt: 9 });
  });

  it("isAwaitingUserTrailing 只认卡住那一类", () => {
    expect(isAwaitingUserTrailing({ kind: T.awaitingUser, awaiting: SessionAwaitingKind.approval })).toBe(true);
    expect(isAwaitingUserTrailing({ kind: T.draft })).toBe(false);
    expect(isAwaitingUserTrailing({ kind: T.time, updatedAt: 1 })).toBe(false);
    expect(isAwaitingUserTrailing({ kind: T.none })).toBe(false);
  });
});

// 分档与 macOS SidebarRoot.relativeTime 一一对应。
const tf = (key, params) => (params ? `${key}:${params.n}` : key);
const NOW = 1_000_000_000_000;

describe("相对时间分档", () => {
  const at = (msAgo) => formatRelativeTime(NOW - msAgo, tf, NOW);

  it("一分钟以内是「刚刚」", () => {
    expect(at(0)).toBe("time.now");
    expect(at(59_000)).toBe("time.now");
  });

  it("分钟 / 小时 / 天 / 月 / 年 各自分档", () => {
    expect(at(60_000)).toBe("time.minutes:1");
    expect(at(59 * 60_000)).toBe("time.minutes:59");
    expect(at(3_600_000)).toBe("time.hours:1");
    expect(at(23 * 3_600_000)).toBe("time.hours:23");
    expect(at(86_400_000)).toBe("time.days:1");
    expect(at(29 * 86_400_000)).toBe("time.days:29");
    expect(at(30 * 86_400_000)).toBe("time.months:1");
    expect(at(364 * 86_400_000)).toBe("time.months:12");
    expect(at(365 * 86_400_000)).toBe("time.years:1");
  });

  it("向下取整,不四舍五入", () => {
    expect(at(90_000)).toBe("time.minutes:1");        // 1.5 分钟
    expect(at(2 * 3_600_000 - 1)).toBe("time.hours:1");
  });

  it("未来时间戳不产生负数", () => {
    expect(formatRelativeTime(NOW + 60_000, tf, NOW)).toBe("time.now");
  });

  it("非法 updatedAt 不会渲染出 NaN", () => {
    expect(formatRelativeTime(NaN, tf, NOW)).not.toContain("NaN");
    expect(formatRelativeTime(undefined, tf, NOW)).not.toContain("NaN");
    expect(formatRelativeTime(Infinity, tf, NOW)).toBe("time.now");
  });
});
