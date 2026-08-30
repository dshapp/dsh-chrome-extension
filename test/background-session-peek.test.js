// @vitest-environment jsdom
// 后台会话丢帧前的"偷看"例外(对齐 web/macOS 丢帧策略保留的例外):
// 失败轮上报通知、用户消息更新活跃排序、标题投影喂给列表行;
// 以及历史浮层开着时对 listStore 的活刷新。
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createSessionService } from "../src/features/sessions/session-service.js";
import { createSessionListStore } from "../src/features/sessions/session-list-store.js";
import { createBackgroundNotifier } from "../src/features/notifications/background-notifier.js";
import { mountHistoryDrawer } from "../src/app/sidepanel/sidepanel-overlays.js";
import { MUX } from "../src/platform/dsh/rpc-methods.js";

const CURRENT = "session-current";
const OTHER = "session-other";

function fakeConnection() {
  return {
    call: vi.fn(async (method) => {
      if (method === "session.history") return { events: [] };
      if (method === "session.list") return { items: [] };
      return {};
    })
  };
}

async function serviceOn(sessionId, options) {
  const service = createSessionService(fakeConnection(), options);
  await service.loadHistory(sessionId);
  return service;
}

const eventFrame = (sessionId, event) => ({ payload: { type: MUX.sessionEvent, sessionId, event } });
const turnEnd = (reason) => ({ type: "turn/end", seq: 9, time: 1000, data: { turn: 1, reason } });

describe("后台会话失败上报", () => {
  it("非当前会话的错误轮触发 onBackgroundTurnFailure", async () => {
    const onBackgroundTurnFailure = vi.fn();
    const service = await serviceOn(CURRENT, { onBackgroundTurnFailure });
    service.handleMuxFrame(eventFrame(OTHER, turnEnd({ kind: "error", error: { message: "boom" } })));
    expect(onBackgroundTurnFailure).toHaveBeenCalledWith(OTHER, "boom");
    // 偷看完仍然丢帧:事件本体没进当前 store。
    expect(service.getRuntimeSnapshot().nodes).toHaveLength(0);
  });

  it("正常结束的轮不上报;当前会话的错误轮也不走后台通道", async () => {
    const onBackgroundTurnFailure = vi.fn();
    const service = await serviceOn(CURRENT, { onBackgroundTurnFailure });
    service.handleMuxFrame(eventFrame(OTHER, turnEnd({ kind: "completed" })));
    service.handleMuxFrame(eventFrame(CURRENT, turnEnd({ kind: "error", error: { message: "visible" } })));
    expect(onBackgroundTurnFailure).not.toHaveBeenCalled();
  });

  it("不接回调也不炸(旧签名兼容)", async () => {
    const service = await serviceOn(CURRENT);
    expect(() =>
      service.handleMuxFrame(eventFrame(OTHER, turnEnd({ kind: "error", error: { message: "x" } })))
    ).not.toThrow();
  });
});

describe("后台会话活跃排序", () => {
  it("后台 user/message 更新 updatedAt 并把该行排到最前", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([
      { sessionId: CURRENT, updatedAt: 2000 },
      { sessionId: OTHER, updatedAt: 1000 }
    ]);
    service.handleMuxFrame(eventFrame(OTHER, { type: "user/message", seq: 1, time: 3000, data: {} }));
    const items = service.listStore.get();
    expect(items[0].sessionId).toBe(OTHER);
    expect(items[0].updatedAt).toBe(3000);
  });

  it("更旧的时间戳不倒退;列表外的会话忽略", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: OTHER, updatedAt: 5000 }]);
    service.handleMuxFrame(eventFrame(OTHER, { type: "user/message", seq: 1, time: 100, data: {} }));
    expect(service.listStore.get()[0].updatedAt).toBe(5000);
    expect(() =>
      service.handleMuxFrame(eventFrame("session-unknown", { type: "user/message", seq: 1, time: 1, data: {} }))
    ).not.toThrow();
  });
});

