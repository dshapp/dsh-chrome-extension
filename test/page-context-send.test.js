// @vitest-environment jsdom
// 「携带当前页面上下文」开关在**真实发送路径**上的接线:
// 关态不得改变既有时序(回归:一个多余的 await 会把 prompt 推迟一个微任务,
// 曾经打挂 steer-send / stop-button 这类按微任务计数的用例);
// 开态则必须把 tabId 与页面快照拼在 prompt 最前面。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSidepanelApp } from "../src/app/sidepanel/sidepanel-app.js";
import { PAGE_CONTEXT_STORAGE_KEY } from "../src/features/page-context/page-context.js";

const html = readFileSync(resolve(process.cwd(), "pages/sidepanel/index.html"), "utf8");

function mountDom() {
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");
  return document;
}

function stubDeps() {
  let runtimeListener = null;
  const snapshot = {
    sessionId: "s1", title: "T", cwd: "/w", blank: false, running: false,
    nodes: [], todos: [], goal: null, tokenUsage: null, permissions: null,
    planMode: null, queue: [], jobs: [], pendingApproval: null, pendingQuestion: null,
    subagent: null
  };
  const deps = {
    DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting", DISCONNECTED: "disconnected" },
    connection: {
      baseUrl: "http://127.0.0.1:3080", streamState: "connected",
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      call: vi.fn().mockResolvedValue({}),
      respond: vi.fn().mockResolvedValue({ accepted: true })
    },
    onFrame: vi.fn(),
    sessions: {
      store: { toolCall: () => null },
      listStore: {
        get: () => [{ sessionId: "s1", cwd: "/w" }],
        setDraft: vi.fn(),
        subagentDescendants: () => ({ count: 0, runningCount: 0 }),
        subagentChildren: () => new Map()
      },
      onRuntimeChange: (listener) => { runtimeListener = listener; return () => {}; },
      getRuntimeSnapshot: () => snapshot,
      handleMuxFrame: vi.fn(), handleHostFrame: vi.fn(),
      refreshList: vi.fn().mockResolvedValue([]),
      loadHistory: vi.fn().mockResolvedValue({}),
      open: vi.fn().mockResolvedValue("s1"),
      create: vi.fn().mockResolvedValue("s1"),
      prompt: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({}),
      fork: vi.fn().mockResolvedValue("s2"),
      updateQueue: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue(null),
      archive: vi.fn().mockResolvedValue([]),
      listAgentPresets: vi.fn().mockResolvedValue({ presets: [] }),
      selectAgentPreset: vi.fn().mockResolvedValue("standard")
    },
    models: { refresh: vi.fn().mockResolvedValue([]) },
    skills: { skills: [], refresh: vi.fn().mockResolvedValue([]) },
    commands: { commands: [], refresh: vi.fn().mockResolvedValue([]), execute: vi.fn() },
    workspaces: { refresh: vi.fn().mockResolvedValue([]) },
    references: { files: vi.fn().mockResolvedValue([]), sessions: vi.fn().mockResolvedValue([]) },
    goals: {
      create: vi.fn().mockResolvedValue({}), edit: vi.fn().mockResolvedValue({}),
      pause: vi.fn().mockResolvedValue({}), resume: vi.fn().mockResolvedValue({}),
      clear: vi.fn().mockResolvedValue({})
    },
    attachments: { pending: [], clear: vi.fn(), onChange: vi.fn(), add: vi.fn(), remove: vi.fn(), setLimits: vi.fn() },
    settings: {},
    formatErrorDetails: (e) => String(e?.message ?? e),
    setLang: vi.fn(), getLang: () => "zh"
  };
  return { deps, snapshot, emit: (next) => runtimeListener?.(next) };
}

let previousChrome;
let store;

