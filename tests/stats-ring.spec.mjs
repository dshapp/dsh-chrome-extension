/**
 * 输入框底部发送键左侧的上下文统计圈(#stats-btn)。
 *
 * 对齐 Mac ComposerDock.ContextMeter:只有拿到上下文占用读数
 * (SessionStore.contextOccupancy 非 nil)才画圈;新建会话页没有读数,圈不出现,
 * 即便已经有会话(轨迹入口)也不为它留一枚 0% 的空圈。
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

const { mountStatsBar, contextRatio } = await import("../src/features/docks/session-docks.js");

function mount() {
  const trigger = document.createElement("button");
  trigger.innerHTML = '<span class="stats-ring"></span>';
  trigger.hidden = true;
  const menu = document.createElement("div");
  const bar = mountStatsBar(trigger, menu, { onOpenTrajectory: () => {} });
  return { trigger, menu, bar };
}

test("新建会话页:有会话(轨迹入口)但没有上下文读数 → 不画圈", () => {
  const { trigger, menu, bar } = mount();
  bar.set({ contextPressure: null, sessionStats: null, tokenUsage: null, presetName: "PTC 模式", trajectoryEntry: true });
  assert.equal(trigger.hidden, true);
  assert.equal(menu.childElementCount, 0);
});

test("只有统计、没有上下文读数 → 同 Mac 不画圈", () => {
  const { trigger, bar } = mount();
  bar.set({
    contextPressure: undefined,
    sessionStats: { turns: 1, steps: 2, llmMs: 1000, toolMs: 0 },
    tokenUsage: { uncachedInputTokens: 10, outputTokens: 5 },
    trajectoryEntry: true
  });
  assert.equal(trigger.hidden, true);
});

test("contextPressure 只有窗口、没有已用量 → 视为无读数,不画 0% 圈", () => {
  assert.equal(contextRatio({ contextWindow: 128000 }), null);
  assert.equal(contextRatio({ contextWindow: 128000, pressureTokens: null }), null);
  const { trigger, bar } = mount();
  bar.set({ contextPressure: { contextWindow: 128000 }, trajectoryEntry: true });
  assert.equal(trigger.hidden, true);
});

test("有上下文读数 → 画圈,浮层带占用、统计与轨迹入口", () => {
  const { trigger, menu, bar } = mount();
  bar.set({
    contextPressure: { contextWindow: 100000, pressureTokens: 28000 },
    sessionStats: { turns: 1, steps: 2, llmMs: 1000, toolMs: 0 },
    tokenUsage: null,
    trajectoryEntry: true
  });
  assert.equal(trigger.hidden, false);
  assert.equal(trigger.querySelector(".stats-ring").style.getPropertyValue("--stats-pct"), "28%");
  assert.ok(menu.querySelector(".context-meter"));
  assert.ok(menu.querySelector(".stats-rows"));
  assert.ok(menu.querySelector(".stats-trajectory-link"));
});

test("0 已用量是合法读数(不是缺失)→ 画圈", () => {
  assert.equal(contextRatio({ contextWindow: 1000, projectedTokens: 0 }), 0);
});

test("读数消失(切到新建会话)→ 圈收起", () => {
  const { trigger, menu, bar } = mount();
  bar.set({ contextPressure: { contextWindow: 1000, pressureTokens: 500 }, trajectoryEntry: true });
  assert.equal(trigger.hidden, false);
  bar.set({ contextPressure: null, trajectoryEntry: true });
  assert.equal(trigger.hidden, true);
  assert.equal(menu.childElementCount, 0);
});
