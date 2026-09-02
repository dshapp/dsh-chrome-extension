import { describe, it, expect, beforeEach } from "vitest";
import { createSessionOrderStore } from "../src/features/sessions/session-order-store.js";
import { chromeShim } from "../src/platform/storage/chrome-shim.js";

const row = (id, updatedAt) => ({ sessionId: id, updatedAt });

describe("手动顺序账本", () => {
  beforeEach(() => chromeShim.__reset());

  it("账本为空时按最近更新倒序(首次使用的样子)", async () => {
    const store = createSessionOrderStore();
    await store.load();
    const out = store.sort([row("a", 1), row("b", 3), row("c", 2)]);
    expect(out.map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("拖过之后按手动顺序,不再按时间", async () => {
    const store = createSessionOrderStore();
    await store.load();
    store.reorder("a", "b", ["a", "b", "c"]);      // a 已在 b 前,无变化
    store.reorder("c", "a", ["a", "b", "c"]);      // c 插到 a 前
    const out = store.sort([row("a", 1), row("b", 3), row("c", 2)]);
    expect(out.map((s) => s.sessionId)).toEqual(["c", "a", "b"]);
  });

  it("beforeId 为 null 表示移到末尾", async () => {
    const store = createSessionOrderStore();
    await store.load();
    store.reorder("a", null, ["a", "b", "c"]);
    const out = store.sort([row("a", 9), row("b", 1), row("c", 2)]);
    expect(out.map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("没被拖过的会话按时间排在已排定的之后", async () => {
    const store = createSessionOrderStore();
    await store.load();
    store.reorder("c", "a", ["a", "b", "c"]);
    // d/e 从没进过账本
    const out = store.sort([row("a", 1), row("c", 2), row("d", 5), row("e", 9)]);
    expect(out.map((s) => s.sessionId)).toEqual(["c", "a", "e", "d"]);
  });

  it("交集安全:账本里不在当前子集的 id 被静默跳过", async () => {
    const store = createSessionOrderStore();
    await store.load();
    store.reorder("c", "a", ["a", "b", "c"]);
    const out = store.sort([row("a", 1), row("c", 2)]);   // b 不在子集里
    expect(out.map((s) => s.sessionId)).toEqual(["c", "a"]);
  });

  it("在一个子集里重排,不打乱子集外会话之间的相对顺序", async () => {
    const store = createSessionOrderStore();
    await store.load();
    // 先建立一份四人顺序 a b c d
    store.reorder("a", "b", ["a", "b", "c", "d"]);
    const baseline = store.order.filter((id) => id === "b" || id === "d");
    // 只在 {a, c} 这个子集里重排
    store.reorder("c", "a", ["a", "c"]);
    // b 与 d 的相对先后不受影响
    expect(store.order.filter((id) => id === "b" || id === "d")).toEqual(baseline);
    expect(store.order).toContain("c");
  });

  it("顺序持久化到 storage,新实例能读回", async () => {
    const first = createSessionOrderStore();
    await first.load();
    first.reorder("c", "a", ["a", "b", "c"]);
    // reorder 内部的写入是异步旁路,等一个微任务队列。
    await new Promise((r) => setTimeout(r, 0));

    const second = createSessionOrderStore();
    await second.load();
    const out = second.sort([row("a", 1), row("b", 3), row("c", 2)]);
    expect(out.map((s) => s.sessionId)).toEqual(["c", "a", "b"]);
  });

  it("拖到自己身上不改变任何东西", async () => {
    const store = createSessionOrderStore();
    await store.load();
    store.reorder("a", "b", ["a", "b", "c"]);
    const before = [...store.order];
    store.reorder("a", "a", ["a", "b", "c"]);
    expect(store.order).toEqual(before);
  });

  it("被拖的会话不在子集里 → 忽略", async () => {
    const store = createSessionOrderStore();
    await store.load();
    store.reorder("zz", "a", ["a", "b"]);
    expect(store.order).toEqual([]);
  });

  it("storage 里是坏数据时退化为空账本,不抛", async () => {
    await chromeShim.storage.local.set({ dsh_flat_session_order: "not-an-array" });
    const store = createSessionOrderStore();
    await expect(store.load()).resolves.toBeDefined();
    expect(store.order).toEqual([]);
  });
});
