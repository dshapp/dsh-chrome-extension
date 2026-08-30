import { describe, it, expect } from "vitest";
import { createSessionStore } from "../src/features/sessions/session-store.js";
import { NodeKind, AssistantStatus } from "../src/features/sessions/chat-nodes.js";

let seq = 0;
function ev(type, data, extra = {}) {
  return { type, seq: seq++, time: 1000 + seq, data, ...extra };
}
function fresh() {
  seq = 0;
  const store = createSessionStore();
  store.reset("s1");
  return store;
}
const kinds = (s) => s.getSnapshot().nodes.map((n) => n.kind);
const byKind = (s, kind) => s.getSnapshot().nodes.filter((n) => n.kind === kind);

describe("user / steering / context", () => {
  it("user 消息成行", () => {
    const s = fresh();
    s.applyEvent(ev("user/message", { message: { id: "m1", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } }));
    const [node] = byKind(s, NodeKind.user);
    expect(node.messageId).toBe("m1");
    expect(node.content[0].text).toBe("hi");
  });

  it("被 next-step 消费的消息转为 steering 行", () => {
    const s = fresh();
    // 先把 m1 放进 next-step 队列,再把它消费掉。
    s.applyEvent(ev("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [{ id: "m1" }] }));
    s.applyEvent(ev("agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1, inserted: [], outcome: "consumed" }));
    s.applyEvent(ev("user/message", { message: { id: "m1", content: [], source: { kind: "user" } } }));
    expect(kinds(s)).toContain(NodeKind.steering);
    expect(kinds(s)).not.toContain(NodeKind.user);
  });

  it("取消的 next-step 不认领为 steering", () => {
    const s = fresh();
    s.applyEvent(ev("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [{ id: "m1" }] }));
    s.applyEvent(ev("agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1, inserted: [], outcome: "canceled" }));
    s.applyEvent(ev("user/message", { message: { id: "m1", content: [], source: { kind: "user" } } }));
    expect(kinds(s)).toContain(NodeKind.user);
  });

  it("plugin 来源成 context 行,compact 插件不成行", () => {
    const s = fresh();
    s.applyEvent(ev("user/message", { message: { id: "m1", content: [], source: { kind: "plugin", plugin: "memory" } } }));
    s.applyEvent(ev("user/message", { message: { id: "m2", content: [], source: { kind: "plugin", plugin: "compact" } } }));
    const ctx = byKind(s, NodeKind.context);
    expect(ctx).toHaveLength(1);
    expect(ctx[0].provenanceLabel).toBe("memory");
  });

  it("surfaceOp replace 不产生新行", () => {
    const s = fresh();
    s.applyEvent(ev("user/message", { message: { id: "m1", content: [], source: { kind: "user" } } }, { surfaceOp: { op: "replace" } }));
    expect(s.getSnapshot().nodes).toHaveLength(0);
  });
});

describe("assistant 流式", () => {
  it("block-start + text-delta 累积成文本块", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("step/start", { step: 0 }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "He" } }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "llo" } }));
    const [a] = byKind(s, NodeKind.assistant);
    expect(a.blocks[0]).toEqual({ type: "text", text: "Hello" });
    expect(a.status).toBe(AssistantStatus.running);
  });

  it("越界与负索引的 delta 被忽略,不抛错", () => {
    const s = fresh();
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: -1, text: "x" } }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 99, text: "y" } }));
    // 越界写入被丢弃 → 块仍为空 → 该 step 无可见内容,不成行。
    expect(byKind(s, NodeKind.assistant)).toHaveLength(0);
    // 合法索引仍可写入,证明前两次是被"忽略"而不是把状态搞坏了。
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "ok" } }));
    expect(byKind(s, NodeKind.assistant)[0].blocks[0].text).toBe("ok");
  });

  it("被打断的空 step 仍成行(停止观感是该行存在的意义)", () => {
    const s = fresh();
    s.applyEvent(ev("assistant/message", { turn: 1, step: 0, interrupted: true, message: { id: "m", content: [] } }));
    expect(byKind(s, NodeKind.assistant)).toHaveLength(1);
  });

  it("block-start 的索引上限挡住畸形 chunk", () => {
    const s = fresh();
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "block-start", index: 999999, blockType: "text" } }));
    expect(s.getSnapshot().nodes).toHaveLength(0);
  });

  it("assistant/message 覆盖流式内容并结算", () => {
    const s = fresh();
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "partial" } }));
    s.applyEvent(ev("assistant/message", { turn: 1, step: 0, message: { id: "am1", content: [{ type: "text", text: "final" }] } }));
    const [a] = byKind(s, NodeKind.assistant);
    expect(a.blocks[0].text).toBe("final");
    expect(a.status).toBe(AssistantStatus.settled);
    expect(a.messageId).toBe("am1");
  });

  it("interrupted 的 message 结算为 interrupted", () => {
    const s = fresh();
    s.applyEvent(ev("assistant/message", { turn: 1, step: 0, interrupted: true, message: { id: "am1", content: [{ type: "text", text: "cut" }] } }));
    const [a] = byKind(s, NodeKind.assistant);
    expect(a.status).toBe(AssistantStatus.interrupted);
  });

  it("无可见内容的 step 不占行", () => {
    const s = fresh();
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    expect(byKind(s, NodeKind.assistant)).toHaveLength(0);
  });
});

