import { describe, it, expect } from "vitest";
import { createSessionStore } from "../src/features/sessions/session-store.js";
import { NodeKind, AssistantStatus } from "../src/features/sessions/chat-nodes.js";

let seq = 0;
function ev(type, data) { return { type, seq: seq++, time: 1000 + seq, data }; }
function fresh() { seq = 0; const s = createSessionStore(); s.reset("s1"); return s; }
const byKind = (s, kind) => s.getSnapshot().nodes.filter((n) => n.kind === kind);
const assistant = (s) => byKind(s, NodeKind.assistant)[0];

// 对齐 dsh-macapp SessionStore 的 live 旁路帧与 assistant/attempt 结算(DSH 1.5)。
describe("DSH 1.5 live 旁路与 attempt 结算", () => {
  it("start + block-start + text-delta 累积出 assistant 行", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyAssistantStreamFrame({ type: "start", attemptId: "a1", turn: 1, step: 0, startedAfterSeq: 0 });
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "a1", time: 1050, chunk: { type: "block-start", index: 0, blockType: "text" } });
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "a1", time: 1100, chunk: { type: "text-delta", index: 0, text: "He" } });
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "a1", time: 1110, chunk: { type: "text-delta", index: 0, text: "llo" } });
    const a = assistant(s);
    expect(a).toBeTruthy();
    expect(a.blocks[0].text).toBe("Hello");
    expect(a.status).toBe(AssistantStatus.running);
  });

  it("从未见过 start 的 chunk 被丢弃", () => {
    const s = fresh();
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "ghost", time: 1100, chunk: { type: "text-delta", index: 0, text: "x" } });
    expect(byKind(s, NodeKind.assistant)).toHaveLength(0);
  });

  it("end 后到达的 chunk 被丢弃", () => {
    const s = fresh();
    s.applyAssistantStreamFrame({ type: "start", attemptId: "a1", turn: 1, step: 0, startedAfterSeq: 0 });
    s.applyAssistantStreamFrame({ type: "end", attemptId: "a1" });
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "a1", time: 1100, chunk: { type: "text-delta", index: 0, text: "late" } });
    expect(byKind(s, NodeKind.assistant)).toHaveLength(0);
  });

  it("assistant/message 覆盖 live 内容并结算", () => {
    const s = fresh();
    s.applyAssistantStreamFrame({ type: "start", attemptId: "a1", turn: 1, step: 0, startedAfterSeq: 0 });
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "a1", time: 1050, chunk: { type: "block-start", index: 0, blockType: "text" } });
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "a1", time: 1100, chunk: { type: "text-delta", index: 0, text: "partial" } });
    s.applyEvent(ev("assistant/message", { turn: 1, step: 0, message: { id: "am1", content: [{ type: "text", text: "final" }] } }));
    const a = assistant(s);
    expect(a.blocks[0].text).toBe("final");
    expect(a.status).toBe(AssistantStatus.settled);
  });

  it("assistant/attempt 冷历史从内嵌 stream 恢复并结算为 interrupted", () => {
    const s = fresh();
    s.applyEvent(ev("assistant/attempt", {
      turn: 1, step: 0,
      stream: [
        { type: "chunk", time: 1050, chunk: { type: "block-start", index: 0, blockType: "text" } },
        { type: "text-chunks", time0: 1100, index: 0, dt: [10], texts: ["ab", "c"] }
      ]
    }));
    const a = assistant(s);
    expect(a).toBeTruthy();
    expect(a.blocks[0].text).toBe("abc");
    expect(a.status).toBe(AssistantStatus.interrupted);
    expect(a.interrupted).toBe(true);
  });

  it("baseline 恢复半截 attempt(含 block-start),后续 chunk 继续累积", () => {
    const s = fresh();
    s.applyAssistantStreamBaseline({
      revision: 2,
      activeAttempt: {
        attemptId: "a1", startedAfterSeq: 0, turn: 1, step: 0, nextIndex: 2,
        stream: [
          { type: "chunk", time: 1050, chunk: { type: "block-start", index: 0, blockType: "text" } },
          { type: "text-chunks", time0: 1100, index: 0, dt: [], texts: ["pre"] }
        ]
      }
    });
    // 恢复后继续到达的 chunk 应追加到 baseline 已画的内容之后。
    s.applyAssistantStreamFrame({ type: "chunk", attemptId: "a1", time: 1200, chunk: { type: "text-delta", index: 0, text: "fix" } });
    const a = assistant(s);
    expect(a.blocks[0].text).toBe("prefix");
    expect(a.status).toBe(AssistantStatus.running);
  });
});
