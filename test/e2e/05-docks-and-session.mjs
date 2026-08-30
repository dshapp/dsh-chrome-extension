// E2E 5:本轮补齐的功能面 —— goal 生命周期、投影驱动的停靠区、agent 预设、
// 归档、@ 引用来源、附件限制。全部打真实后端。
import assert from "node:assert/strict";
import { rpc, openDownlink, waitFor, sleep } from "./harness.mjs";
import { createSessionService } from "../../src/features/sessions/session-service.js";
import { createGoalService } from "../../src/features/goals/goal-service.js";
import { createReferenceService } from "../../src/features/references/reference-service.js";
import { createCommandService } from "../../src/features/commands/command-service.js";
import { activeGoal, contextRatio, statsText } from "../../src/features/docks/session-docks.js";
import { validateImage } from "../../src/features/attachments/attachments.js";
const CWD = "/Users/user/dshmac/extension/dsh-chrome";
const results = [];
const check = (n,f)=>{ try{f();results.push(["PASS",n]);}catch(e){results.push(["FAIL",n,e.message]);} };
const conn = { call: rpc, respond: async()=>({accepted:true}) };
const service = createSessionService(conn);
const goals = createGoalService(conn);
const refs = createReferenceService(conn);
const cmds = createCommandService(conn);
const sessionId = (await rpc("session.create",{cwd:CWD})).sessionId;
const dl = openDownlink((f,s)=>{ if(s==="mux") service.handleMuxFrame(f); else service.handleHostFrame(f); });
await dl.ready; await service.open(sessionId,{cwd:CWD});
const snap = () => service.getRuntimeSnapshot();

// ── 目标生命周期 ──
await goals.create(sessionId, "E2E:验证目标停靠区");
await waitFor("goal 投影", () => snap().goal, { timeoutMs: 20000 });
check("G1 目标投影被解码", () => {
  const g = snap().goal;
  assert.equal(g.objective, "E2E:验证目标停靠区");
  assert.equal(g.phase, "active");
  assert.ok(g.id && Number.isInteger(g.revision));
});
check("G2 activeGoal 认定为生效中", () => assert.ok(activeGoal(snap().goal)));
await goals.edit(sessionId, snap().goal, "E2E:已编辑");
await waitFor("编辑生效", () => snap().goal?.objective === "E2E:已编辑", { timeoutMs: 15000 });
check("G3 编辑落到投影(revision 递增)", () => assert.ok(snap().goal.revision >= 2));
await goals.pause(sessionId, snap().goal);
await waitFor("暂停生效", () => snap().goal?.phase === "paused", { timeoutMs: 15000 });
check("G4 暂停后 phase=paused", () => assert.equal(snap().goal.phase, "paused"));
await goals.resume(sessionId, snap().goal);
await waitFor("继续生效", () => snap().goal?.phase === "active", { timeoutMs: 15000 });
check("G5 继续后 phase=active", () => assert.equal(snap().goal.phase, "active"));
await goals.clear(sessionId, snap().goal);
await waitFor("清除生效", () => !activeGoal(snap().goal), { timeoutMs: 15000 });
check("G6 清除后目标条隐藏", () => assert.ok(!activeGoal(snap().goal)));

// ── 让会话产生真实统计与上下文压力 ──
await service.prompt(sessionId, [{ type:"text", text:"用一句话回答:1+1 等于几?" }]);
await waitFor("turn 结束", () => !snap().running && snap().nodes.length > 1, { timeoutMs: 120000 });
await sleep(2500);
check("S1 sessionStats 投影被解码", () => {
  const s = snap().sessionStats;
  assert.ok(s, "缺 sessionStats 投影");
  assert.ok(s.turns >= 1 && s.steps >= 1, JSON.stringify(s));
});
check("S2 contextPressure 可算出占比", () => {
  const r = contextRatio(snap().contextPressure);
  assert.ok(r !== null, "缺 contextPressure: " + JSON.stringify(snap().contextPressure));
  assert.ok(r >= 0 && r <= 1, "占比越界: " + r);
});
check("S3 统计行渲染出内容", () => {
  const text = statsText(snap().sessionStats, snap().tokenUsage);
  assert.ok(text.length > 0, "统计行为空");
});
check("S4 tokenUsage 投影被解码", () => assert.ok(snap().tokenUsage, "缺 tokenUsage"));
check("S5 imageLimits 投影被解码", () => {
  const l = snap().imageLimits;
  assert.ok(l?.maxImageBytes > 0, "缺 imageLimits: " + JSON.stringify(l));
});
check("S6 附件校验用宿主真实上限(非写死 10MB)", () => {
  const l = snap().imageLimits;
  const file = { name: "big.png", type: "image/png", size: 15 * 1024 * 1024 };
  // 宿主上限 20MB,15MB 应放行;若代码仍写死 10MB 这里会失败。
  if (l.maxImageBytes >= 15 * 1024 * 1024) {
    assert.equal(validateImage(file, l, []), null, "宿主允许的图片被本地误拦");
  }
  const huge = { name: "huge.png", type: "image/png", size: l.maxImageBytes + 1 };
  assert.ok(validateImage(huge, l, []), "超限图片未被拦下");
});

// ── agent 预设 ──
const presets = await service.listAgentPresets();
check("P1 预设列表非空且带 id/name", () => {
  const list = presets?.presets ?? [];
  assert.ok(list.length > 0, "无预设");
  assert.ok(list[0].id && list[0].name);
});

// ── @ 引用来源 ──
const files = await refs.files(sessionId, "session-store");
check("R1 文件引用能搜到工作区文件", () => {
  assert.ok(files.length > 0, "无文件候选");
  assert.ok(files[0].value.startsWith("@"), "候选未格式化为 mention: " + files[0].value);
});
const sessionRefs = await refs.sessions(sessionId, "");
check("R2 会话引用返回带 mention 的候选", () => {
  assert.ok(sessionRefs.length > 0, "无会话候选");
  assert.ok(sessionRefs[0].value.includes("dsh-session:"), sessionRefs[0].value);
});

// ── 搜索降级 ──
const searched = await service.search("plan");
check("R3 搜索索引未开启时优雅降级为 null(不抛错)", () => {
  assert.ok(searched === null || typeof searched === "object");
});

// ── 归档 ──
const archived = await service.archive(sessionId);
check("A1 归档返回归档 id 列表且包含本会话", () => {
  assert.ok(Array.isArray(archived));
  assert.ok(archived.includes(sessionId), "归档列表未含本会话");
});

dl.close();
console.log("\n=== E2E 5 结果 ===");
for (const [st,n,m] of results) console.log((st==="PASS"?"✔ ":"✘ ")+n+(m?" — "+m:""));
const failed = results.filter(r=>r[0]==="FAIL");
console.log("\n"+(results.length-failed.length)+"/"+results.length+" 通过");
process.exit(failed.length?1:0);