describe("工具调用", () => {
  it("call + result 按 callId 配对", () => {
    const s = fresh();
    s.applyEvent(ev("tool/call", { callId: "c1", name: "bash", arguments: '{"command":"ls"}', turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { callId: "c1", content: [{ type: "text", text: "out" }] }));
    const [t] = byKind(s, NodeKind.toolCall);
    expect(t.name).toBe("bash");
    expect(t.result.content[0].text).toBe("out");
    expect(t.result.isError).toBe(false);
  });

  it("result 从 message.content 的 tool-result 块中解出", () => {
    const s = fresh();
    s.applyEvent(ev("tool/call", { callId: "c1", name: "read", arguments: "{}", turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { message: { content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "data" }], isError: true }] } }));
    const [t] = byKind(s, NodeKind.toolCall);
    expect(t.result.isError).toBe(true);
    expect(t.result.content[0].text).toBe("data");
  });

  it("callId 缺失的 result 回退到最近未结算的调用", () => {
    const s = fresh();
    s.applyEvent(ev("tool/call", { callId: "c1", name: "a", arguments: "{}", turn: 1, step: 0 }));
    s.applyEvent(ev("tool/call", { callId: "c2", name: "b", arguments: "{}", turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { content: [{ type: "text", text: "r" }] }));
    const tools = byKind(s, NodeKind.toolCall);
    expect(tools.find((t) => t.callId === "c2").result).not.toBeNull();
    expect(tools.find((t) => t.callId === "c1").result).toBeNull();
  });

  it("孤儿 result 仍保留一行", () => {
    const s = fresh();
    s.applyEvent(ev("tool/result", { callId: "ghost", content: [{ type: "text", text: "r" }] }));
    const [t] = byKind(s, NodeKind.toolCall);
    expect(t.name).toBe("orphan-result");
  });

  it("code-dispatch 子调用嵌套进根调用", () => {
    const s = fresh();
    s.applyEvent(ev("tool/call", { callId: "root", name: "run_code", arguments: "{}", turn: 1, step: 0 }));
    s.applyEvent(ev("tool/code-dispatch-start", { subCallId: "sub1", rootCallId: "root", parentCallId: "root", name: "read", arguments: { file_path: "/a" } }));
    s.applyEvent(ev("tool/code-dispatch", { subCallId: "sub1", rootCallId: "root", parentCallId: "root", name: "read", content: [{ type: "text", text: "ok" }] }));
    const roots = byKind(s, NodeKind.toolCall);
    expect(roots).toHaveLength(1);
    expect(roots[0].subCalls).toHaveLength(1);
    expect(roots[0].subCalls[0].result.content[0].text).toBe("ok");
  });

  it("未结算的调用在其 turn 关闭后冻结为 interrupted", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("tool/call", { callId: "c1", name: "bash", arguments: "{}", turn: 1, step: 0 }));
    s.applyEvent(ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
    const [t] = byKind(s, NodeKind.toolCall);
    expect(t.result.isError).toBe(true);
    expect(t.result.error.code).toBe("interrupted");
  });
});

