/**
 * 后台任务(dsh 0.1.7):停止(job/kill)、详情实时输出(job/follow)、
 * 进行中 / 已结束分段 + 折叠 + 本地清空、退出码 / 信号拆分。
 *
 * 对齐 web ui-jobs JobListAction + api/job-controller ClientJobsModel,
 * 以及 Mac 267bcde 的 Docks / CardDetailSheet / StreamCoordinator。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;

const {
  mountJobList, parseJobTermination, reduceJobOutput, emptyJobOutput, splitJobSections,
  isObservableJob, buildJobDetail, JOB_OUTPUT_TAIL_LIMIT
} = await import("../src/features/docks/job-list.js");
const { _resetCardDetail, closeCardDetail } = await import("../src/features/chat/card-detail.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const job = (id, status, extra = {}) => ({
  id, kind: "bash", label: `cmd ${id}`, status, startedAt: 1000, output: { total: 0, earliest: 0 }, ...extra
});

function fakeConnection({ kill } = {}) {
  const calls = [];
  const subs = [];
  const unsubs = [];
  let listener = null;
  return {
    calls, subs, unsubs,
    emit: (frame) => listener?.(frame, "mux"),
    async call(method, args) {
      calls.push([method, args]);
      if (kill) return kill(method, args);
      return { outcome: "requested" };
    },
    subscribe(streamId, endpoint, args) { subs.push({ streamId, endpoint, args }); },
    unsubscribe(streamId) { unsubs.push(streamId); },
    onFrame(fn) { listener = fn; return () => { listener = null; }; }
  };
}

function mount(connection, notes = []) {
  _resetCardDetail();
  // 每个用例一套新节点:旧挂载的 toggle 监听不能往同一个浮层里画。
  document.body.innerHTML = '<button id="jobs-btn"><span class="jobs-dot"></span><span class="jobs-label"></span></button><div id="jobs-menu"></div>';
  const trigger = document.getElementById("jobs-btn");
  const menu = document.getElementById("jobs-menu");
  const list = mountJobList(trigger, menu, {
    connection, getSessionId: () => "s1", notify: (message) => notes.push(message)
  });
  const open = () => {
    const event = new Event("toggle");
    event.newState = "open";
    menu.dispatchEvent(event);
  };
  return { list, trigger, menu, open };
}

test("parseJobTermination:拆出退出码 / 信号,剩余文字保留;null 信号忽略", () => {
  assert.deepEqual(parseJobTermination("exit code: 3"), { exitCode: 3, signal: null, remainder: null });
  assert.deepEqual(parseJobTermination("signal: SIGTERM; cancelled by the user"),
    { exitCode: null, signal: "SIGTERM", remainder: "cancelled by the user" });
  assert.deepEqual(parseJobTermination("exit code: 0; signal: null"), { exitCode: 0, signal: null, remainder: null });
  assert.deepEqual(parseJobTermination("max-tokens"), { exitCode: null, signal: null, remainder: "max-tokens" });
  assert.deepEqual(parseJobTermination(undefined), { exitCode: null, signal: null, remainder: null });
});

test("buildJobDetail:退出码非 0 标红、0 不标;运行中 progress 覆盖 detail 且不拆", () => {
  const failed = buildJobDetail(job("a", "failed", { detail: "exit code: 2", finishedAt: 2000 }), "1s");
  const code = [...failed.querySelectorAll("dd")].find((dd) => dd.textContent === "2");
  assert.ok(code.classList.contains("exit-nonzero"));
  const ok = buildJobDetail(job("b", "completed", { detail: "exit code: 0", finishedAt: 2000 }), "1s");
  const zero = [...ok.querySelectorAll("dd")].find((dd) => dd.textContent === "0");
  assert.ok(zero && !zero.classList.contains("exit-nonzero"));
  const running = buildJobDetail(job("c", "running", { progress: "3/10", detail: "exit code: 9" }), "1s");
  assert.ok([...running.querySelectorAll("dd")].some((dd) => dd.textContent === "3/10"));
  assert.ok(![...running.querySelectorAll("dd")].some((dd) => dd.textContent === "9"));
});

test("isObservableJob:活着的任务或 output.total>0", () => {
  assert.equal(isObservableJob(job("a", "running")), true);
  assert.equal(isObservableJob(job("a", "completed")), false);
  assert.equal(isObservableJob(job("a", "completed", { output: { total: 5, earliest: 0 } })), true);
});

test("reduceJobOutput:opened 清零并按锚点记 gap;output 拼接、lossy/gapBefore 记 gap;超 128K 留尾;status 收尾", () => {
  let state = reduceJobOutput({ ...emptyJobOutput(), text: "stale" },
    { type: "opened", job: job("a", "running"), from: 0 });
  assert.deepEqual(state, { text: "", gapBefore: false, streaming: true, error: null });
  state = reduceJobOutput(state, { type: "output", chunks: [{ at: 0, text: "he" }, { at: 2, text: "llo" }], next: 5 });
  assert.equal(state.text, "hello");
  assert.equal(state.gapBefore, false);
  assert.equal(reduceJobOutput(state, { type: "output", chunks: [{ at: 9, text: "x", gapBefore: true }] }).gapBefore, true);
  assert.equal(reduceJobOutput(state, { type: "output", chunks: [], lossy: true }).gapBefore, true);
  const evicted = reduceJobOutput(emptyJobOutput(), { type: "opened", job: job("a", "running", { output: { total: 10, earliest: 4 } }), from: 4 });
  assert.equal(evicted.gapBefore, true);
  const big = reduceJobOutput(state, { type: "output", chunks: [{ text: "y".repeat(JOB_OUTPUT_TAIL_LIMIT) }] });
  assert.equal(big.text.length, JOB_OUTPUT_TAIL_LIMIT);
  assert.ok(big.text.endsWith("y") && !big.text.includes("h"));
  assert.equal(big.gapBefore, true);
  assert.equal(reduceJobOutput(state, { type: "status", job: job("a", "completed") }).streaming, false);
});

test("splitJobSections:进行中在前,已结束去掉清空过的", () => {
  const { live, settled } = splitJobSections(
    [job("a", "completed", { finishedAt: 5 }), job("b", "running"), job("c", "failed", { finishedAt: 9 })],
    new Set(["a"])
  );
  assert.deepEqual(live.map((j) => j.id), ["b"]);
  assert.deepEqual(settled.map((j) => j.id), ["c"]);
});

test("浮层:两段 + 已结束默认折叠(有进行中时)+ 清空只本地隐藏", () => {
  const connection = fakeConnection();
  const { list, trigger, menu, open } = mount(connection);
  list.set([job("r", "running"), job("d", "completed", { finishedAt: 2000 })]);
  open();
  const heads = menu.querySelectorAll(".jobs-section-head");
  assert.equal(heads.length, 2);
  // 有进行中任务时已结束段默认折叠:只画一行(running)。
  assert.equal(menu.querySelectorAll(".jobs-row").length, 1);
  menu.querySelector(".jobs-section-toggle").click();
  assert.equal(menu.querySelectorAll(".jobs-row").length, 2);
  menu.querySelector(".jobs-section-clear").click();
  assert.equal(menu.querySelectorAll(".jobs-row").length, 1);
  assert.equal(menu.querySelectorAll(".jobs-section-head").length, 1);
  // 清空不调接口。
  assert.equal(connection.calls.length, 0);
  // 只剩已清空的已结束任务时,入口隐藏。
  list.set([job("d", "completed", { finishedAt: 2000 })]);
  assert.equal(trigger.hidden, true);
});

test("停止:confirm 取消不发;确认后发 job/kill {request:{sessionId,jobId}},pending 期间禁用,行翻出 running 后按钮消失", async () => {
  const connection = fakeConnection();
  const { list, menu, open } = mount(connection);
  list.set([job("r", "running")]);
  open();
  window.confirm = () => false;
  menu.querySelector(".jobs-stop").click();
  await flush();
  assert.equal(connection.calls.length, 0);
  window.confirm = () => true;
  menu.querySelector(".jobs-stop").click();
  await flush();
  assert.deepEqual(connection.calls, [["job/kill", { request: { sessionId: "s1", jobId: "r" } }]]);
  assert.equal(menu.querySelector(".jobs-stop").disabled, true);
  list.set([job("r", "stopping")]);
  assert.equal(menu.querySelector(".jobs-stop"), null);
});

test("停止:job/not-found 友好提示并恢复按钮;其它错误报停止失败", async () => {
  const notes = [];
  let code = "job/not-found";
  const connection = fakeConnection({
    kill: () => { const error = new Error("gone"); error.code = code; throw error; }
  });
  const { list, menu, open } = mount(connection, notes);
  list.set([job("r", "running")]);
  open();
  window.confirm = () => true;
  menu.querySelector(".jobs-stop").click();
  await flush();
  assert.equal(notes.length, 1);
  assert.ok(!notes[0].includes("gone"));
  assert.equal(menu.querySelector(".jobs-stop").disabled, false);
  code = "boom";
  menu.querySelector(".jobs-stop").click();
  await flush();
  assert.ok(notes[1].includes("gone"));
});

test("详情:可观测任务订阅 job/follow,帧流入输出区;关闭详情取消订阅", () => {
  const connection = fakeConnection();
  const { list, menu, open } = mount(connection);
  const running = job("r", "running");
  list.set([running]);
  open();
  menu.querySelector(".jobs-row").click();
  assert.deepEqual(connection.subs, [{ streamId: "jobfollow:r", endpoint: "job/follow", args: { request: { sessionId: "s1", jobId: "r" } } }]);
  const dialog = document.querySelector("dialog.card-detail");
  assert.ok(dialog.querySelector(".jobs-stop"), "running 任务详情里有停止键");
  connection.emit({ type: "item", streamId: "jobfollow:r", value: { type: "opened", job: running, from: 3 } });
  connection.emit({ type: "item", streamId: "jobfollow:r", value: { type: "output", chunks: [{ at: 3, text: "line1\n" }], next: 9 } });
  // 别的流的帧不串进来。
  connection.emit({ type: "item", streamId: "jobfollow:x", value: { type: "output", chunks: [{ text: "nope" }] } });
  assert.equal(dialog.querySelector(".jobs-output-text").textContent, "line1\n");
  assert.equal(dialog.querySelector(".jobs-output-note:not(.error)").hidden, false, "锚点 >0 提示前面被截断");
  // 名册推进:详情字段跟着变(结束 + 退出码)。
  list.set([job("r", "failed", { detail: "exit code: 1", finishedAt: 3000 })]);
  assert.ok(dialog.querySelector(".exit-nonzero"));
  assert.equal(dialog.querySelector(".jobs-stop"), null);
  connection.emit({ type: "item", streamId: "jobfollow:r", value: { type: "status", job: running } });
  assert.equal(dialog.querySelector(".jobs-output-live").hidden, true);
  closeCardDetail();
  assert.deepEqual(connection.unsubs, ["jobfollow:r"]);
});

test("详情:已结束且无保留输出的任务不订阅 job/follow;复制键复制命令", () => {
  const connection = fakeConnection();
  const { list, menu, open } = mount(connection);
  list.set([job("d", "completed", { finishedAt: 2000 })]);
  open();
  menu.querySelector(".jobs-row").click();
  assert.equal(connection.subs.length, 0);
  const dialog = document.querySelector("dialog.card-detail");
  assert.equal(dialog.querySelector(".jobs-output"), null);
  assert.equal(dialog.querySelector(".card-detail-copy").hidden, false);
  closeCardDetail();
  assert.equal(connection.unsubs.length, 0);
});
