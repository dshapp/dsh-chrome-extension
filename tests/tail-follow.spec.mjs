/**
 * 尾部跟随(对齐 DSH Web ScrollFollow / ChatReading):停在底部就随新内容钉底,
 * 读者上滚离开底部即放手并出现「回到底部」按钮,点按钮(或自己滚回底部)落底并恢复跟随。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

// JSDOM 没有 ResizeObserver:收集回调,由测试手动触发"尺寸变了"。
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() {}
};
const fireResize = () => { for (const o of observers) o.callback([]); };

const { createTailFollow, mountTailFollow, FOLLOW_THRESHOLD_PX, INTERACTION_GRACE_MS } = await import("../src/features/chat/tail-follow.js");

/// 一个带几何的假滚动容器:scrollTop 按 [0, floor] 钳制,写入后像浏览器一样派发 scroll。
function fakeScroller({ height = 400, contentHeight = 1000 } = {}) {
  const el = document.createElement("div");
  const list = document.createElement("div");
  el.append(list);
  document.body.append(el);
  let top = 0;
  const geo = { height, contentHeight };
  Object.defineProperty(el, "clientHeight", { get: () => geo.height });
  Object.defineProperty(el, "scrollHeight", { get: () => Math.max(geo.height, geo.contentHeight) });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (value) => {
      const next = Math.max(0, Math.min(value, Math.max(0, geo.contentHeight - geo.height)));
      if (next === top) return;
      top = next;
      el.dispatchEvent(new window.Event("scroll"));
    }
  });
  return {
    el, list, geo,
    get floor() { return Math.max(0, geo.contentHeight - geo.height); },
    /// 读者滚动到某个 offset。
    scrollTo(value) { el.scrollTop = value; },
    /// 内容在下方增长:只动 floor,不动 offset,没有 scroll 事件。
    grow(px) { geo.contentHeight += px; }
  };
}

function setup({ now } = {}) {
  observers.length = 0;
  const s = fakeScroller();
  const button = document.createElement("button");
  button.hidden = true;
  document.body.append(button);
  let returned = 0;
  const follow = mountTailFollow(s.el, { content: [s.list], button, onReturn: () => { returned += 1; }, now });
  return { s, button, follow, returned: () => returned };
}

test("纯状态:自己 pin 的回声不算读者移动;阈值内的小回弹不放手", () => {
  const f = createTailFollow();
  assert.equal(f.isFollowing, true);
  f.pinned(600);
  assert.equal(f.scrolled({ top: 600, floor: 600 }), true);
  // 阈值内向上一点:仍算在底部
  assert.equal(f.scrolled({ top: 600 - FOLLOW_THRESHOLD_PX, floor: 600 }), true);
});

test("纯状态:上滚离开底部即放手;向下但没到底保持原意图;回到底部恢复跟随", () => {
  const f = createTailFollow();
  f.pinned(600);
  assert.equal(f.scrolled({ top: 400, floor: 600 }), false);
  // 往下挪了但没到底:仍不跟随
  assert.equal(f.scrolled({ top: 500, floor: 600 }), false);
  // 回到底部阈值内:恢复
  assert.equal(f.scrolled({ top: 590, floor: 600 }), true);
});

test("纯状态:跟随中内容先长、读者往下滚了一点但还没追上底 —— 不误放手", () => {
  const f = createTailFollow();
  f.pinned(600);
  // floor 被新内容推到 900,读者向下滚 20px
  assert.equal(f.scrolled({ top: 620, floor: 900 }), true);
});

test("跟随中:内容增长后 autoScroll 钉到新底部,按钮不出现", () => {
  const { s, button, follow } = setup();
  follow.pin();
  assert.equal(s.el.scrollTop, s.floor);
  s.grow(300);
  follow.autoScroll();
  assert.equal(s.el.scrollTop, s.floor);
  assert.equal(follow.isFollowing, true);
  assert.equal(button.hidden, true);
  assert.ok(s.el.classList.contains("tail-following"));
});

test("读者上滚离开底部:不再跟随、出现按钮;流式内容继续长也不把他拽回去", () => {
  const { s, button, follow } = setup();
  follow.pin();
  s.scrollTo(s.floor - 200);
  assert.equal(follow.isFollowing, false);
  assert.equal(button.hidden, false);
  assert.ok(!s.el.classList.contains("tail-following"));
  const reading = s.el.scrollTop;
  s.grow(500);
  follow.autoScroll();
  assert.equal(s.el.scrollTop, reading);
  assert.equal(button.hidden, false);
});

test("向上的滚轮意图立刻放手(触控板一小步也算),避免被下一帧 pin 拽回", () => {
  const { s, button, follow } = setup();
  follow.pin();
  s.el.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -3, bubbles: true }));
  assert.equal(follow.isFollowing, false);
  s.scrollTo(s.el.scrollTop - 3);
  s.grow(200);
  follow.autoScroll();
  assert.equal(follow.isFollowing, false);
  assert.equal(button.hidden, false);
  // 向下的滚轮不释放(也不会单凭滚轮恢复,要真的到底)
  follow.pin();
  s.el.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 10, bubbles: true }));
  assert.equal(follow.isFollowing, true);
});

test("滚轮落在还能往上滚的内层滚动块(长代码块)里:外层不放手", () => {
  const { s, follow } = setup();
  follow.pin();
  const inner = document.createElement("pre");
  inner.style.overflowY = "auto";
  Object.defineProperty(inner, "clientHeight", { get: () => 100 });
  Object.defineProperty(inner, "scrollHeight", { get: () => 500 });
  inner.scrollTop = 0;
  Object.defineProperty(inner, "scrollTop", { get: () => 50, set() {} });
  s.list.append(inner);
  inner.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -10, bubbles: true }));
  assert.equal(follow.isFollowing, true);
});

test("点「回到底部」:落到最新底部、恢复跟随、按钮收起,之后新内容继续钉底", () => {
  const { s, button, follow, returned } = setup();
  follow.pin();
  s.scrollTo(100);
  s.grow(400);
  assert.equal(button.hidden, false);
  button.click();
  assert.equal(s.el.scrollTop, s.floor);
  assert.equal(follow.isFollowing, true);
  assert.equal(button.hidden, true);
  assert.equal(returned(), 1);
  s.grow(250);
  follow.autoScroll();
  assert.equal(s.el.scrollTop, s.floor);
});

test("读者自己滚回底部:恢复跟随、按钮收起", () => {
  const { s, button, follow } = setup();
  follow.pin();
  s.scrollTo(100);
  assert.equal(follow.isFollowing, false);
  s.scrollTo(s.floor - 5);
  assert.equal(follow.isFollowing, true);
  assert.equal(button.hidden, true);
  s.grow(100);
  follow.autoScroll();
  assert.equal(s.el.scrollTop, s.floor);
});

test("拖滚动条期间不重钉,松手后按位置裁决", () => {
  const { s, follow } = setup();
  follow.pin();
  s.el.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
  s.grow(300);
  const held = s.el.scrollTop;
  follow.autoScroll();
  assert.equal(s.el.scrollTop, held, "拖动中不应被 pin 抢走");
  s.scrollTo(held - 150);
  window.dispatchEvent(new window.MouseEvent("pointerup"));
  assert.equal(follow.isFollowing, false);
});

test("尺寸变化(图片异步落地/视口变矮):跟随中钉底;刚点过消息区(展开卡片)不钉、放手", () => {
  let clock = 10_000;
  const { s, button, follow } = setup({ now: () => clock });
  follow.pin();
  s.grow(200);
  fireResize();
  assert.equal(s.el.scrollTop, s.floor);
  // 读者点了消息区里的卡片,卡片展开把内容撑高
  s.list.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
  const before = s.el.scrollTop;
  s.grow(300);
  fireResize();
  assert.equal(s.el.scrollTop, before);
  assert.equal(follow.isFollowing, false);
  assert.equal(button.hidden, false);
  // 过了宽限期、回到底部后,异步增长照常钉底
  clock += INTERACTION_GRACE_MS + 1;
  button.click();
  s.grow(100);
  fireResize();
  assert.equal(s.el.scrollTop, s.floor);
});

test("内容不够一屏:永远算在底部,不出按钮", () => {
  const { s, button, follow } = setup();
  s.geo.contentHeight = 100;
  follow.release();
  assert.equal(button.hidden, true);
  follow.reset();
  assert.equal(follow.isFollowing, true);
  assert.equal(button.hidden, true);
});
