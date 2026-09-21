/**
 * 置顶账本(浏览器本地)的契约。
 *
 * 宿主没有"置顶"这个概念,所以这本账是侧栏自己的:它必须幂等、交集安全,
 * 并且**只动自己**—— 置顶区里拖一下不能把手动顺序那本账改掉。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { createPinnedStore } = await import("../src/features/sessions/pinned-store.js");
const { chromeShim } = await import("../src/platform/storage/chrome-shim.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rows(...ids) {
  return ids.map((sessionId) => ({ sessionId, updatedAt: 1 }));
}

test("置顶是追加,取消是移除,两个方向都幂等", () => {
  const store = createPinnedStore();
  assert.equal(store.setPinned("a", true), true);
  assert.equal(store.setPinned("a", true), false, "重复置顶不该再改账本");
  assert.equal(store.setPinned("b", true), true);
  assert.deepEqual(store.order, ["a", "b"], "先置顶的在前");
  assert.equal(store.isPinned("a"), true);
  assert.equal(store.setPinned("a", false), true);
  assert.equal(store.setPinned("a", false), false);
  assert.deepEqual(store.order, ["b"]);
});

test("pinnedRows 交集安全:账本里有、名册里没有的 id 直接跳过", () => {
  const store = createPinnedStore();
  store.setPinned("gone", true);
  store.setPinned("a", true);
  assert.deepEqual(store.pinnedRows(rows("a", "b")).map((item) => item.sessionId), ["a"]);
  // 账本本身不因为"这次没看见"而被裁掉 —— 它可能只是被搜索过滤掉了。
  assert.deepEqual(store.order, ["gone", "a"]);
});

test("reorder 按 before 锚点插入,null 表示末尾;拖回原位不算改动", () => {
  const store = createPinnedStore();
  for (const id of ["a", "b", "c"]) store.setPinned(id, true);
  assert.equal(store.reorder("c", "a"), true);
  assert.deepEqual(store.order, ["c", "a", "b"]);
  assert.equal(store.reorder("c", null), true);
  assert.deepEqual(store.order, ["a", "b", "c"]);
  assert.equal(store.reorder("c", null), false, "已经在末尾,不该再写一次");
  assert.equal(store.reorder("nobody", "a"), false, "不在账本里的 id 不接受");
});

test("订阅者能收到变更;账本写进 storage 并能读回来", async () => {
  chromeShim.__reset();
  const store = createPinnedStore();
  const seen = [];
  store.subscribe((order) => seen.push([...order]));
  store.setPinned("a", true);
  assert.deepEqual(seen, [["a"]]);
  await flush();
  const restored = createPinnedStore();
  await restored.load();
  assert.deepEqual(restored.order, ["a"]);
  assert.equal(restored.isPinned("a"), true);
});
