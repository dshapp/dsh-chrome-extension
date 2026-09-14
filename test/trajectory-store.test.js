import { describe, it, expect, beforeAll } from "vitest";
import { createSessionStore } from "../src/features/sessions/session-store.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));

function userEvent(seq, text, id = `m${seq}`) {
  return {
    type: "user/message",
    seq,
    time: 1000 + seq,
    data: { id, content: [{ type: "text", text }], source: { kind: "user" } }
  };
}

function fresh() {
  const store = createSessionStore();
  store.reset("s1");
  return store;
}

describe("store 轨迹快照", () => {
  it("按窗口装配并可重复取用(未变脏时同引用)", () => {
    const store = fresh();
    store.applyEvent(userEvent(1, "第一问"));
    store.applyEvent(userEvent(2, "第二问"));
    const first = store.getTrajectory();
    expect(first.records).toHaveLength(2);
    expect(store.getTrajectory()).toBe(first);
  });

  it("窗口变化后重新装配", () => {
    const store = fresh();
    store.applyEvent(userEvent(1, "第一问"));
    const first = store.getTrajectory();
    store.applyEvent(userEvent(2, "第二问"));
    const second = store.getTrajectory();
    expect(second).not.toBe(first);
    expect(second.records).toHaveLength(2);
  });

  it("reset 后轨迹清空", () => {
    const store = fresh();
    store.applyEvent(userEvent(1, "第一问"));
    store.reset("s2");
    expect(store.getTrajectory().records).toHaveLength(0);
  });
});

describe("store 前向补页", () => {
  it("把更早的事件归并到窗口最前并重放", () => {
    const store = fresh();
    store.applyEvent(userEvent(5, "第五问"));
    store.applyEvent(userEvent(6, "第六问"));
    const ok = store.prependEntries([
      { event: userEvent(3, "第三问"), view: {} },
      { event: userEvent(4, "第四问"), view: {} }
    ]);
    expect(ok).toBe(true);
    const trajectory = store.getTrajectory();
    expect(trajectory.records.map((record) => record.previewMarkdown)).toEqual(["第三问", "第四问", "第五问", "第六问"]);
    // 节点模型也要跟着重建。
    expect(store.getSnapshot().nodes.map((node) => node.content[0].text))
      .toEqual(["第三问", "第四问", "第五问", "第六问"]);
  });

  it("重复或更晚的 seq 不重复入窗", () => {
    const store = fresh();
    store.applyEvent(userEvent(5, "第五问"));
    expect(store.prependEntries([{ event: userEvent(5, "dup"), view: {} }])).toBe(false);
    expect(store.prependEntries([{ event: userEvent(7, "later"), view: {} }])).toBe(false);
    expect(store.prependEntries([])).toBe(false);
    expect(store.getTrajectory().records).toHaveLength(1);
  });
});