describe("turn 生命周期", () => {
  it("turn/end error 生成 turnError 行", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("turn/end", { turn: 1, reason: { kind: "error", error: { message: "boom", code: "E" } } }));
    const [e] = byKind(s, NodeKind.turnError);
    expect(e.message).toBe("boom");
    expect(e.code).toBe("E");
  });

  it("completed 不产生 turnError", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
    expect(byKind(s, NodeKind.turnError)).toHaveLength(0);
  });

  it("max-tokens 生成专门的行", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("turn/end", { turn: 1, reason: { kind: "max-tokens" } }));
    expect(byKind(s, NodeKind.turnMaxTokens)).toHaveLength(1);
  });

  it("turn/end 把仍在 running 的 step 标记为 interrupted", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "x" } }));
    s.applyEvent(ev("turn/end", { turn: 1, reason: { kind: "completed" } }));
    const [a] = byKind(s, NodeKind.assistant);
    expect(a.status).toBe(AssistantStatus.interrupted);
  });

  it("turnTail 折叠 usage 与 TTFT/吞吐", () => {
    const s = fresh();
    s.applyEvent({ type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } });
    s.applyEvent({ type: "step/start", seq: 1, time: 1000, data: { step: 0 } });
    s.applyEvent({ type: "assistant/chunk", seq: 2, time: 1200, data: { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } } });
    s.applyEvent({ type: "assistant/chunk", seq: 3, time: 1200, data: { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "hi" } } });
    s.applyEvent({ type: "assistant/message", seq: 4, time: 2200, data: { turn: 1, step: 0, usage: { outputTokens: 100 }, message: { id: "m", content: [{ type: "text", text: "hi" }] } } });
    s.applyEvent({ type: "turn/end", seq: 5, time: 2500, data: { turn: 1, reason: { kind: "completed" } } });
    const [tail] = byKind(s, NodeKind.turnTail);
    expect(tail.ttftMs).toBe(200);          // 1200 - 1000
    expect(tail.usage.outputTokens).toBe(100);
    expect(tail.decodeTokensPerSec).toBeCloseTo(100);  // 100 tok / 1.0s
    expect(tail.runMs).toBe(1500);
  });

  it("turnTail 排在同 seq 其他行之后", () => {
    const s = fresh();
    s.applyEvent({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } });
    s.applyEvent({ type: "turn/end", seq: 1, time: 2, data: { turn: 1, reason: { kind: "max-tokens" } } });
    const k = kinds(s);
    expect(k.indexOf(NodeKind.turnMaxTokens)).toBeLessThan(k.indexOf(NodeKind.turnTail));
  });
});

