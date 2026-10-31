/**
 * 输入框底栏权限模式右侧的计划模式开关(#plan-chip,composer-dock.js)。
 *
 * 默认关闭:一行弱灰字;点击执行 /plan,投影确认后变成高亮药丸;
 * 再点执行 /plan off 关闭。切换在途时禁用,不做乐观翻转。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { createComposerDock } = await import("../src/app/sidepanel/composer-dock.js");
const { setLang } = await import("../src/shared/i18n.js");
setLang("zh");

function harness({ execute } = {}) {
  document.body.innerHTML = `
    <button id="plan-chip" class="bar-btn plan-chip" aria-pressed="false" hidden>
      <span class="plan-chip-label">Plan</span><span class="plan-chip-x"></span>
    </button>`;
  const chip = document.querySelector("#plan-chip");
  const commands = [];
  const toasts = [];
  const state = { sessionId: "s1" };
  const dock = createComposerDock({
    elements: { planChip: chip },
    deps: { commands: { execute: async (sessionId, text) => {
      commands.push([sessionId, text]);
      return execute ? execute(sessionId, text) : { result: { kind: "ok" } };
    } } },
    state,
    showToast: (text) => toasts.push(text),
    format: (error) => String(error?.message ?? error)
  });
  return { chip, dock, commands, toasts, state };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("没有 plan 投影(null)时不显示开关", () => {
  const { chip, dock } = harness();
  dock.renderPlanChip(null);
  assert.equal(chip.hidden, true);
});

test("默认关闭:显示弱灰字「计划」,不是高亮药丸", () => {
  const { chip, dock } = harness();
  dock.renderPlanChip(false);
  assert.equal(chip.hidden, false);
  assert.equal(chip.classList.contains("on"), false);
  assert.equal(chip.getAttribute("aria-pressed"), "false");
  assert.equal(chip.querySelector(".plan-chip-label").textContent, "计划");
  assert.equal(chip.disabled, false);
});

test("点击关闭态 → /plan;投影确认前禁用不翻转,确认后变成高亮药丸", async () => {
  const { chip, dock, commands } = harness();
  dock.renderPlanChip(false);
  chip.click();
  await tick();
  assert.deepEqual(commands, [["s1", "/plan"]]);
  assert.equal(chip.disabled, true);
  assert.equal(chip.classList.contains("on"), false);
  // 再点不重复发命令
  chip.click();
  await tick();
  assert.equal(commands.length, 1);
  dock.renderPlanChip(true);
  assert.equal(chip.disabled, false);
  assert.equal(chip.classList.contains("on"), true);
  assert.equal(chip.getAttribute("aria-pressed"), "true");
});

test("点击开启态 → /plan off,确认后回到弱灰字", async () => {
  const { chip, dock, commands } = harness();
  dock.renderPlanChip(true);
  chip.click();
  await tick();
  assert.deepEqual(commands, [["s1", "/plan off"]]);
  dock.renderPlanChip(false);
  assert.equal(chip.classList.contains("on"), false);
  assert.equal(chip.disabled, false);
});

test("命令失败:恢复可点并提示,状态不变", async () => {
  const { chip, dock, toasts } = harness({ execute: () => ({ result: { kind: "error", text: "boom" } }) });
  dock.renderPlanChip(false);
  chip.click();
  await tick();
  assert.equal(chip.disabled, false);
  assert.equal(chip.classList.contains("on"), false);
  assert.ok(toasts.includes("进入计划模式失败"));
  assert.ok(toasts.includes("boom"));
});

test("只读子代理会话:开关可见但禁用", async () => {
  const { chip, dock, commands } = harness();
  dock.renderPlanChip(false, { readOnly: true });
  assert.equal(chip.hidden, false);
  assert.equal(chip.disabled, true);
});

test("exitPlanMode(快捷键)只在开启时发 /plan off", async () => {
  const { dock, commands } = harness();
  dock.renderPlanChip(false);
  await dock.exitPlanMode();
  assert.equal(commands.length, 0);
  dock.renderPlanChip(true);
  await dock.exitPlanMode();
  assert.deepEqual(commands, [["s1", "/plan off"]]);
});
