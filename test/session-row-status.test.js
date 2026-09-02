// 行首状态灯的纯判定:优先级表 + 渲不渲染。
import { describe, it, expect } from "vitest";
import {
  resolveSessionRowStatus, shouldShowSessionRowStatus, SessionRowStatus as S
} from "../src/features/sessions/session-row-status.js";
import { SessionAwaitingKind, SessionRowTrailingKind } from "../src/features/sessions/session-row-trailing.js";

const awaitingTrailing = { kind: SessionRowTrailingKind.awaitingUser, awaiting: SessionAwaitingKind.approval };
const draftTrailing = { kind: SessionRowTrailingKind.draft };
const timeTrailing = { kind: SessionRowTrailingKind.time, updatedAt: 1 };

describe("resolveSessionRowStatus 优先级", () => {
  it("空闲 → done", () => {
    expect(resolveSessionRowStatus({})).toBe(S.done);
  });

  it("自身在跑 → ongoing", () => {
    expect(resolveSessionRowStatus({ running: true })).toBe(S.ongoing);
  });

  it("自身 idle 但子代理后裔在跑 → 仍是 ongoing", () => {
    expect(resolveSessionRowStatus({ running: false, runningSubagentRoot: true })).toBe(S.ongoing);
  });

  it("失败 → error", () => {
    expect(resolveSessionRowStatus({ errored: true })).toBe(S.error);
  });

  it("失败盖过 running(丢帧/乱序时红点不被陈旧 running 位盖住)", () => {
    expect(resolveSessionRowStatus({ errored: true, running: true })).toBe(S.error);
  });

  it("挂起盖过一切", () => {
    expect(resolveSessionRowStatus({
      awaitingUser: SessionAwaitingKind.approval, errored: true, running: true, runningSubagentRoot: true
    })).toBe(S.warning);
    expect(resolveSessionRowStatus({ awaitingUser: SessionAwaitingKind.question })).toBe(S.warning);
  });
});

describe("shouldShowSessionRowStatus", () => {
  it("普通空闲行不点灯", () => {
    expect(shouldShowSessionRowStatus({ status: S.done, trailing: timeTrailing })).toBe(false);
  });

  it("跑完未读 → 点绿灯", () => {
    expect(shouldShowSessionRowStatus({ status: S.done, completed: true, trailing: timeTrailing })).toBe(true);
  });

  it("在跑 / 失败都点灯", () => {
    expect(shouldShowSessionRowStatus({ status: S.ongoing, trailing: timeTrailing })).toBe(true);
    expect(shouldShowSessionRowStatus({ status: S.error, trailing: timeTrailing })).toBe(true);
  });

  it("trailing 已报「卡住」时不点灯 —— 同色警示不在一行上出现两次", () => {
    expect(shouldShowSessionRowStatus({ status: S.warning, trailing: awaitingTrailing })).toBe(false);
    // 连未读提醒也让位:那一行要说的是"去处理我",不是"我跑完了"。
    expect(shouldShowSessionRowStatus({ status: S.ongoing, completed: true, trailing: awaitingTrailing })).toBe(false);
  });

  it("草稿不豁免:输入框有没有留字与会话在跑/失败正交", () => {
    expect(shouldShowSessionRowStatus({ status: S.ongoing, trailing: draftTrailing })).toBe(true);
    expect(shouldShowSessionRowStatus({ status: S.error, trailing: draftTrailing })).toBe(true);
    expect(shouldShowSessionRowStatus({ status: S.done, completed: true, trailing: draftTrailing })).toBe(true);
  });

  it("归档 / 空白行永不点灯(哪怕带着失败位)", () => {
    expect(shouldShowSessionRowStatus({ status: S.error, isArchived: true, trailing: timeTrailing })).toBe(false);
    expect(shouldShowSessionRowStatus({ status: S.ongoing, isBlank: true, trailing: timeTrailing })).toBe(false);
  });
});
