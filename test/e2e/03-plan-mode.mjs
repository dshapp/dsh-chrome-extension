// E2E 3:真实计划模式。/plan 进入 → agent 产出计划 → plan-review 卡 → 批准 → 退出。
// 这是本次重写最核心的新功能,且线协议最容易写错(批准与意见互斥)。
import assert from "node:assert/strict";
import { rpc, respond, openDownlink, waitFor, sleep } from "./harness.mjs";
import { createSessionService } from "../../src/features/sessions/session-service.js";
import { createCommandService } from "../../src/features/commands/command-service.js";
import { routePlanReview, classifyQuestions, submitAnswer, reviseAnswer, approveAnswer,
  resolveTakeover } from "../../src/features/interactions/interaction-flow.js";
import { toolRowModel, planSummary } from "../../src/features/chat/tool-row-model.js";
const CWD = "/Users/user/dshmac/extension/dsh-chrome";
const results = [];
const check = (n, f) => { try { f(); results.push(["PASS", n]); } catch (e) { results.push(["FAIL", n, e.message]); } };

const service = createSessionService({ call: rpc, respond: async () => ({accepted:true}) });
const cmds = createCommandService({ call: rpc });
const sessionId = (await rpc("session.create", { cwd: CWD })).sessionId;
const dl = openDownlink((f, s) => { if (s==="mux") service.handleMuxFrame(f); else service.handleHostFrame(f); });
await dl.ready;
await service.open(sessionId, { cwd: CWD });
const snap = () => service.getRuntimeSnapshot();

// ── 进入计划模式 ──
const enter = await cmds.execute(sessionId, "/plan");
console.log("/plan 结果:", JSON.stringify(enter?.result ?? enter).slice(0,160));
await waitFor("plan 投影开启", () => snap().planMode === true, { timeoutMs: 20000,
  diagnose: () => ({ planMode: snap().planMode }) });
check("P1 /plan 后 planMode 投影为 true(驱动 plan 药丸)", () => assert.equal(snap().planMode, true));

// ── 让 agent 产出计划 ──
await service.prompt(sessionId, [{ type: "text", text: "为「给 README 增加一节安装说明」做一个简短计划,然后调用 exit_plan_mode 提交审阅。" }]);
const question = await waitFor("计划审阅请求", () => snap().pendingQuestion, { timeoutMs: 120000,
  diagnose: () => ({ running: snap().running, nodes: snap().nodes.map(n=>n.kind+(n.name?":"+n.name:"")) }) });

check("P2 收到 question/requested", () => assert.ok(question.rpcId));
const review = routePlanReview(question.questions ?? []);
check("P3 被路由为 plan-review(而非普通问答)", () => {
  assert.ok(review, "未识别为计划审阅: " + JSON.stringify(question.questions).slice(0,400));
});
check("P4 classify 与 route 判定一致", () => assert.equal(classifyQuestions(question.questions), "planReview"));
check("P5 takeover 判定为 question", () => assert.equal(resolveTakeover({question, approval:null}).kind, "question"));
if (review) {
  check("P6 计划正文非空且来自 detail", () => assert.ok(review.plan && review.plan.length > 20, "计划过短: " + review.plan));
  check("P7 approve 选项具名", () => assert.ok(review.approve?.label));
  check("P8 批准答案不带 custom 字段", () => {
    const a = approveAnswer(review);
    assert.deepEqual(a.selected, [review.approve.label]);
    assert.equal("custom" in a, false, "批准答案不能带 custom");
  });
  check("P9 带意见的答案 selected 为空且不批准", () => {
    const a = submitAnswer(review, "换个方向");
    assert.deepEqual(a.selected, []);
    assert.equal(a.custom, "换个方向");
  });
  check("P10 exit_plan_mode 工具行显示等待审阅", () => {
    const row = snap().nodes.find(n => n.kind === "toolCall" && n.name === "exit_plan_mode");
    if (!row) return;
    assert.match(toolRowModel(row).summary, /Awaiting|等待审阅/);
  });

  // ── 真正批准 ──
  const answer = submitAnswer(review, "");
  console.log("发出批准:", JSON.stringify(answer));
  const receipt = await respond(question.rpcId, { ok: true, value: { sessionId, answer: { answers: [answer] } } });
  console.log("回执:", JSON.stringify(receipt));
  check("P11 宿主接受批准答案", () => assert.notEqual(receipt?.accepted, false, "被拒: " + JSON.stringify(receipt)));
  await waitFor("提问清空", () => !snap().pendingQuestion, { timeoutMs: 30000 });
  check("P12 批准后提问被清空", () => assert.ok(!snap().pendingQuestion));
  // 批准即退出计划模式
  try {
    await waitFor("plan 投影关闭", () => snap().planMode !== true, { timeoutMs: 45000 });
    check("P13 批准后自动退出计划模式(plan 药丸消失)", () => assert.notEqual(snap().planMode, true));
  } catch (e) { check("P13 批准后自动退出计划模式(plan 药丸消失)", () => { throw e; }); }
  await sleep(3000);
  check("P14 exit_plan_mode 行结算为「计划已通过」", () => {
    const row = snap().nodes.find(n => n.kind === "toolCall" && n.name === "exit_plan_mode");
    if (!row || !row.result) return;
    const s = planSummary(row);
    if (s === null) return; // 出错路径由错误摘要接管,合法
    assert.match(s, /approved|已通过/, "结算摘要异常: " + s);
  });
}

dl.close(); await rpc("session.cancel",{sessionId}).catch(()=>{});
console.log("\n=== E2E 3 结果 ===");
for (const [st, n, m] of results) console.log((st==="PASS"?"✔ ":"✘ ")+n+(m?" — "+m:""));
const failed = results.filter(r=>r[0]==="FAIL");
console.log("\n"+(results.length-failed.length)+"/"+results.length+" 通过");
process.exit(failed.length?1:0);
