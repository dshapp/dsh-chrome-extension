/**
 * 左侧栏三档的意图状态(sidebar-state.js)。
 *
 * 档位本身由 foundation.css 的 @media 决定;这里钉住的是 JS 这一半:
 * sidebarShown 的真值表必须与 CSS 选择器一一对应,偏好同步读写、跨实例同步。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  sidebarShown, readSidebarTier, createSidebarState, SidebarTier, SIDEBAR_COLLAPSED_KEY
} from "../src/app/sidepanel/sidebar-state.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map
  };
}

/// 假的文档:用 tier 变量代替 CSS @media 写在 :root 上的 --sidebar-tier。
function setup({ tier = SidebarTier.overlay, storage = memoryStorage() } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const doc = dom.window.document;
  const box = { tier };
  dom.window.getComputedStyle = () => ({ getPropertyValue: (name) => (name === "--sidebar-tier" ? ` ${box.tier}` : "") });
  const state = createSidebarState({ doc, storage });
  return { dom, doc, box, state, storage };
}

test("sidebarShown 与 CSS 三档选择器一致", () => {
  const { overlay, rail, expanded } = SidebarTier;
  // 窄档:只看浮层 .open
  assert.equal(sidebarShown({ tier: overlay }), false);
  assert.equal(sidebarShown({ tier: overlay, expanded: true }), false);
  assert.equal(sidebarShown({ tier: overlay, overlayOpen: true }), true);
  // 中档:默认图标栏,展开或浮层 .open 才可见
  assert.equal(sidebarShown({ tier: rail }), false);
  assert.equal(sidebarShown({ tier: rail, collapsed: true }), false);
  assert.equal(sidebarShown({ tier: rail, expanded: true }), true);
  assert.equal(sidebarShown({ tier: rail, overlayOpen: true }), true);
  // 宽档:默认展开,收起后才是图标栏
  assert.equal(sidebarShown({ tier: expanded }), true);
  assert.equal(sidebarShown({ tier: expanded, collapsed: true }), false);
  assert.equal(sidebarShown({ tier: expanded, collapsed: true, expanded: true }), true);
  assert.equal(sidebarShown({ tier: expanded, collapsed: true, overlayOpen: true }), true);
});

test("readSidebarTier 读不到变量时按窄档处理", () => {
  assert.equal(readSidebarTier(null), SidebarTier.overlay);
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  assert.equal(readSidebarTier(dom.window.document), SidebarTier.overlay);
  dom.window.getComputedStyle = () => ({ getPropertyValue: () => " nonsense" });
  assert.equal(readSidebarTier(dom.window.document), SidebarTier.overlay);
  dom.window.getComputedStyle = () => ({ getPropertyValue: () => " expanded" });
  assert.equal(readSidebarTier(dom.window.document), SidebarTier.expanded);
});

test("收起偏好同步读出、首帧就上 class", () => {
  const { doc, state } = setup({ tier: SidebarTier.expanded, storage: memoryStorage({ [SIDEBAR_COLLAPSED_KEY]: "1" }) });
  assert.equal(doc.body.classList.contains("sidebar-collapsed"), true);
  assert.equal(state.isShown(), false);
});

test("宽档收起会持久化,展开清掉;中档收起不记", () => {
  const { doc, box, state, storage } = setup({ tier: SidebarTier.expanded });
  assert.equal(state.isShown(), true);
  state.collapse();
  assert.equal(state.isShown(), false);
  assert.equal(storage.getItem(SIDEBAR_COLLAPSED_KEY), "1");
  state.expand();
  assert.equal(state.isShown(), true);
  assert.equal(storage.getItem(SIDEBAR_COLLAPSED_KEY), null);
  // 宽档展开不打 sidebar-expanded:拖窄到中档仍按默认回到图标栏
  assert.equal(doc.body.classList.contains("sidebar-expanded"), false);
  box.tier = SidebarTier.rail;
  assert.equal(state.isShown(), false);
  // 中档展开是本实例的临时意图
  state.expand();
  assert.equal(doc.body.classList.contains("sidebar-expanded"), true);
  assert.equal(state.isShown(), true);
  state.collapse();
  assert.equal(state.isShown(), false);
  assert.equal(storage.getItem(SIDEBAR_COLLAPSED_KEY), null);
  // 拖窄到窄档:中档的展开意图不变成浮层
  state.expand();
  box.tier = SidebarTier.overlay;
  assert.equal(state.pushed(), false);
  assert.equal(state.isShown(), false);
});

test("另一个侧栏实例改了偏好:storage 事件同步 class", () => {
  const { dom, doc, storage } = setup({ tier: SidebarTier.expanded });
  storage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: SIDEBAR_COLLAPSED_KEY }));
  assert.equal(doc.body.classList.contains("sidebar-collapsed"), true);
  storage.removeItem(SIDEBAR_COLLAPSED_KEY);
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "other" }));
  assert.equal(doc.body.classList.contains("sidebar-collapsed"), true);
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: null }));
  assert.equal(doc.body.classList.contains("sidebar-collapsed"), false);
});

test("storage 写不了时只在本页生效,不抛错", () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  const { state } = setup({ tier: SidebarTier.expanded, storage: broken });
  state.collapse();
  assert.equal(state.isShown(), false);
  state.expand();
  assert.equal(state.isShown(), true);
});
