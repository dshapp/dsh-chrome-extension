/**
 * 左侧会话栏拖拽调宽(sidebar-resize.js)。
 *
 * 上下限由 foundation.css 的 clamp() 决定;这里用一个假的 getBoundingClientRect
 * 模拟「CSS 夹完后的实际宽度」,钉住 JS 这一半:首帧同步应用存储值、拖动跟手、
 * 松手按实际宽度落盘、双击 / Home 复位、键盘微调、跨实例同步、脏值忽略。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  mountSidebarResize, parseSidebarWidth, SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_PROP, SIDEBAR_WIDTH_MIN
} from "../src/app/sidepanel/sidebar-resize.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map
  };
}

const DEFAULT_W = 288;
const MAX_W = 400;

function setup({ storage = memoryStorage() } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside id="session-drawer"><div id="session-drawer-resizer" tabindex="0"></div></aside>
  </body></html>`);
  const doc = dom.window.document;
  const drawer = doc.querySelector("#session-drawer");
  const handle = doc.querySelector("#session-drawer-resizer");
  // 模拟 CSS:width = clamp(200px, var(--sidebar-w-pref, 288px), 400px),抽屉贴左边。
  drawer.getBoundingClientRect = () => {
    const pref = parseFloat(doc.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_PROP));
    const width = Math.min(MAX_W, Math.max(SIDEBAR_WIDTH_MIN, Number.isFinite(pref) ? pref : DEFAULT_W));
    return { left: 0, right: width, width, top: 0, bottom: 600, height: 600 };
  };
  const api = mountSidebarResize({ doc, storage });
  const pref = () => doc.documentElement.style.getPropertyValue(SIDEBAR_WIDTH_PROP);
  function pointer(type, clientX, extra = {}) {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, ...extra });
    Object.defineProperty(event, "pointerId", { value: 1 });
    handle.dispatchEvent(event);
    return event;
  }
  function key(name) {
    const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    handle.dispatchEvent(event);
    return event;
  }
  return { dom, doc, drawer, handle, api, storage, pref, pointer, key };
}

test("parseSidebarWidth 只接受下限以上的合理数字", () => {
  assert.equal(parseSidebarWidth("320"), 320);
  assert.equal(parseSidebarWidth("320.6"), 321);
  assert.equal(parseSidebarWidth(null), null);
  assert.equal(parseSidebarWidth(""), null);
  assert.equal(parseSidebarWidth("abc"), null);
  assert.equal(parseSidebarWidth("50"), null);
  assert.equal(parseSidebarWidth("99999"), null);
});

test("挂载时同步应用存储里的宽度;没有或是脏值就用 CSS 默认", () => {
  assert.equal(setup({ storage: memoryStorage({ [SIDEBAR_WIDTH_KEY]: "330" }) }).pref(), "330px");
  assert.equal(setup().pref(), "");
  assert.equal(setup({ storage: memoryStorage({ [SIDEBAR_WIDTH_KEY]: "garbage" }) }).pref(), "");
});

test("拖动跟手,松手按实际渲染宽度存下来", () => {
  const { pointer, pref, storage, doc, handle } = setup();
  // 按在把手正中(右缘 288 处往右 2px),偏移要保持,不能一按就跳。
  pointer("pointerdown", 290);
  assert.ok(doc.body.classList.contains("sidebar-resizing"));
  pointer("pointermove", 290);
  assert.equal(pref(), "288px");
  pointer("pointermove", 352);
  assert.equal(pref(), "350px");
  assert.equal(handle.getAttribute("aria-valuenow"), "350");
  pointer("pointerup", 352);
  assert.ok(!doc.body.classList.contains("sidebar-resizing"));
  assert.equal(storage.map.get(SIDEBAR_WIDTH_KEY), "350");
  // 松手后量一次 CSS 上限给读屏,量完变量原样还原。
  assert.equal(handle.getAttribute("aria-valuemax"), String(MAX_W));
  assert.equal(pref(), "350px");
});

test("拖过上限:变量收敛成 CSS 夹出来的宽度再存,不存指针位置", () => {
  const { pointer, pref, storage } = setup();
  pointer("pointerdown", 288);
  pointer("pointermove", 900);
  pointer("pointerup", 900);
  assert.equal(pref(), `${MAX_W}px`);
  assert.equal(storage.map.get(SIDEBAR_WIDTH_KEY), String(MAX_W));
});

test("拖到下限以下停在下限", () => {
  const { pointer, pref, storage } = setup();
  pointer("pointerdown", 288);
  pointer("pointermove", 20);
  assert.equal(pref(), `${SIDEBAR_WIDTH_MIN}px`);
  pointer("pointerup", 20);
  assert.equal(storage.map.get(SIDEBAR_WIDTH_KEY), String(SIDEBAR_WIDTH_MIN));
});

test("没按下时的 pointermove、右键按下都不改宽度", () => {
  const { pointer, pref, storage } = setup();
  pointer("pointermove", 350);
  pointer("pointerdown", 288, { button: 2 });
  pointer("pointermove", 350);
  assert.equal(pref(), "");
  assert.equal(storage.map.has(SIDEBAR_WIDTH_KEY), false);
});

test("双击 / Home 恢复默认并清掉偏好", () => {
  const { handle, dom, pref, storage, key } = setup({ storage: memoryStorage({ [SIDEBAR_WIDTH_KEY]: "360" }) });
  handle.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(pref(), "");
  assert.equal(storage.map.has(SIDEBAR_WIDTH_KEY), false);
  key("ArrowRight");
  assert.equal(pref(), "304px");
  assert.ok(key("Home").defaultPrevented);
  assert.equal(pref(), "");
});

test("← / → 每次 16px,并且夹在上下限内", () => {
  const { key, pref, storage } = setup();
  assert.ok(key("ArrowRight").defaultPrevented);
  assert.equal(pref(), "304px");
  assert.equal(storage.map.get(SIDEBAR_WIDTH_KEY), "304");
  key("ArrowLeft"); key("ArrowLeft");
  assert.equal(pref(), "272px");
  for (let i = 0; i < 20; i += 1) key("ArrowRight");
  assert.equal(pref(), `${MAX_W}px`);
  // 上下键留给列表的键盘导航,不消费。
  assert.equal(key("ArrowDown").defaultPrevented, false);
});

test("另一个侧栏实例改了宽度:storage 事件同步过来", () => {
  const storage = memoryStorage();
  const { dom, pref } = setup({ storage });
  storage.setItem(SIDEBAR_WIDTH_KEY, "333");
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: SIDEBAR_WIDTH_KEY }));
  assert.equal(pref(), "333px");
  storage.removeItem(SIDEBAR_WIDTH_KEY);
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "unrelated" }));
  assert.equal(pref(), "333px");
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: null }));
  assert.equal(pref(), "");
});

test("存储不可用时只在本页生效,不抛错", () => {
  const broken = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); }
  };
  const { key, pref } = setup({ storage: broken });
  key("ArrowRight");
  assert.equal(pref(), "304px");
});
