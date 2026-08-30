// @vitest-environment jsdom
// 侧栏关闭 → 页面选取模式必须收尾。
// 这条路径不能靠 pagehide 里的 executeScript:侧栏 document 立即销毁,异步调用不保证送达。
// 真正的机制是一条长连接 —— port 断开时由 Service Worker 替侧栏拆掉页面覆盖层。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElementPicker, PICKER_PRESENCE_PORT } from "../src/features/element-picker/element-picker.js";

function fakePort() {
  const messages = [];
  const disconnectListeners = [];
  const messageListeners = [];
  return {
    messages,
    port: {
      name: PICKER_PRESENCE_PORT,
      postMessage: vi.fn((m) => messages.push(m)),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) }
    },
    emitMessage: (m) => messageListeners.forEach((fn) => fn(m)),
    emitDisconnect: () => disconnectListeners.forEach((fn) => fn())
  };
}

function fakeChrome({ connectThrows = false } = {}) {
  const executed = [];
  const harness = fakePort();
  return {
    executed, harness,
    api: {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 7, url: "https://example.com" }]),
        get: vi.fn().mockResolvedValue({ id: 9, url: "https://other.com" }),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      runtime: {
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        connect: vi.fn(() => {
          if (connectThrows) throw new Error("SW asleep");
          return harness.port;
        })
      },
      scripting: {
        executeScript: vi.fn().mockImplementation(({ func }) => {
          executed.push(func.name);
          if (func.name === "elementPickerDrainScript") return Promise.resolve([{ result: { elements: [] } }]);
          return Promise.resolve([{ result: { ok: true } }]);
        })
      }
    }
  };
}

const make = (opts) => {
  const { api, executed, harness } = fakeChrome(opts);
  const picker = createElementPicker({
    chromeApi: api, showToast: vi.fn(), onChange: vi.fn(), t: (k) => k
  });
  return { picker, api, executed, harness };
};

describe("存活哨兵:侧栏关闭时收尾", () => {
  it("attach 时连上 presence port", () => {
    const { picker, api } = make();
    picker.attach();
    expect(api.runtime.connect).toHaveBeenCalledWith({ name: PICKER_PRESENCE_PORT });
    expect(picker.presenceConnected).toBe(true);
  });

  it("开启选取后把目标标签页同步给 SW", async () => {
    const { picker, harness } = make();
    picker.attach();
    await picker.setActive(true);
    const last = harness.messages.at(-1);
    expect(last).toEqual({ type: "ELEMENT_PICKER_ACTIVE", tabId: 7 });
  });

  it("正常关闭选取时发 INACTIVE,SW 便不再重复收尾", async () => {
    const { picker, harness } = make();
    picker.attach();
    await picker.setActive(true);
    await picker.setActive(false);
    expect(harness.messages.at(-1)).toEqual({ type: "ELEMENT_PICKER_INACTIVE" });
  });

  it("跟随标签页切换后哨兵指向新页(否则 SW 会去清理早已收尾的旧页)", async () => {
    const { picker, harness } = make();
    picker.attach();
    await picker.setActive(true);
    await picker.followTab(9);
    expect(harness.messages.at(-1)).toEqual({ type: "ELEMENT_PICKER_ACTIVE", tabId: 9 });
  });

  it("SW 未就绪导致 connect 抛错时不影响选取本身", async () => {
    const { picker } = make({ connectThrows: true });
    expect(() => picker.attach()).not.toThrow();
    expect(picker.presenceConnected).toBe(false);
    await picker.setActive(true);
    expect(picker.active).toBe(true);
  });

  it("pagehide 停轮询并抢收一次剩余选取", async () => {
    const { picker, executed } = make();
    picker.attach();
    await picker.setActive(true);
    executed.length = 0;
    window.dispatchEvent(new window.Event("pagehide"));
    await Promise.resolve();
    // 最后一次点击可能还在页面队列里,随侧栏一起丢掉就白点了。
    expect(executed).toContain("elementPickerDrainScript");
  });

  it("未开启选取时 pagehide 不做多余动作", async () => {
    const { picker, executed } = make();
    picker.attach();
    executed.length = 0;
    window.dispatchEvent(new window.Event("pagehide"));
    await Promise.resolve();
    expect(executed).toHaveLength(0);
  });

  it("detach 断开 port 并移除 pagehide 监听", async () => {
    const { picker, harness, executed } = make();
    const detach = picker.attach();
    await picker.setActive(true);
    detach();
    expect(harness.port.disconnect).toHaveBeenCalled();
    executed.length = 0;
    window.dispatchEvent(new window.Event("pagehide"));
    await Promise.resolve();
    expect(executed).toHaveLength(0);
  });
});

