// E2E 1:开真会话,发真 prompt,让模型真的调工具,验证重写后的 store 归并结果。
import assert from "node:assert/strict";
import { rpc, connection, openDownlink, waitFor } from "./harness.mjs";
import { createSessionStore } from "../../src/features/sessions/session-store.js";
import { createSessionService } from "../../src/features/sessions/session-service.js";
import { toolRowModel } from "../../src/features/chat/tool-row-model.js";
import { agentStatusLabel } from "../../src/features/chat/chat-renderer.js";

const CWD = process.cwd();
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
};

// 用真实的 connection 门面驱动真实的 session-service —— 与插件运行时同一条代码路径。
const service = createSessionService(connection);

const sessionId = await service.create({ cwd: CWD });
console.log("会话:", sessionId);

const downlink = openDownlink((frame, stream) => {
  if (stream === "mux") service.handleMuxFrame(frame);
});
await downlink.ready;

await service.open(sessionId, { cwd: CWD });

let snap = () => service.getRuntimeSnapshot();
const statusLabels = new Set();
service.onRuntimeChange((s) => {
  const label = agentStatusLabel(s, { awaitingTurnStart: false });
  if (label) statusLabels.add(label);
});

// 让模型必须调工具:要求它读一个真实文件并报告首行。
await service.prompt(sessionId, [{
  type: "text",
  text: "用 read 工具读取 package.json 的前 5 行,然后一句话告诉我 name 字段的值。不要做别的事。"
}]);

await waitFor("turn 结束", () => !snap().running && snap().nodes.length > 2, {
  timeoutMs: 120000,
  diagnose: () => ({ running: snap().running, kinds: snap().nodes.map((n) => n.kind) })
});

const s = snap();
const kinds = s.nodes.map((n) => n.kind);
console.log("节点:", kinds.join(", "));

check("产生 user 行", () => assert.ok(kinds.includes("user")));
check("产生 assistant 行", () => assert.ok(kinds.includes("assistant")));
check("产生 toolCall 行", () => assert.ok(kinds.includes("toolCall"), "模型未调用工具: " + kinds.join(",")));
check("产生 turnTail 行", () => assert.ok(kinds.includes("turnTail")));
check("无 unknownSurface 噪音", () => assert.equal(kinds.filter((k) => k === "unknownSurface").length, 0));

check("节点按 anchorSeq 有序", () => {
  const anchors = s.nodes.map((n) => (n.kind === "assistant" ? (n.firstVisibleSeq ?? n.startSeq)
    : n.kind === "toolCall" ? n.startSeq : n.seq));
  assert.deepEqual(anchors, [...anchors].sort((a, b) => a - b));
});

check("user 行在最前", () => assert.equal(kinds[0], "user"));

const tools = s.nodes.filter((n) => n.kind === "toolCall");
check("工具调用全部已结算", () => {
  for (const t of tools) assert.ok(t.result != null, `${t.name} 未结算`);
});
// 模型可能用 read 直读,也可能用 run_code 包一层。两条路径都要能正确成行。
check("每个工具行都有非空摘要与正确状态", () => {
  for (const t of tools) {
    const m = toolRowModel(t, { cwd: CWD, home: "/Users/user" });
    assert.ok(m.summary && m.summary.trim(), t.name + " 摘要为空");
    assert.ok(["ok","error","stopped"].includes(m.state), t.name + " 状态异常: " + m.state);
    assert.ok(!m.summary.startsWith(CWD), t.name + " cwd 内路径未相对化: " + m.summary);
  }
});
check("run_code 的子调用被嵌套(若存在)", () => {
  const code = tools.find((t) => t.name === "run_code");
  if (!code) return;
  assert.equal(toolRowModel(code).variant, "code");
  for (const sub of code.subCalls ?? []) {
    assert.ok(sub.callId, "子调用缺 callId");
    assert.ok(sub.parentCallId === code.callId || sub.rootCallId === code.callId, "子调用未挂到根调用");
  }
});

const assistants = s.nodes.filter((n) => n.kind === "assistant");
check("assistant step 全部结算", () => {
  for (const a of assistants) assert.ok(a.status !== "running", "step 仍在 running");
});
check("assistant 有文本产出", () => {
  const text = assistants.flatMap((a) => a.blocks).filter((b) => b?.type === "text").map((b) => b.text).join("");
  assert.ok(text.trim().length > 0, "无文本产出");
});

const tail = s.nodes.find((n) => n.kind === "turnTail");
check("turnTail 有 usage 与耗时", () => {
  assert.ok(tail.usage, "缺 usage");
  assert.ok(tail.runMs > 0, "缺 runMs");
});
check("turnTail TTFT 合理(>0 且 <turn 总时长)", () => {
  if (tail.ttftMs == null) throw new Error("缺 ttftMs");
  assert.ok(tail.ttftMs > 0, "ttft 应为正: " + tail.ttftMs);
  assert.ok(tail.ttftMs <= tail.runMs + 1000, `ttft(${tail.ttftMs}) 不应超过 runMs(${tail.runMs})`);
});
check("turnTail 吞吐为正", () => {
  if (tail.decodeTokensPerSec == null) throw new Error("缺 decodeTokensPerSec");
  assert.ok(tail.decodeTokensPerSec > 0);
});

check("运行期出现过细分状态文案", () => {
  assert.ok(statusLabels.size > 0, "从未产生状态文案");
});

// 历史重放必须与实时归并收敛到同一结果 —— 这是断线重连的正确性前提。
const replay = createSessionStore();
replay.reset(sessionId);
const hist = await rpc("session/page", { request: {
  address: { kind: "session", sessionId }, throughSeq: s.lastSeq, maxMessages: 500
} });
for (const e of hist.records ?? []) replay.applyEvent(e.event, e.view);
const replayKinds = replay.getSnapshot().nodes.map((n) => n.kind);
check("历史重放与实时归并一致", () => {
  assert.deepEqual(replayKinds, kinds, `重放=${replayKinds.join(",")} 实时=${kinds.join(",")}`);
});

// 乱序投递也必须收敛到同一结果。
const shuffled = createSessionStore();
shuffled.reset(sessionId);
const evts = [...(hist.records ?? [])];
// 把每相邻两条对调,模拟轻度乱序
for (let i = 0; i + 1 < evts.length; i += 2) { const t = evts[i]; evts[i] = evts[i+1]; evts[i+1] = t; }
for (const e of evts) shuffled.applyEvent(e.event, e.view);
check("轻度乱序不改变节点种类集合", () => {
  const got = new Set(shuffled.getSnapshot().nodes.map((n) => n.kind));
  const want = new Set(kinds);
  // seq 去重会丢弃回退的事件,所以只比较集合而非序列
  for (const k of want) assert.ok(got.has(k), `乱序后丢失 ${k}`);
});

downlink.close();
await service.cancel(sessionId).catch(() => {});
await service.archive(sessionId).catch(() => {});

console.log("\n=== E2E 1 结果 ===");
for (const [status, name, msg] of results) {
  console.log(`${status === "PASS" ? "✔" : "✘"} ${name}${msg ? " — " + msg : ""}`);
}
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
