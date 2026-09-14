// live 旁路连续性闸门(web acceptFrame / mac foldAssistantStreamFrame):
// chunk/end 的 index 必须与期望的 nextIndex 稠密连续,start 不得叠加;失序丢帧并重开一次 follow。
import { describe, expect, it, vi } from "vitest";
import { createSessionService } from "../src/features/sessions/session-service.js";

function service() {
  const followSubs = [];
  const conn = {
    call: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn((id) => { if (String(id).startsWith("follow:")) followSubs.push(id); }),
    unsubscribe: vi.fn()
  };
  const svc = createSessionService(conn);
  return { svc, conn, followSubs };
}

function frame(svc, payload) {
  svc.handleMuxFrame({ streamId: "follow:s1", type: "item", value: payload });
}

const chunk = (index) => ({ type: "chunk", attemptId: "a1", index, time: 1000 + index, chunk: { type: "text-delta", index: 0, text: "x" } });

describe("assistant-stream 连续性闸门", () => {
  it("稠密连续的 start/chunk/end 全部接受,不重开 follow", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, { type: "snapshot", cursor: 0, messages: [] });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a1", turn: 1, step: 0, startedAfterSeq: 0 } });
    frame(svc, { type: "assistant-stream", frame: chunk(0) });
    frame(svc, { type: "assistant-stream", frame: chunk(1) });
    frame(svc, { type: "assistant-stream", frame: { type: "end", attemptId: "a1", index: 2 } });
    expect(followSubs).toEqual(["follow:s1"]);
  });

  it("chunk index 失序触发丢帧并重开一次 follow", async () => {
    const { svc, conn, followSubs } = service();
    await svc.open("s1");
    frame(svc, { type: "snapshot", cursor: 0, messages: [] });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a1", turn: 1, step: 0, startedAfterSeq: 0 } });
    frame(svc, { type: "assistant-stream", frame: chunk(0) });
    frame(svc, { type: "assistant-stream", frame: chunk(2) }); // 期望 1,收到 2 → 失序
    expect(followSubs).toEqual(["follow:s1", "follow:s1"]);
    expect(conn.unsubscribe).toHaveBeenCalledWith("follow:s1");
  });

  it("end index 失序同样重开 follow", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, { type: "snapshot", cursor: 0, messages: [] });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a1", turn: 1, step: 0, startedAfterSeq: 0 } });
    frame(svc, { type: "assistant-stream", frame: chunk(0) });
    frame(svc, { type: "assistant-stream", frame: { type: "end", attemptId: "a1", index: 3 } }); // 期望 1 → 失序
    expect(followSubs).toEqual(["follow:s1", "follow:s1"]);
  });

  it("start 叠加在未结束的 attempt 上触发重开", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, { type: "snapshot", cursor: 0, messages: [] });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a1", turn: 1, step: 0, startedAfterSeq: 0 } });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a2", turn: 1, step: 1, startedAfterSeq: 5 } });
    expect(followSubs).toEqual(["follow:s1", "follow:s1"]);
  });

  it("幽灵 attempt 的 chunk(无 baseline)静默丢弃,不重开", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, { type: "snapshot", cursor: 0, messages: [] });
    frame(svc, { type: "assistant-stream", frame: chunk(0) }); // 无 start,attempt 未采纳
    expect(followSubs).toEqual(["follow:s1"]);
  });

  it("baseline 采纳 activeAttempt.nextIndex,续帧从该位置继续", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, {
      type: "snapshot", cursor: 0, messages: [],
      assistantStream: { activeAttempt: { attemptId: "a1", startedAfterSeq: 0, turn: 1, step: 0, nextIndex: 2, stream: [] } }
    });
    frame(svc, { type: "assistant-stream", frame: chunk(2) }); // 期望 2 → 接受
    frame(svc, { type: "assistant-stream", frame: chunk(3) }); // 期望 3 → 接受
    frame(svc, { type: "assistant-stream", frame: { type: "end", attemptId: "a1", index: 4 } });
    expect(followSubs).toEqual(["follow:s1"]);
  });

  it("chunk 的 revision 与已采纳代际不符触发重开", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, { type: "snapshot", cursor: 0, messages: [] });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a1", revision: 1, turn: 1, step: 0, startedAfterSeq: 0 } });
    frame(svc, { type: "assistant-stream", frame: { ...chunk(0), revision: 2 } }); // 期望 2 → 接受
    frame(svc, { type: "assistant-stream", frame: { ...chunk(1), revision: 9 } }); // 期望 2 → 失序
    expect(followSubs).toEqual(["follow:s1", "follow:s1"]);
  });

  it("start revision===1 重置代际,不重开", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, { type: "snapshot", cursor: 0, messages: [] });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a1", revision: 1, turn: 1, step: 0, startedAfterSeq: 0 } });
    frame(svc, { type: "assistant-stream", frame: { ...chunk(0), revision: 2 } });
    frame(svc, { type: "assistant-stream", frame: { type: "start", attemptId: "a1", revision: 1, turn: 1, step: 1, startedAfterSeq: 9 } });
    expect(followSubs).toEqual(["follow:s1"]);
  });

  it("baseline 的 revision 被采纳,续帧必须 +1", async () => {
    const { svc, followSubs } = service();
    await svc.open("s1");
    frame(svc, {
      type: "snapshot", cursor: 0, messages: [],
      assistantStream: { revision: 4, activeAttempt: { attemptId: "a1", startedAfterSeq: 0, turn: 1, step: 0, nextIndex: 2, stream: [] } }
    });
    frame(svc, { type: "assistant-stream", frame: { ...chunk(2), revision: 5 } }); // 期望 5 → 接受
    frame(svc, { type: "assistant-stream", frame: { ...chunk(3), revision: 7 } }); // 期望 6 → 重开
    expect(followSubs).toEqual(["follow:s1", "follow:s1"]);
  });
});
