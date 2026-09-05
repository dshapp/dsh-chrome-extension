// E2E 2:真实交互往返。让 agent 真的发起审批与提问,用重写后的卡片逻辑应答,
// 验证宿主接受我们的应答格式(accepted:true)且 turn 能继续推进。
import assert from "node:assert/strict";
import { connection, openDownlink, waitFor, sleep } from "./harness.mjs";
import { createSessionService } from "../../src/features/sessions/session-service.js";
import { createCommandService } from "../../src/features/commands/command-service.js";
import {
  resolveTakeover, classifyQuestions,
  createQuestionFlow, flowChooseSettling, flowAnswers,
  resolveApprovalPresentation
} from "../../src/features/interactions/interaction-flow.js";
import { toolRowModel } from "../../src/features/chat/tool-row-model.js";

const CWD = process.cwd();
const results = [];
const check = (name, fn) => {
  try { fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
};
const t = (k, p) => (k === "approval.escalation" ? ("工具 " + p.tool + " 请求越权执行") : k);
async function runCase({ promptText, permission, handle }) {
  const service = createSessionService(connection);
  const sessionId = await service.create({ cwd: CWD });
  const dl = openDownlink((frame, stream) => {
    if (stream === "mux") service.handleMuxFrame(frame);
  });
  await dl.ready;
  await service.open(sessionId, { cwd: CWD });
  if (permission) {
    // 权限切换必须走 commands/execute(斜杠命令通道),当普通 prompt 发是无效的。
    await createCommandService(connection).execute(sessionId, permission);
    await sleep(2000);
  }
  await service.prompt(sessionId, [{ type: "text", text: promptText }]);
  const out = await handle(service, sessionId);
  dl.close();
  await service.cancel(sessionId).catch(() => {});
  await service.archive(sessionId).catch(() => {});
  return out;
}

console.log("用例 A:审批往返…");
try {
  const a = await runCase({
    permission: "/permission read-only",
    promptText: "用 bash 工具执行:touch /tmp/e2e_approval_ok.txt。若沙箱拒绝,请用 sandbox_permissions 升级重试一次。",
    handle: async (service, sessionId) => {
      const approval = await waitFor("审批请求", () => service.getRuntimeSnapshot().pendingApproval, {
        timeoutMs: 90000, diagnose: () => ({ running: service.getRuntimeSnapshot().running })
      });
      const presentation = resolveApprovalPresentation(approval, service.store, t);
      const takeover = resolveTakeover({ question: service.getRuntimeSnapshot().pendingQuestion, approval });
      const receipt = await service.respondInteraction(approval.rpcId, {
        ok: true, value: { sessionId, approvalId: approval.approvalId, outcome: "allowed-once" }
      });
      await waitFor("审批被清空", () => !service.getRuntimeSnapshot().pendingApproval, { timeoutMs: 30000 });
      await waitFor("turn 结束", () => !service.getRuntimeSnapshot().running, { timeoutMs: 90000 });
      return { approval, presentation, takeover, receipt,
        permissionValue: service.getRuntimeSnapshot().permissions?.currentValue,
        snap: service.getRuntimeSnapshot() };
    }
  });
  check("A1 收到 approval/requested 且带 rpcId", () => {
    assert.ok(a.approval.rpcId, "缺 rpcId — 无法应答");
    assert.ok(a.approval.approvalId, "缺 approvalId");
    assert.ok(a.approval.toolName, "缺 toolName");
  });
  check("A2 takeover 判定为 approval", () => assert.equal(a.takeover.kind, "approval"));
  check("A3 bash 审批解析出命令原文", () => {
    if (a.approval.toolName !== "bash") return;
    assert.ok(a.presentation.command, "未解析出 command — 审批卡会缺最关键信息");
    assert.match(a.presentation.command, /e2e_approval_ok/, "解析出的命令不是被审批的那条: " + a.presentation.command);
  });
  check("A4 reason 非空", () => assert.ok(a.presentation.reason));
  check("A5 宿主接受 allowed-once 应答", () => {
    assert.notEqual(a.receipt?.accepted, false, "应答被拒: " + JSON.stringify(a.receipt));
  });
  check("A6 审批被宿主清空(question/approval resolved 帧到达)", () => {
    assert.ok(!a.snap.pendingApproval, "审批未清空");
  });
  check("A7 权限确实切到了 read-only", () => {
    assert.equal(a.permissionValue, "read-only", "权限未切换,审批场景不成立");
  });
} catch (e) { check("A 审批用例整体", () => { throw e; }); }

console.log("用例 B:提问往返…");
try {
  const b = await runCase({
    promptText: "用 ask_user_question 工具问我:E2E 测试选哪个?给两个选项 Alpha 和 Beta。只问这一次,然后结束。",
    handle: async (service, sessionId) => {
      const question = await waitFor("提问请求", () => service.getRuntimeSnapshot().pendingQuestion, {
        timeoutMs: 90000, diagnose: () => ({ running: service.getRuntimeSnapshot().running })
      });
      const kind = classifyQuestions(question.questions ?? []);
      const takeover = resolveTakeover({ question, approval: null });
      const flow = createQuestionFlow(question.questions);
      const firstLabel = question.questions[0]?.options?.[0]?.label;
      const settled = flowChooseSettling(flow, firstLabel);
      const answers = flowAnswers(settled.state);
      const receipt = await service.respondInteraction(question.rpcId,
        { ok: true, value: { sessionId, answer: { answers } } });
      await waitFor("提问被清空", () => !service.getRuntimeSnapshot().pendingQuestion, { timeoutMs: 30000 });
      await waitFor("turn 结束", () => !service.getRuntimeSnapshot().running, { timeoutMs: 90000 });
      return { question, kind, takeover, answers, receipt, settled, snap: service.getRuntimeSnapshot() };
    }
  });
  check("B1 收到 question/requested 且带 rpcId", () => {
    assert.ok(b.question.rpcId, "缺 rpcId");
    assert.ok((b.question.questions ?? []).length, "无问题条目");
  });
  check("B2 分类为普通提问(非 planReview)", () => assert.equal(b.kind, "question"));
  check("B3 takeover 判定为 question", () => assert.equal(b.takeover.kind, "question"));
  check("B4 单题单选即点即答", () => {
    if ((b.question.questions?.length ?? 0) !== 1) return;
    if (b.question.questions[0].multiSelect === true) return;
    assert.equal(b.settled.submit, true, "单题单选应立即结算");
  });
  check("B5 答案结构符合契约", () => {
    assert.equal(b.answers.length, b.question.questions.length);
    for (const ans of b.answers) {
      assert.ok(ans.id, "答案缺 id");
      assert.ok(Array.isArray(ans.selected), "selected 必须是数组");
      assert.ok(!(ans.selected.length > 0 && ans.custom != null), "selected 与 custom 不可共存");
    }
  });
  check("B6 宿主接受提问应答", () => {
    assert.notEqual(b.receipt?.accepted, false, "应答被拒: " + JSON.stringify(b.receipt));
  });
  check("B7 ask 工具行显示已答计数", () => {
    const ask = b.snap.nodes.find((n) => n.kind === "toolCall" && n.name === "ask_user_question");
    if (!ask) return;
    assert.match(toolRowModel(ask).summary, /answered|已回答/);
  });
} catch (e) { check("B 提问用例整体", () => { throw e; }); }

console.log("\n=== E2E 2 结果 ===");
for (const [status, name, msg] of results) {
  console.log((status === "PASS" ? "✔ " : "✘ ") + name + (msg ? " — " + msg : ""));
}
const failed = results.filter((r) => r[0] === "FAIL");
console.log("\n" + (results.length - failed.length) + "/" + results.length + " 通过");
process.exit(failed.length ? 1 : 0);