describe("Service Worker 侧:port 断开即拆覆盖层", () => {
  let originalChrome;
  let executed;

  beforeEach(() => {
    originalChrome = globalThis.chrome;
    executed = [];
    globalThis.chrome = {
      runtime: { onConnect: { addListener: vi.fn() } },
      scripting: {
        executeScript: vi.fn(({ target, func }) => {
          executed.push({ tabId: target.tabId, func: func.name });
          return Promise.resolve([{ result: { stopped: true } }]);
        })
      }
    };
  });
  afterEach(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    vi.resetModules();
  });

  it("开启态下断开 → 对该标签页执行 stop 脚本", async () => {
    const { bindPickerPresence } = await import("../sw/picker-presence.js");
    const harness = fakePort();
    bindPickerPresence(harness.port);
    harness.emitMessage({ type: "ELEMENT_PICKER_ACTIVE", tabId: 42 });
    harness.emitDisconnect();
    await Promise.resolve();
    expect(executed).toEqual([{ tabId: 42, func: "elementPickerStopScript" }]);
  });

  it("已收到 INACTIVE 后断开 → 不重复收尾", async () => {
    const { bindPickerPresence } = await import("../sw/picker-presence.js");
    const harness = fakePort();
    bindPickerPresence(harness.port);
    harness.emitMessage({ type: "ELEMENT_PICKER_ACTIVE", tabId: 42 });
    harness.emitMessage({ type: "ELEMENT_PICKER_INACTIVE" });
    harness.emitDisconnect();
    await Promise.resolve();
    expect(executed).toHaveLength(0);
  });

  it("从未开启过就断开 → 什么都不做", async () => {
    const { bindPickerPresence } = await import("../sw/picker-presence.js");
    const harness = fakePort();
    bindPickerPresence(harness.port);
    harness.emitDisconnect();
    await Promise.resolve();
    expect(executed).toHaveLength(0);
  });

  it("跟页后断开 → 收尾的是最新那一页", async () => {
    const { bindPickerPresence } = await import("../sw/picker-presence.js");
    const harness = fakePort();
    bindPickerPresence(harness.port);
    harness.emitMessage({ type: "ELEMENT_PICKER_ACTIVE", tabId: 1 });
    harness.emitMessage({ type: "ELEMENT_PICKER_ACTIVE", tabId: 2 });
    harness.emitDisconnect();
    await Promise.resolve();
    expect(executed).toEqual([{ tabId: 2, func: "elementPickerStopScript" }]);
  });

  it("非法 tabId 被忽略,不去 executeScript", async () => {
    const { bindPickerPresence } = await import("../sw/picker-presence.js");
    const harness = fakePort();
    bindPickerPresence(harness.port);
    harness.emitMessage({ type: "ELEMENT_PICKER_ACTIVE", tabId: "not-a-number" });
    harness.emitDisconnect();
    await Promise.resolve();
    expect(executed).toHaveLength(0);
  });

  it("页面已关闭导致 stop 失败时不抛出", async () => {
    const { stopPickerOnTab } = await import("../sw/picker-presence.js");
    globalThis.chrome.scripting.executeScript = vi.fn().mockRejectedValue(new Error("No tab with id"));
    await expect(stopPickerOnTab(5)).resolves.toBe(false);
  });

  it("只认自己的 port 名", async () => {
    await import("../sw/picker-presence.js");
    const register = globalThis.chrome.runtime.onConnect.addListener.mock.calls[0][0];
    const other = fakePort();
    other.port.name = "task-notification-presence";
    register(other.port);
    other.emitMessage({ type: "ELEMENT_PICKER_ACTIVE", tabId: 3 });
    other.emitDisconnect();
    await Promise.resolve();
    expect(executed).toHaveLength(0);
  });
});