describe("重试 / compaction / 命令 / workflow", () => {
  it("llm/retry 抹掉失败的 step 内容并保留首 token 证据", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    s.applyEvent(ev("assistant/chunk", { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "bad" } }));
    expect(byKind(s, NodeKind.assistant)).toHaveLength(1);
    s.applyEvent(ev("llm/retry", { retryId: "r1", turn: 1, step: 0, retry: 2, maxRetries: 3, failure: { message: "429", code: "rate" } }));
    // 失败的那次尝试从记录中消失
    expect(byKind(s, NodeKind.assistant)).toHaveLength(0);
    const [r] = byKind(s, NodeKind.modelRetry);
    expect(r.retry).toBe(2);
    expect(r.failureCode).toBe("rate");
  });

  it("重试隐藏该轮的 turn-error", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("llm/retry", { retryId: "r1", turn: 1, step: 0 }));
    s.applyEvent(ev("turn/end", { turn: 1, reason: { kind: "error", error: { message: "x" } } }));
    expect(byKind(s, NodeKind.turnError)).toHaveLength(0);
  });

  it("compaction/summary 取首个文本块", () => {
    const s = fresh();
    s.applyEvent(ev("compaction/start", { compactionId: "k1" }));
    s.applyEvent(ev("compaction/summary", { compactionId: "k1", summary: [{ type: "text", text: "摘要" }], shadowedTokenCount: 500 }));
    const [c] = byKind(s, NodeKind.compaction);
    expect(c.summary).toBe("摘要");
    expect(c.shadowedTokenCount).toBe(500);
  });

  it("command/run + done 折成一行", () => {
    const s = fresh();
    s.applyEvent(ev("command/run", { commandId: "x1", name: "compact", args: "" }));
    s.applyEvent(ev("command/done", { commandId: "x1", kind: "success", text: "done" }));
    const [c] = byKind(s, NodeKind.command);
    expect(c.name).toBe("compact");
    expect(c.outcome.kind).toBe("success");
  });

  it("workflow 按 phase 分组并折算状态", () => {
    const s = fresh();
    s.applyEvent(ev("tool-workflow/run-start", { runId: "w1", name: "audit" }));
    s.applyEvent(ev("tool-workflow/agent-start", { runId: "w1", seq: 1, label: "a", childId: "c1", phase: "scan" }));
    s.applyEvent(ev("tool-workflow/agent-start", { runId: "w1", seq: 2, label: "b", childId: "c2", phase: "scan" }));
    s.applyEvent(ev("tool-workflow/agent-end", { runId: "w1", seq: 1, outcome: "completed" }));
    s.applyEvent(ev("tool-workflow/run-end", { runId: "w1", stopReason: "completed" }));
    const [w] = byKind(s, NodeKind.workflowRun);
    expect(w.phases).toHaveLength(1);
    expect(w.phases[0].members).toHaveLength(2);
    expect(w.status).toBe("completed");
  });

  it("run-start 缺失的 workflow 更新被丢弃", () => {
    const s = fresh();
    s.applyEvent(ev("tool-workflow/agent-start", { runId: "w9", seq: 1, label: "a", childId: "c" }));
    expect(byKind(s, NodeKind.workflowRun)).toHaveLength(0);
  });
});

