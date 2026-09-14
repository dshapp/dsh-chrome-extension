import { describe, it, expect, beforeAll } from "vitest";
import { assembleTrajectory, TrajectoryKind, PARTIAL_PREVIEW_LIMIT } from "../src/features/trajectory/trajectory-model.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));

/// 事件窗口:[{ event, view }],seq 从 startSeq 起自增。
function window(events, startSeq = 1) {
  return events.map(([type, data, extra], index) => ({
    event: { type, seq: extra?.seq ?? startSeq + index, time: extra?.time ?? 1000 + index, data, ...(extra?.surfaceOp ? { surfaceOp: extra.surfaceOp } : {}) },
    view: {}
  }));
}

function find(records, kind) {
  return records.filter((record) => record.kind === kind);
}

describe("轨迹装配:系统提示词", () => {
  it("初始 header 从 system/message 取提示词,锚在 header 位置", () => {
    const { records } = assembleTrajectory(window([
      ["system/message", { turn: 1, step: 0, message: { role: "system", content: [{ type: "text", text: "SYS" }] } }],
      ["request/header", { reason: "initial", header: { config: { provider: "p", model: "m" }, tools: [{ name: "bash", description: "d" }] } }]
    ]));
    const systems = find(records, TrajectoryKind.system);
    expect(systems).toHaveLength(1);
    expect(systems[0].text).toBe("初始系统提示词");
    expect(systems[0].sourceSeq).toBe(2);
    expect(systems[0].prompt.system).toBe("SYS");
    expect(systems[0].prompt.tools[0].name).toBe("bash");
    expect(systems[0].previousPrompt).toBeNull();
  });

  it("首个 header reason=series 且无前值时不算变更", () => {
    const { records } = assembleTrajectory(window([
      ["system/message", { turn: 1, step: 0, message: { role: "system", content: [{ type: "text", text: "SYS" }] } }],
      ["request/header", { reason: "series", header: { tools: [] } }]
    ]));
    expect(find(records, TrajectoryKind.system)).toHaveLength(0);
  });

  it("工具目录变化记一条系统提示词与工具已更新", () => {
    const { records } = assembleTrajectory(window([
      ["system/message", { message: { content: [{ type: "text", text: "SYS" }] } }],
      ["request/header", { reason: "initial", header: { tools: [{ name: "a" }] } }],
      ["request/header", { reason: "series", header: { tools: [{ name: "a" }, { name: "b" }] } }]
    ]));
    const systems = find(records, TrajectoryKind.system);
    expect(systems).toHaveLength(2);
    expect(systems[1].text).toBe("工具已更新");
    expect(systems[1].prompt.tools.map((tool) => tool.name)).toEqual(["a", "b"]);
  });

  it("历史中的 system/message 更新锚在自己的位置", () => {
    const { records } = assembleTrajectory(window([
      ["system/message", { message: { content: [{ type: "text", text: "SYS" }] } }],
      ["request/header", { reason: "initial", header: { tools: [] } }],
      ["system/message", { message: { content: [{ type: "text", text: "SYS2" }] }, surfaceOp: "append" }]
    ]));
    const systems = find(records, TrajectoryKind.system);
    expect(systems).toHaveLength(2);
    expect(systems[1].sourceSeq).toBe(3);
    expect(systems[1].prompt.system).toBe("SYS2");
    expect(systems[1].previousPrompt.system).toBe("SYS");
  });
});

