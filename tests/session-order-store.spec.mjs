/**
 * 手动顺序账本(单列表 manual 档)的排序契约。
 *
 * 回归:第一次拖动会把当时整个可见子集写进账本(常常上千条)。账本之外的新会话
 * 曾被追加在末尾,落在单列表 FLAT_ROW_LIMIT 渲染上限之外 —— 在扩展里新建、正在跑
 * 的会话在左侧列表里看不见,而 Mac / DSH Web 里看得见。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { createSessionOrderStore } = await import("../src/features/sessions/session-order-store.js");

const row = (sessionId, updatedAt) => ({ sessionId, updatedAt });

test("账本为空时按时间倒序", () => {
  const store = createSessionOrderStore();
  const ids = store.sort([row("a", 1), row("b", 3), row("c", 2)]).map((item) => item.sessionId);
  assert.deepEqual(ids, ["b", "c", "a"]);
});

test("拖过之后新建的会话排在账本行之前(按时间倒序),不沉到列表末尾", () => {
  const store = createSessionOrderStore();
  // 一次拖动:把 c 拖到 a 前面,整个可见子集写进账本。
  store.reorder("c", "a", ["a", "b", "c"]);
  assert.deepEqual(store.order, ["c", "a", "b"]);
  const ids = store.sort([
    row("a", 1), row("b", 2), row("c", 3),
    row("new-1", 10), row("new-2", 20)
  ]).map((item) => item.sessionId);
  assert.deepEqual(ids, ["new-2", "new-1", "c", "a", "b"]);
});

test("把顶部的新会话拖进账本后,它拿到自己的手动位置", () => {
  const store = createSessionOrderStore();
  store.reorder("b", "a", ["a", "b"]);                 // 账本 [b, a]
  const visible = store.sort([row("a", 1), row("b", 2), row("n", 9)]).map((item) => item.sessionId);
  assert.deepEqual(visible, ["n", "b", "a"]);
  store.reorder("n", null, visible);                    // 把新会话拖到末尾
  assert.deepEqual(store.order, ["b", "a", "n"]);
  const ids = store.sort([row("a", 1), row("b", 2), row("n", 9), row("m", 5)]).map((item) => item.sessionId);
  assert.deepEqual(ids, ["m", "b", "a", "n"]);
});
