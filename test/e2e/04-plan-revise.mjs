// E2E 4:计划审阅的「带意见继续规划」分支。
// 这条路径的线协议最容易写错:selected 必须为空、custom 单独发,同时带会被整体拒收。
import assert from "node:assert/strict";
import { rpc, respond, openDownlink, waitFor, sleep } from "./harness.mjs";
import { createSessionService } from "../../src/features/sessions/session-service.js";
import { createCommandService } from "../../src/features/commands/command-service.js";
import { routePlanReview, reviseAnswer, cancelledResult } from "../../src/features/interactions/interaction-flow.js";
const CWD = "/Users/user/dshmac/extension/dsh-chrome";
const results = [];
const check = (n,f)=>{ try{f();results.push(["PASS",n]);}catch(e){results.push(["FAIL",n,e.message]);} };
const service = createSessionService({ call: rpc, respond: async()=>({accepted:true}) });
const cmds = createCommandService({ call: rpc });
const sessionId = (await rpc("session.create",{cwd:CWD})).sessionId;
const dl = openDownlink((f,s)=>{ if(s==="mux") service.handleMuxFrame(f); else service.handleHostFrame(f); });
await dl.ready; await service.open(sessionId,{cwd:CWD});
const snap = () => service.getRuntimeSnapshot();
await cmds.execute(sessionId, "/plan");
await waitFor("plan 开启", () => snap().planMode === true, { timeoutMs: 20000 });
await service.prompt(sessionId, [{ type:"text", text:"为「给 README 加一节 FAQ」做个简短计划,然后调用 exit_plan_mode 提交审阅。" }]);
const q1 = await waitFor("首次审阅", () => snap().pendingQuestion, { timeoutMs: 120000 });
const r1 = routePlanReview(q1.questions ?? []);
check("R1 首次为计划审阅", () => assert.ok(r1));
const notes = "请改为只加三条 FAQ,并放在文件末尾。";
const answer = reviseAnswer(r1, notes);
console.log("发出修改意见:", JSON.stringify(answer));
check("R2 意见答案 selected 为空", () => assert.deepEqual(answer.selected, []));
check("R3 意见答案 custom 为原文", () => assert.equal(answer.custom, notes));
const receipt = await respond(q1.rpcId, { ok:true, value:{ sessionId, answer:{ answers:[answer] } } });
console.log("回执:", JSON.stringify(receipt));
check("R4 宿主接受带意见的答案(未判 bad-response)", () => {
  assert.notEqual(receipt?.accepted, false, "被拒: " + JSON.stringify(receipt));
});
await waitFor("首次审阅清空", () => !snap().pendingQuestion, { timeoutMs: 30000 });
check("R5 仍处于计划模式(未被误判为批准)", () => {
  assert.equal(snap().planMode, true, "带意见的答案不应退出计划模式 —— 说明被误读成了批准");
});
// 模型应据意见重做计划并再次提交审阅
try {
  const q2 = await waitFor("二次审阅", () => snap().pendingQuestion, { timeoutMs: 120000 });
  const r2 = routePlanReview(q2.questions ?? []);
  check("R6 模型据意见重新提交了计划", () => assert.ok(r2, "二次请求不是计划审阅"));
  if (r2) check("R7 新计划与旧计划不同(意见被采纳)", () => {
    assert.notEqual(r2.plan, r1.plan, "计划未变化,意见可能没送到模型");
  });
  // 撤销必须走 cancelledResult():宿主 rpcErrorSchema 要求 error.details 为对象,
  // 手写裸 error(缺 details 或 details 为字符串)会被判 bad-response,卡片永远清不掉。
  const revoke = await respond(q2.rpcId, cancelledResult());
  check("R8a 宿主接受撤销应答", () => assert.notEqual(revoke?.accepted, false, "被拒: " + JSON.stringify(revoke)));
  await sleep(4000);
  check("R8 撤销(cancelled)被接受并清空", () => assert.ok(!snap().pendingQuestion));
} catch(e) { check("R6 模型据意见重新提交了计划", () => { throw e; }); }
await cmds.execute(sessionId, "/plan off").catch(()=>{});
dl.close(); await rpc("session.cancel",{sessionId}).catch(()=>{});
console.log("\n=== E2E 4 结果 ===");
for (const [st,n,m] of results) console.log((st==="PASS"?"✔ ":"✘ ")+n+(m?" — "+m:""));
const failed = results.filter(r=>r[0]==="FAIL");
console.log("\n"+(results.length-failed.length)+"/"+results.length+" 通过");
process.exit(failed.length?1:0);
