/**
 * 边缘自动滚动的收尾保证。
 *
 * 拖选到轨道边缘会起一个 30ms 的 setInterval 持续平移时间线。这个定时器必须
 * 在**指针抬起**时停掉 —— 不管抬起发生在哪里。原实现只在 track 自己的
 * pointerup/pointercancel 上收尾,而 pointerleave 在拖拽中直接 return,
 * 所以"从轨道里拖到边缘、把鼠标移到轨道外再松开"会留下一个永远跑着的定时器:
 * 时间线在用户松手之后继续自己漂移,并且每次 tick 都重画视图。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body>
  <section id="trajectory-timeline" class="trajectory-timeline">
    <div class="trajectory-timeline-plot">
      <div class="trajectory-timeline-labels" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="trajectory-timeline-track">
        <button class="trajectory-timeline-earlier" type="button" hidden>…</button>
        <div class="trajectory-timeline-lanes"></div>
        <div class="trajectory-timeline-boundaries" aria-hidden="true"></div>
        <div class="trajectory-timeline-selection" hidden aria-hidden="true"></div>
        <div class="trajectory-timeline-hover-line" hidden aria-hidden="true"></div>
        <div class="trajectory-timeline-tooltip" role="tooltip" hidden></div>
      </div>
    </div>
  </section>
</body></html>`, { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { mountTrajectoryTimeline } = await import("../src/features/trajectory/trajectory-timeline-view.js");

/** 记录集中每条占一个槽位的顺序投影。 */
function turns() {
  return [{
    turn: 1,
    groups: [{
      id: "g", kind: { type: "step", step: 1 }, description: null,
      records: Array.from({ length: 8 }, (_, i) => ({
        id: `r${i}`, kind: "tool", turn: 1, step: 1, requestOnly: false,
        toolName: "bash", text: `call ${i}`
      }))
    }]
  }];
}

/** 真实计时器数:收尾后不该再有 interval 存活。 */
function liveIntervals() {
  return dom.window._countIntervals ? dom.window._countIntervals() : null;
}

afterEach(() => {
  dom.window.document.getElementById("trajectory-timeline").replaceChildren();
});

test("拖到边缘后在轨道外抬起:边缘滚动定时器必须停下", () => {
  // 数一数 setInterval / clearInterval,直接观察"定时器还在不在"。
  let live = new Set();
  const realSet = dom.window.setInterval.bind(dom.window);
  const realClear = dom.window.clearInterval.bind(dom.window);
  dom.window.setInterval = (fn, ms) => { const id = realSet(fn, ms); live.add(id); return id; };
  dom.window.clearInterval = (id) => { live.delete(id); return realClear(id); };
  globalThis.setInterval = dom.window.setInterval;
  globalThis.clearInterval = dom.window.clearInterval;

  const section = document.getElementById("trajectory-timeline");
  const track = section.querySelector(".trajectory-timeline-track");
  // jsdom 没有布局:给轨道一个真实宽度,让边缘判定与 trackFraction 有意义。
  track.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 48, width: 200, height: 48, x: 0, y: 0 });

  const view = mountTrajectoryTimeline({
    section,
    hasMore: () => false,
    onLoadEarlier: () => {},
    onSelect: () => {},
    onFocus: () => {}
  });
  view.render({ turns: turns() });

  // 左键按下(选区拖拽),再移到最右边缘 → 进入边缘滚动。
  track.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
  track.dispatchEvent(new dom.window.PointerEvent("pointermove", { bubbles: true, clientX: 198 }));

  const whileDragging = live.size;
  assert.ok(whileDragging >= 1, `拖到边缘应当起一个滚动定时器,实际 ${whileDragging}`);

  // 关键动作:把鼠标移到轨道外再松手 —— 抬起事件落在别的元素上。
  track.dispatchEvent(new dom.window.PointerEvent("pointerleave", { bubbles: false, clientX: 260 }));
  document.body.dispatchEvent(new dom.window.PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 260 }));

  assert.equal(live.size, 0,
    `指针抬起后不该还有边缘滚动定时器存活(还剩 ${live.size} 个)——时间线会在松手后继续漂移`);
});