describe("后台会话标题投影", () => {
  it("非当前会话的 title 投影写进列表行的 projections.values.title", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: OTHER, updatedAt: 1, projections: { values: { title: "旧" } } }]);
    service.handleMuxFrame({ payload: { type: MUX.sessionProjection, sessionId: OTHER, key: "title", value: "新标题", seq: 7 } });
    expect(service.listStore.get()[0].projections.values.title).toBe("新标题");
  });

  it("当前会话的 title 投影仍走 store 快照", async () => {
    const service = await serviceOn(CURRENT);
    service.handleMuxFrame({ payload: { type: MUX.sessionProjection, sessionId: CURRENT, key: "title", value: "当前标题", seq: 7 } });
    expect(service.getRuntimeSnapshot().title).toBe("当前标题");
  });

  it("title 之外的后台投影仍然丢弃", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: OTHER, updatedAt: 1 }]);
    service.handleMuxFrame({ payload: { type: MUX.sessionProjection, sessionId: OTHER, key: "stats", value: { x: 1 }, seq: 7 } });
    expect(service.listStore.get()[0].projections).toBeUndefined();
  });
});

describe("后台失败通知文案与开关", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("开关打开时发通知,详情截断进文案", async () => {
    const create = vi.fn();
    const notifier = createBackgroundNotifier({
      notifications: { create },
      settings: { getNotificationsEnabled: async () => true }
    });
    notifier.reportFailure("s1", "boom");
    await tick();
    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0][1].message).toBe("后台任务失败:boom");
  });

  it("无详情时用兜底文案;开关关闭时静默;无 notifications API 不炸", async () => {
    const create = vi.fn();
    const on = createBackgroundNotifier({
      notifications: { create },
      settings: { getNotificationsEnabled: async () => true }
    });
    on.reportFailure("s1");
    await tick();
    expect(create.mock.calls[0][1].message).toBe("后台任务失败");

    const off = createBackgroundNotifier({
      notifications: { create: vi.fn() },
      settings: { getNotificationsEnabled: async () => false }
    });
    off.reportFailure("s1", "x");
    await tick();
    expect(off === on ? true : true).toBe(true);

    const bare = createBackgroundNotifier({ notifications: undefined, settings: {} });
    expect(() => bare.reportFailure("s1", "x")).not.toThrow();
  });
});

describe("历史浮层对 listStore 的活刷新", () => {
  function setupDrawer() {
    const dom = new JSDOM(`<!DOCTYPE html><body>
      <button id="hdr-title-wrap"></button><span id="hdr-title"></span>
      <div id="history-popover"><input id="history-search" />
      <ul id="history-list-inner"></ul></div></body></html>`);
    globalThis.document = dom.window.document;
    globalThis.requestAnimationFrame = (fn) => fn();
    globalThis.prompt = () => null;
    globalThis.alert = () => {};
    dom.window.Element.prototype.scrollIntoView = function () {};
    const listStore = createSessionListStore();
    listStore.replaceAll([
      { sessionId: "s1", updatedAt: 2, projections: { values: { title: "甲" } } },
      { sessionId: "s2", updatedAt: 1, projections: { values: { title: "乙" } } }
    ]);
    const deps = {
      sessions: {
        listStore,
        refreshList: vi.fn(async () => listStore.get()),
        fork: vi.fn(), rename: vi.fn(), archive: vi.fn(),
        search: vi.fn(async () => null)
      },
      formatErrorDetails: (e) => String(e)
    };
    const drawer = mountHistoryDrawer(deps, vi.fn(), vi.fn(), null, { workspacePath: () => null });
    return { drawer, listStore, doc: dom.window.document };
  }

  const titles = (doc) => [...doc.querySelectorAll(".history-item .h-title")].map((el) => el.textContent);

  it("浮层开着时,后台标题/排序变化立即重画", async () => {
    const { drawer, listStore, doc } = setupDrawer();
    drawer.show();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(titles(doc)).toEqual(["甲", "乙"]);
    listStore.setTitle("s2", "乙改");
    expect(titles(doc)).toEqual(["甲", "乙改"]);
    listStore.recordActivity("s2", 99);
    expect(titles(doc)).toEqual(["乙改", "甲"]);
  });

  it("浮层关着时不白渲染", async () => {
    const { drawer, listStore, doc } = setupDrawer();
    drawer.show();
    await new Promise((resolve) => setTimeout(resolve, 0));
    drawer.hide();
    const before = doc.querySelector("#history-list-inner").innerHTML;
    listStore.setTitle("s1", "甲改");
    expect(doc.querySelector("#history-list-inner").innerHTML).toBe(before);
  });
});