describe("轨迹装配:消息", () => {
  it("user 与 context 分流,compact 插件跳过", () => {
    const { records } = assembleTrajectory(window([
      ["user/message", { id: "m1", content: [{ type: "text", text: "你好" }], source: { kind: "user" } }],
      ["user/message", { id: "m2", content: [{ type: "text", text: "记忆" }], source: { kind: "plugin", plugin: "memory" } }],
      ["user/message", { id: "m3", content: [{ type: "text", text: "压缩" }], source: { kind: "plugin", plugin: "compact" } }]
    ]));
    // Web 口径:文本进 previewMarkdown,text 只承载附件摘要。
    expect(find(records, TrajectoryKind.user).map((record) => record.previewMarkdown)).toEqual(["你好"]);
    expect(find(records, TrajectoryKind.user)[0].text).toBe("");
    expect(find(records, TrajectoryKind.context)).toHaveLength(1);
    expect(records).toHaveLength(2);
  });

  it("被消费的 next-step 消息渲染成插话", () => {
    const { records } = assembleTrajectory(window([
      ["agent/inbox/spliced", { target: "next-step", start: 0, inserted: [{ id: "m1" }] }],
      ["agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1, inserted: [], outcome: "consumed" }],
      ["user/message", { id: "m1", content: [{ type: "text", text: "插一句" }], source: { kind: "user" } }]
    ]));
    // 不再加「插话 ·」前缀,改为 steering 标记 + 原始内容。
    expect(find(records, TrajectoryKind.user)[0].previewMarkdown).toBe("插一句");
    expect(find(records, TrajectoryKind.user)[0].steering).toBe(true);
  });

  it("surfaceOp replace 的用户消息不成行", () => {
    const { records } = assembleTrajectory(window([
      ["user/message", { id: "m1", content: [{ type: "text", text: "old" }], source: { kind: "user" } }],
      ["user/message", { id: "m2", content: [{ type: "text", text: "new" }], source: { kind: "user" } }, { surfaceOp: "replace" }]
    ]));
    expect(records).toHaveLength(1);
  });
});

describe("轨迹装配:请求生命周期", () => {
  it("step/start → assistant/message 结算请求与用量", () => {
    const { records, requests } = assembleTrajectory(window([
      ["step/start", { turn: 1, step: 1 }, { time: 1000 }],
      ["assistant/attempt", { turn: 1, step: 1, stream: [{ type: "chunk", time: 1100, chunk: { type: "text-delta", text: "Hi" } }] }],
      ["assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Hello" }], source: { provider: "p", model: "m" } }, usage: { inputTokens: 10, outputTokens: 5 } }, { time: 2000 }]
    ]));
    const assistant = find(records, TrajectoryKind.assistant);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].id).toBe("assistant\u00001\u00001");
    expect(assistant[0].outputDetail).toBe("Hello");
    expect(assistant[0].timing.firstTokenAt).toBe(1100);
    expect(assistant[0].usage.outputTokens).toBe(5);
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("complete");
    expect(requests[0].provider).toBe("p");
    expect(requests[0].cumulativeUsage.inputTokens).toBe(10);
  });

  it("assistant/message 内嵌 tool-call 生成工具行,tool/result 补结果", () => {
    const { records } = assembleTrajectory(window([
      ["assistant/message", { turn: 1, step: 1, message: { content: [
        { type: "text", text: "调用中" },
        { type: "tool-call", id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }
      ] } }],
      ["tool/result", { message: { content: [{ type: "tool-result", toolCallId: "c1", isError: false, content: [{ type: "text", text: "ok" }] }] } }, { time: 3000 }]
    ]));
    const tools = find(records, TrajectoryKind.tool);
    expect(tools).toHaveLength(1);
    expect(tools[0].text).toBe("bash");
    expect(tools[0].inputDetail).toBe('{"cmd":"ls"}');
    expect(tools[0].outputDetail).toBe("ok");
    expect(tools[0].isError).toBe(false);
    expect(tools[0].durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("step/end 没有助手消息时产出请求边界错误行", () => {
    const { records, requests } = assembleTrajectory(window([
      ["step/start", { turn: 1, step: 1 }, { time: 1000 }],
      ["step/end", { turn: 1, step: 1 }, { time: 1500 }]
    ]));
    const assistant = find(records, TrajectoryKind.assistant);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].requestOnly).toBe(true);
    expect(assistant[0].isError).toBe(true);
    expect(requests[0].status).toBe("error");
  });

  it("llm/retry 记录重试次数与失败原因", () => {
    const { requests } = assembleTrajectory(window([
      ["step/start", { turn: 1, step: 1 }],
      ["llm/retry", { turn: 1, step: 1, retry: 1, maxRetries: 3, delayMs: 500, failure: { code: "overloaded", message: "busy" } }]
    ]));
    expect(requests[0].retry).toBe(1);
    expect(requests[0].maxRetries).toBe(3);
    expect(requests[0].error).toBe("busy");
  });

  it("turn/end error 把该轮最后一个请求标失败", () => {
    const { requests } = assembleTrajectory(window([
      ["step/start", { turn: 2, step: 1 }],
      ["turn/end", { turn: 2, reason: { kind: "error", error: { message: "boom" } } }]
    ]));
    expect(requests[0].status).toBe("error");
    expect(requests[0].error).toBe("boom");
  });

  it("只有流式增量、未结算的 step 产出进行中的助手行", () => {
    const { records } = assembleTrajectory(window([
      ["step/start", { turn: 3, step: 1 }],
      ["assistant/attempt", { turn: 3, step: 1, stream: [
        { type: "text-chunks", time0: 1000, index: 0, dt: [50, 50], texts: ["a", "b", "c"] }
      ] }]
    ]));
    const assistant = find(records, TrajectoryKind.assistant);
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe("abc");
    expect(assistant[0].text.length).toBeLessThanOrEqual(PARTIAL_PREVIEW_LIMIT);
  });
});

describe("轨迹装配:压缩与子工具", () => {
  it("compaction 生命周期成行并结算请求", () => {
    const { records, requests } = assembleTrajectory(window([
      ["compaction/start", { compactionId: "k1", turn: 4 }, { time: 1000 }],
      ["compaction/summary", { compactionId: "k1", summary: [{ type: "text", text: "摘要" }], usage: { inputTokens: 7 } }],
      ["compaction/end", { compactionId: "k1" }, { time: 2000 }]
    ]));
    const compacted = find(records, TrajectoryKind.compacted);
    expect(compacted).toHaveLength(1);
    expect(compacted[0].id).toBe("compacted\u0000k1");
    expect(compacted[0].outputDetail).toBe("摘要");
    expect(compacted[0].durationSeconds).toBe(1);
    const request = requests.find((entry) => entry.purpose === "compaction");
    expect(request.status).toBe("complete");
    expect(request.usage.inputTokens).toBe(7);
  });

  it("ptc dispatch 生成子工具行", () => {
    const { records } = assembleTrajectory(window([
      ["tool/ptc-dispatch-start", { subCallId: "s1", rootCallId: "r1", parentCallId: "p1", name: "nested", arguments: {} }],
      ["tool/ptc-dispatch", { subCallId: "s1", rootCallId: "r1", parentCallId: "p1", content: [{ type: "text", text: "done" }], isError: false }]
    ]));
    const subtools = find(records, TrajectoryKind.subtool);
    expect(subtools).toHaveLength(1);
    expect(subtools[0].id).toBe("subtool\u0000call\u0000s1");
    expect(subtools[0].parentCallId).toBe("p1");
    expect(subtools[0].outputDetail).toBe("done");
  });
});