describe("兜底与去重", () => {
  it("未知的 append 面事件成 unknownSurface 行而非丢弃", () => {
    const s = fresh();
    s.applyEvent(ev("some/future-event", { hello: 1 }, { surfaceOp: "append" }));
    const [u] = byKind(s, NodeKind.unknownSurface);
    expect(u.type).toBe("some/future-event");
    // { op: "append" } 对象形式同样成行。
    s.applyEvent(ev("other/future", {}, { surfaceOp: { op: "append" } }));
    expect(byKind(s, NodeKind.unknownSurface)).toHaveLength(2);
  });

  it("没有 append 面的记账事件不成行", () => {
    const s = fresh();
    // 这些是后端真实存在的事件,它们从不进入模型可见面,长成行就是纯噪音。
    for (const type of ["sandbox/mode", "approval/policy", "permission/preset", "request/context"]) {
      s.applyEvent(ev(type, { x: 1 }));
    }
    expect(s.getSnapshot().nodes).toHaveLength(0);
  });

  it("replace 面的未知事件不成行", () => {
    const s = fresh();
    s.applyEvent(ev("some/future-event", {}, { surfaceOp: { op: "replace" } }));
    expect(byKind(s, NodeKind.unknownSurface)).toHaveLength(0);
  });

  it("step 边界与 request/header 不成行", () => {
    const s = fresh();
    s.applyEvent(ev("step/start", { step: 0 }));
    s.applyEvent(ev("step/end", { step: 0 }));
    s.applyEvent(ev("request/header", {}));
    expect(s.getSnapshot().nodes).toHaveLength(0);
  });

  it("乱序到达的事件不被丢弃,而是插回位置重折", () => {
    // turn/end 先于 turn/start 到达。丢弃 turn/start 会永久丢掉 turnTail 的锚点。
    const s = fresh();
    s.applyEvent({ type: "turn/end", seq: 1, time: 2, data: { turn: 1, reason: { kind: "completed" } } });
    s.applyEvent({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } });
    expect(kinds(s)).toContain(NodeKind.turnTail);
  });

  it("result 先于 call 到达仍能正确配对(不留孤儿)", () => {
    const s = fresh();
    s.applyEvent({ type: "tool/result", seq: 2, time: 2, data: { callId: "c1", content: [{ type: "text", text: "ok" }] } });
    s.applyEvent({ type: "tool/call", seq: 1, time: 1, data: { callId: "c1", name: "bash", arguments: "{}", turn: 1, step: 0 } });
    const tools = byKind(s, NodeKind.toolCall);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("bash");
    expect(tools[0].result).not.toBeNull();
  });

  it("完全逆序投递与顺序投递收敛到同一结果", () => {
    const events = [
      { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      { type: "user/message", seq: 1, time: 1, data: { message: { id: "m", content: [], source: { kind: "user" } } } },
      { type: "tool/call", seq: 2, time: 2, data: { callId: "c", name: "read", arguments: "{}", turn: 1, step: 0 } },
      { type: "tool/result", seq: 3, time: 3, data: { callId: "c", content: [{ type: "text", text: "r" }] } },
      { type: "turn/end", seq: 4, time: 4, data: { turn: 1, reason: { kind: "completed" } } }
    ];
    const forward = fresh();
    for (const e of events) forward.applyEvent(e);
    const reverse = fresh();
    for (const e of [...events].reverse()) reverse.applyEvent(e);
    expect(kinds(reverse)).toEqual(kinds(forward));
  });

  it("重复 seq 的事件只归并一次", () => {
    const s = fresh();
    const e = { type: "user/message", seq: 5, time: 1, data: { message: { id: "m1", content: [], source: { kind: "user" } } } };
    s.applyEvent(e);
    s.applyEvent(e);
    expect(byKind(s, NodeKind.user)).toHaveLength(1);
  });

  it("节点按 anchorSeq 全序排列", () => {
    const s = fresh();
    s.applyEvent(ev("user/message", { message: { id: "m1", content: [], source: { kind: "user" } } }));
    s.applyEvent(ev("tool/call", { callId: "c1", name: "bash", arguments: "{}", turn: 1, step: 0 }));
    s.applyEvent(ev("user/message", { message: { id: "m2", content: [], source: { kind: "user" } } }));
    const anchors = s.getSnapshot().nodes.map((n) => n.seq ?? n.startSeq);
    expect(anchors).toEqual([...anchors].sort((a, b) => a - b));
  });
});

describe("projections", () => {
  it("plan 投影折算目标态(pending 取反)", () => {
    const s = fresh();
    s.applyProjection("plan", { active: false, pending: true }, 1);
    expect(s.getSnapshot().planMode).toBe(true);
    s.applyProjection("plan", { active: true, pending: false }, 2);
    expect(s.getSnapshot().planMode).toBe(true);
    s.applyProjection("plan", { active: false, pending: false }, 3);
    expect(s.getSnapshot().planMode).toBe(false);
  });

  it("旧 seq 的投影不覆盖新值", () => {
    const s = fresh();
    s.applyProjection("title", "新", 10);
    s.applyProjection("title", "旧", 2);
    expect(s.getSnapshot().title).toBe("新");
  });

  it("todos 与 permissions 解码", () => {
    const s = fresh();
    s.applyProjection("todos", [{ id: "1", content: "做事", status: "in_progress" }], 1);
    s.applyProjection("permissions", { currentValue: "default", options: [{ value: "default", name: "默认" }] }, 2);
    expect(s.getSnapshot().todos[0].content).toBe("做事");
    expect(s.getSnapshot().permissions.currentValue).toBe("default");
  });
});

describe("toolCall 查找", () => {
  it("按 callId 取回调用(审批卡解析 bash command 用)", () => {
    const s = fresh();
    s.applyEvent(ev("tool/call", { callId: "c1", name: "bash", arguments: '{"command":"rm -rf /"}', turn: 1, step: 0 }));
    expect(JSON.parse(s.toolCall("c1").argsRaw).command).toBe("rm -rf /");
    expect(s.toolCall("nope")).toBeNull();
  });
});