beforeEach(() => {
  previousChrome = globalThis.chrome;
  store = {};
  globalThis.chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42, url: "https://example.com/a", title: "示例页" }]),
      get: vi.fn().mockResolvedValue({ id: 42, url: "https://example.com/a" }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    // 只有 picker 的 drain 会用到 scripting;page-context 只传 tabId,不注入。
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: { elements: [] } }]) },
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          const out = {};
          for (const key of keys) if (key in store) out[key] = store[key];
          return out;
        }),
        set: vi.fn(async (values) => { Object.assign(store, values); }),
        remove: vi.fn(async (keys) => { for (const key of keys) delete store[key]; })
      }
    }
  };
  document.documentElement.innerHTML = "";
  const proto = window.HTMLElement.prototype;
  if (!proto.hidePopover) {
    proto.hidePopover = function () { this.removeAttribute("data-open"); };
    proto.showPopover = function () { this.setAttribute("data-open", ""); };
    proto.togglePopover = function () { this.toggleAttribute("data-open"); };
  }
});
afterEach(() => {
  if (previousChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = previousChrome;
});

function setup() {
  mountDom();
  const { deps, snapshot, emit } = stubDeps();
  const app = createSidepanelApp(document, deps);
  app.state.sessionId = "s1";
  emit({ ...snapshot, running: false });
  return {
    deps, app,
    input: document.querySelector("#input"),
    send: document.querySelector("#send"),
    button: document.querySelector("#page-context-btn")
  };
}

/// 输入一句话并点发送。tick 数与 steer-send/stop-button 的用例保持一致 ——
/// 关态发送必须在同样的微任务预算内走完。
async function type(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

describe("底栏开关", () => {
  it("按钮就在元素选取按钮的右边", () => {
    setup();
    const picker = document.querySelector("#element-picker-btn");
    expect(picker.nextElementSibling?.id).toBe("page-context-btn");
  });

  it("默认关态,点击后变开态并回写 aria-pressed", async () => {
    const { button } = setup();
    expect(button.classList.contains("state-off")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("false");

    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(button.classList.contains("state-on")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("开态写进 storage,重新挂载侧栏后按钮仍是开态", async () => {
    const { button } = setup();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(store[PAGE_CONTEXT_STORAGE_KEY]).toBe(true);

    const again = setup();
    // load() 是异步读 storage,给它几个 tick 落地。
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(again.button.classList.contains("state-on")).toBe(true);
  });
});

describe("发送路径", () => {
  it("关态:prompt 拿到的就是原文,且时序与没有这个功能时一致", async () => {
    const { deps, input, send } = setup();
    await type(input, "你好");

    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    // 与 steer-send / stop-button 相同的两个 tick 预算:关态一次 tick 都不该多欠。
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    expect(deps.sessions.prompt.mock.calls[0][1]).toEqual([{ type: "text", text: "你好" }]);
    expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("开态:tabId 拼在原文前面", async () => {
    const { deps, input, send, button } = setup();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await type(input, "这个页面是什么");

    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    const [{ text }] = deps.sessions.prompt.mock.calls[0][1];
    // 一行纯文字,没有 XML 包裹。
    expect(text.startsWith("当前页面tabId=42")).toBe(true);
    expect(text).not.toContain("<current_page_context>");
    // 用户原话在最后,由 [指令] 与上下文分开。
    expect(text.endsWith("[指令] 这个页面是什么")).toBe(true);
  });

  it("只有第一条带 tabId,第二条起就是原文", async () => {
    const { deps, input, send, button } = setup();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await type(input, "第一条");
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    await type(input, "第二条");
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(2);
    const first = deps.sessions.prompt.mock.calls[0][1][0].text;
    const second = deps.sessions.prompt.mock.calls[1][1][0].text;
    expect(first.startsWith("当前页面tabId=42")).toBe(true);
    // 第二条完全是原文:开关还开着,但额度已经用掉了。
    expect(second).toBe("第二条");
    expect(second).not.toContain("tabId");
    // 也不该再去查一次 tabs。
    expect(globalThis.chrome.tabs.query).toHaveBeenCalledTimes(1);
  });

  it("关掉再打开,下一条重新带一次", async () => {
    const { deps, input, send, button } = setup();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await type(input, "第一条");
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));   // 关
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));   // 再开
    await type(input, "第二条");
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    const second = deps.sessions.prompt.mock.calls[1][1][0].text;
    expect(second.startsWith("当前页面tabId=42")).toBe(true);
    expect(second.endsWith("[指令] 第二条")).toBe(true);
  });

  it("开态也不往页面注入脚本 —— 只查一次 tabs", async () => {
    const { input, send, button } = setup();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await type(input, "发一条");

    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(globalThis.chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });

  it("开态但取不到 tab:照发不误,只是不带上下文", async () => {
    const { deps, input, send, button } = setup();
    globalThis.chrome.tabs.query = vi.fn().mockResolvedValue([]);
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await type(input, "还是要发出去");

    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    expect(deps.sessions.prompt.mock.calls[0][1]).toEqual([{ type: "text", text: "还是要发出去" }]);
  });

  it("开关本身不算内容:输入框为空时发送键仍然是禁用的", () => {
    const { send, button } = setup();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(send.disabled).toBe(true);
  });
});
