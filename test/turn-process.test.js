import { describe, it, expect } from "vitest";
import {
  assistantNode, toolCallNode, toolResult, userNode, AssistantStatus
} from "../src/features/sessions/chat-nodes.js";
import {
  buildTurnProcessSpecs, isProcessMember, isSubagentDelegationTool, PROCESS_INDEPENDENT_KINDS
} from "../src/features/sessions/turn-process.js";

function assistant({ turn, step, seq, blocks, status = AssistantStatus.settled, messageId = null }) {
  const node = assistantNode({ turn, step, startSeq: seq, time: 1 });
  node.firstVisibleSeq = seq;
  node.status = status;
  node.messageId = messageId;
  node.blocks = blocks;
  return node;
}

function tool({ callId, name = "read", turn = 1, step = 0, seq, parentCallId = null, settled = true }) {
  const node = toolCallNode({
    callId, name, argsRaw: "{}", turn, step, startSeq: seq, time: 1, parentCallId
  });
  if (settled) node.result = toolResult({ seq: seq + 1, time: 1, content: [] });
  return node;
}

describe("turn-process 折叠规格", () => {
  it("出现最终回答后生成 spec,含计数与答案边界", () => {
    const nodes = [
      assistant({ turn: 1, step: 0, seq: 10, blocks: [{ type: "reasoning", text: "hmm" }], messageId: "m0" }),
      tool({ callId: "c1", turn: 1, step: 0, seq: 11 }),
      assistant({ turn: 1, step: 1, seq: 13, blocks: [{ type: "text", text: "final" }], messageId: "m1" })
    ];
    const specs = buildTurnProcessSpecs(nodes, new Map([[1, 9]]));
    const spec = specs.get(1);
    expect(spec).toBeTruthy();
    expect(spec.controlAnchorSeq).toBe(10);
    expect(spec.processStartSeq).toBe(9);
    expect(spec.answerAnchorSeq).toBe(13);
    expect(spec.answerStep).toBe(1);
    expect(spec.toolCallCount).toBe(1);
    expect(spec.messageCount).toBe(0);
    expect(spec.subagentCount).toBe(0);
    expect(spec.memberCount).toBe(2);
  });

  it("子代理按工具名分离计数", () => {
    const nodes = [
      tool({ callId: "c1", name: "subagent", seq: 10 }),
      tool({ callId: "c2", name: "send_message", seq: 11 }),
      assistant({ turn: 1, step: 1, seq: 13, blocks: [{ type: "text", text: "done" }], messageId: "m1" })
    ];
    const spec = buildTurnProcessSpecs(nodes, new Map())[0];
    expect(spec).toBeUndefined();
    const spec1 = buildTurnProcessSpecs(nodes, new Map([[1, 9]])).get(1);
    expect(spec1.subagentCount).toBe(1);
    expect(spec1.toolCallCount).toBe(1);
    expect(isSubagentDelegationTool("subagent")).toBe(true);
    expect(isSubagentDelegationTool("subagent_fork")).toBe(true);
    expect(isSubagentDelegationTool("send_message")).toBe(false);
  });

  it("没有最终回答时不生成折叠头", () => {
    const nodes = [
      tool({ callId: "c1", seq: 10 }),
      assistant({ turn: 1, step: 0, seq: 11, blocks: [{ type: "text", text: "partial" }], status: AssistantStatus.running })
    ];
    expect(buildTurnProcessSpecs(nodes, new Map([[1, 9]])).size).toBe(0);
  });

  it("回答步含工具调用则不算最终回答", () => {
    const nodes = [
      assistant({
        turn: 1, step: 0, seq: 10, messageId: "m0",
        blocks: [{ type: "text", text: "x" }, { type: "tool-call", callId: "c1", name: "read", argsRaw: "{}" }]
      })
    ];
    expect(buildTurnProcessSpecs(nodes, new Map([[1, 9]])).size).toBe(0);
  });

  it("isProcessMember 排除独立种类且限制在答案边界之前", () => {
    const nodes = [
      assistant({ turn: 1, step: 0, seq: 10, blocks: [{ type: "reasoning", text: "hmm" }], messageId: "m0" }),
      assistant({ turn: 1, step: 1, seq: 13, blocks: [{ type: "text", text: "final" }], messageId: "m1" })
    ];
    const spec = buildTurnProcessSpecs(nodes, new Map([[1, 9]])).get(1);
    expect(isProcessMember(nodes[0], spec)).toBe(true);
    expect(isProcessMember(nodes[1], spec)).toBe(false);       // 答案本身不折叠
    expect(isProcessMember(userNode({ seq: 10, time: 1, messageId: "u", content: [] }), spec)).toBe(false);
    expect(PROCESS_INDEPENDENT_KINDS.has("user")).toBe(true);
  });
});
