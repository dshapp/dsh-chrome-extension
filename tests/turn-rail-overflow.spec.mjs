/**
 * 会话 turn 轨道在轮次很多时的可达性:刻度固定间距、外框锁在消息区内部滚动,
 * active 轮出视窗时自动滚回、两端显示被藏起的轮数、键盘可在刻度间移动。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><div id="turn-rail" hidden></div></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { setLang } = await import("../src/shared/i18n.js");
setLang("zh");
const { mountTurnRail, railScrollTarget, hiddenTurnCounts, sameTurnRailItems, TURN_PITCH_PX } = await import("../src/features/chat/turn-rail-view.js");

const items = (n) => Array.from({ length: n }, (_, i) => ({ turn: i + 1, prompt: `p${i + 1}`, response: "", anchorRow: `row-${i + 1}`, seq: i }));

test("railScrollTarget:视窗内不动,视窗外把刻度滚到中间并夹在范围内", () => {
  const view = 120; // 10 格
  // 内容不溢出:永远不滚
  assert.equal(railScrollTarget({ index: 5, count: 8, viewHeight: view, scrollTop: 0 }), null);
  // 在视窗中段:不动
  assert.equal(railScrollTarget({ index: 5, count: 100, viewHeight: view, scrollTop: 0 }), null);
  // 最后一轮在视窗外:滚到底(被 max 夹住)
  assert.equal(railScrollTarget({ index: 99, count: 100, viewHeight: view, scrollTop: 0 }), 100 * TURN_PITCH_PX - view);
  // 中间某轮:居中
  const center = 50 * TURN_PITCH_PX + TURN_PITCH_PX / 2;
  assert.equal(railScrollTarget({ index: 50, count: 100, viewHeight: view, scrollTop: 0 }), Math.round(center - view / 2));
  // 贴着渐隐带的也算看不清,要滚
  assert.notEqual(railScrollTarget({ index: 0, count: 100, viewHeight: view, scrollTop: 6 }), null);
  // always:即便在视窗内也居中
  assert.equal(railScrollTarget({ index: 0, count: 100, viewHeight: view, scrollTop: 0, reveal: "always" }), null);
});

test("hiddenTurnCounts:上下被藏起的轮数", () => {
  assert.deepEqual(hiddenTurnCounts({ count: 5, viewHeight: 120, scrollTop: 0 }), { above: 0, below: 0 });
  assert.deepEqual(hiddenTurnCounts({ count: 100, viewHeight: 120, scrollTop: 0 }), { above: 0, below: 90 });
  assert.deepEqual(hiddenTurnCounts({ count: 100, viewHeight: 120, scrollTop: 1080 }), { above: 90, below: 0 });
  assert.deepEqual(hiddenTurnCounts({ count: 100, viewHeight: 120, scrollTop: 600 }), { above: 50, below: 40 });
});

test("挂载:active 变化只改装饰不重建刻度,Tab 只落在 active 上,方向键在刻度间走", () => {
  const container = document.getElementById("turn-rail");
  const navigated = [];
  const rail = mountTurnRail(container, { band: document.getElementById("messages"), onNavigate: (item) => navigated.push(item.turn) });
  const list = items(40);
  rail.set(list, 40, null);
  assert.equal(container.hidden, false);
  const ticks = [...container.querySelectorAll(".turn-tick")];
  assert.equal(ticks.length, 40);
  assert.ok(ticks[39].classList.contains("active"));
  assert.deepEqual(ticks.filter((t) => t.tabIndex === 0).map((t) => t.dataset.turn), ["40"]);

  rail.set(list, 12, null);
  const after = [...container.querySelectorAll(".turn-tick")];
  assert.equal(after[11], ticks[11], "同一份 items 不重建 DOM");
  assert.ok(after[11].classList.contains("active"));
  assert.equal(after[11].getAttribute("aria-current"), "true");
  assert.equal(after[39].getAttribute("aria-current"), null);

  after[11].focus();
  after[11].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  assert.equal(document.activeElement, after[10]);
  document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(document.activeElement, after[39]);
  document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  assert.equal(document.activeElement, after[0]);
  // 焦点出预览卡,带 第 N / 总 轮 位置
  const preview = container.querySelector(".turn-rail-preview");
  assert.ok(preview);
  assert.match(preview.querySelector(".turn-rail-preview-meta").textContent, /第 1 \/ 40 轮/);
  document.activeElement.click();
  assert.deepEqual(navigated, [1]);

  rail.reset();
  assert.equal(container.hidden, true);
  assert.equal(container.querySelectorAll(".turn-tick").length, 0);
  // reset 后外框结构(翻页钮 + scroller)仍在,可再次 set
  rail.set(items(3), 1, null);
  assert.equal(container.querySelectorAll(".turn-tick").length, 3);
  assert.equal(container.querySelectorAll(".turn-rail-edge").length, 2);
});

test("sameTurnRailItems:按 turn/锚点/seq/预览比内容,不看数组身份", () => {
  assert.equal(sameTurnRailItems(items(3), items(3)), true);
  assert.equal(sameTurnRailItems(items(3), items(4)), false);
  const changed = items(3);
  changed[2] = { ...changed[2], response: "streaming…" };
  assert.equal(sameTurnRailItems(items(3), changed), false);
  const unloaded = items(3);
  unloaded[0] = { ...unloaded[0], anchorRow: null };
  assert.equal(sameTurnRailItems(items(3), unloaded), false);
});

test("运行中每帧一份新 items:刻度 DOM 复用、不重播 active 过渡(轮次指示器不再闪)", async () => {
  document.body.innerHTML = '<div id="messages"></div><div id="turn-rail2" hidden></div>';
  const container = document.getElementById("turn-rail2");
  const navigated = [];
  const rail = mountTurnRail(container, { band: document.getElementById("messages"), onNavigate: (item) => navigated.push(item) });
  rail.set(items(2), 2, null);
  const before = [...container.querySelectorAll(".turn-tick")];
  assert.equal(before.length, 2);

  // 流式帧:内容不变、数组是新的 —— 刻度区零 DOM 变动
  const records = [];
  const observer = new window.MutationObserver((list) => records.push(...list));
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
  for (let i = 0; i < 5; i += 1) rail.set(items(2), 2, null);
  await Promise.resolve();
  assert.deepEqual(records.map((r) => `${r.type}:${r.attributeName ?? ""}`), [], "相同内容的新数组不应改动刻度");

  // 流式帧:回复预览在长 —— 刻度节点仍是原来那批,active 类一直挂着不被摘掉
  const growing = items(2);
  growing[1] = { ...growing[1], response: "部分回复" };
  rail.set(growing, 2, null);
  await Promise.resolve();
  const after = [...container.querySelectorAll(".turn-tick")];
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.ok(after[1].classList.contains("active"));
  assert.equal(records.filter((r) => r.type === "childList").length, 0, "不增删刻度节点");
  assert.equal(records.filter((r) => r.attributeName === "class" && r.target === after[1]).length, 0, "active 刻度的 class 不被反复摘挂");

  // 新的一轮开始:只追加一枚刻度,旧刻度保留;点击拿到的是最新条目
  const three = items(3);
  three[0] = { ...three[0], prompt: "最新预览" };
  rail.set(three, 3, null);
  const grown = [...container.querySelectorAll(".turn-tick")];
  assert.equal(grown.length, 3);
  assert.equal(grown[0], before[0]);
  assert.equal(grown[1], before[1]);
  assert.ok(grown[2].classList.contains("active"));
  assert.ok(!grown[1].classList.contains("active"));
  grown[0].click();
  assert.equal(navigated.at(-1).prompt, "最新预览");

  // 窗口外的轮出现在前面(分页/投影):按序插入,不打乱已有节点
  const withEarlier = [{ turn: 0, prompt: "p0", response: "", anchorRow: null, seq: 0 }, ...three];
  rail.set(withEarlier, 3, null);
  const ordered = [...container.querySelectorAll(".turn-tick")];
  assert.deepEqual(ordered.map((t) => t.dataset.turn), ["0", "1", "2", "3"]);
  assert.equal(ordered[1], before[0]);
  assert.ok(ordered[0].classList.contains("unloaded"));

  // 轮消失:对应刻度移除
  rail.set(three.slice(1), 3, null);
  assert.deepEqual([...container.querySelectorAll(".turn-tick")].map((t) => t.dataset.turn), ["2", "3"]);
  observer.disconnect();
});
