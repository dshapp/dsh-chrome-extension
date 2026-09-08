// 对齐 dsh-macapp d2e2529 的后半:follow 流失败必须落成终态,而不是只打日志。
//
// 宿主 resume 一条 preset 已被删除的会话时,mux 会在 follow: 流上回一帧
// type:"error"(agent-presets: preset "code" not found)。旧实现只 console.warn,
// 于是 UI 停在"正在加载对话…" —— 无历史、无报错、且 running 若为真则永远转圈。
import { describe, expect, it, vi } from "vitest";
import { createSessionService } from "../src/features/sessions/session-service.js";

function service() {
  return createSessionService({ call: vi.fn().mockResolvedValue({}), subscribe: vi.fn(), unsubscribe: vi.fn() });
}

const resumeError = { message: 'agent-presets: preset "code" not found (available: standard)' };

describe("follow 流错误落成终态", () => {
  it("当前会话的 follow 错误写入 historyError 并清掉 running", async () => {
    const svc = service();
    await svc.open("s1");
    svc.handleMuxFrame({ streamId: "follow:s1", type: "item", value: { type: "snapshot", cursor: 0, messages: [] } });
    svc.handleMuxFrame({
      streamId: "follow:s1", type: "item",
      value: { type: "entry", event: { type: "turn/start", data: { turn: 1 } } }
    });
    expect(svc.getRuntimeSnapshot().running).toBe(true);

    svc.handleMuxFrame({ streamId: "follow:s1", type: "error", error: resumeError });

    const snap = svc.getRuntimeSnapshot();
    expect(snap.historyError).toContain("preset");
    expect(snap.running).toBe(false);
  });

  it("空白会话合法返回 0 条历史,错误仍不被吞掉(不能带 historyLoaded 守卫)", async () => {
    const svc = service();
    await svc.open("blank");
    // 空白会话的 snapshot 合法为空,历史"已加载"。
    svc.handleMuxFrame({ streamId: "follow:blank", type: "item", value: { type: "snapshot", cursor: 0, messages: [] } });
    svc.handleMuxFrame({ streamId: "follow:blank", type: "error", error: resumeError });
    expect(svc.getRuntimeSnapshot().historyError).toContain("preset");
  });

  it("非当前会话的 follow 错误不污染当前会话", async () => {
    const svc = service();
    await svc.open("current");
    svc.handleMuxFrame({ streamId: "follow:other", type: "error", error: resumeError });
    expect(svc.getRuntimeSnapshot().historyError ?? null).toBeNull();
  });

  it("错误没有 message 时也给出可读文案,不留空字符串", async () => {
    const svc = service();
    await svc.open("s1");
    svc.handleMuxFrame({ streamId: "follow:s1", type: "error", error: {} });
    expect(svc.getRuntimeSnapshot().historyError).toBeTruthy();
  });
});
