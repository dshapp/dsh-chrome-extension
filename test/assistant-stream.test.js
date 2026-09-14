import { describe, it, expect } from "vitest";
import { expandAssistantStream } from "../src/features/sessions/assistant-stream.js";

// 对齐 dsh-macapp AssistantStreamExpansion.swift 的展开语义(DSH 1.5 内嵌 stream)。
describe("expandAssistantStream", () => {
  it("字面量 chunk 原样透传", () => {
    const out = expandAssistantStream([
      { type: "chunk", time: 100, chunk: { type: "usage", usage: { outputTokens: 7 } } }
    ]);
    expect(out).toEqual([{ time: 100, chunk: { type: "usage", usage: { outputTokens: 7 } } }]);
  });

  it("text-chunks 按 time0 + dt 还原每个成员", () => {
    const out = expandAssistantStream([
      { type: "text-chunks", time0: 100, index: 0, dt: [10, 20], texts: ["a", "b", "c"] }
    ]);
    expect(out).toEqual([
      { time: 100, chunk: { type: "text-delta", index: 0, text: "a" } },
      { time: 110, chunk: { type: "text-delta", index: 0, text: "b" } },
      { time: 130, chunk: { type: "text-delta", index: 0, text: "c" } }
    ]);
  });

  it("reasoning-chunks 展开为 reasoning-delta", () => {
    const out = expandAssistantStream([
      { type: "reasoning-chunks", time0: 50, index: 1, dt: [4], texts: ["r1", "r2"] }
    ]);
    expect(out[0].chunk.type).toBe("reasoning-delta");
    expect(out[1].chunk.type).toBe("reasoning-delta");
    expect(out[1].time).toBe(54);
  });

  it("tool-call-chunks 展开为 tool-call-delta,携带 id/name/argumentsDelta", () => {
    const out = expandAssistantStream([
      { type: "tool-call-chunks", time0: 200, index: 2, dt: [5], args: ["{\"a\"", "1}"], id: "c1", name: "bash" }
    ]);
    expect(out).toEqual([
      { time: 200, chunk: { type: "tool-call-delta", index: 2, argumentsDelta: "{\"a\"", id: "c1", name: "bash" } },
      { time: 205, chunk: { type: "tool-call-delta", index: 2, argumentsDelta: "1}", id: "c1", name: "bash" } }
    ]);
  });

  it("dt 允许为负(墙钟回拨)", () => {
    const out = expandAssistantStream([
      { type: "text-chunks", time0: 100, index: 0, dt: [-5], texts: ["x", "y"] }
    ]);
    expect(out[1].time).toBe(95);
  });

  it("畸形记录跳过而非猜测", () => {
    expect(expandAssistantStream(null)).toEqual([]);
    expect(expandAssistantStream([4])).toEqual([]);
    // dt 长度与成员数不符
    expect(expandAssistantStream([
      { type: "text-chunks", time0: 100, index: 0, dt: [10], texts: ["a", "b", "c"] }
    ])).toEqual([]);
    // texts 非数组
    expect(expandAssistantStream([
      { type: "text-chunks", time0: 100, index: 0, dt: [], texts: "nope" }
    ])).toEqual([]);
    // 缺 time0
    expect(expandAssistantStream([
      { type: "text-chunks", index: 0, dt: [], texts: ["a"] }
    ])).toEqual([]);
    // 未知打包类型
    expect(expandAssistantStream([
      { type: "image-chunks", time0: 100, index: 0, dt: [], texts: ["a"] }
    ])).toEqual([]);
  });
});
