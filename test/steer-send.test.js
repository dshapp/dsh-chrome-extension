// @vitest-environment jsdom
// 插队发送(⌥⌘↩)的接线:发出去的必须是输入框里这一条,且带 mode:"steer";
// 队列不能被动到 —— 用户反馈的 bug 就是"队列条目被立刻发出、输入框还留着"。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSidepanelApp } from "../src/app/sidepanel/sidepanel-app.js";

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

// app 用 navigator.platform 判 mac,而 jsdom 报空串(→ 非 mac,插队键变成
// Alt+Ctrl+Enter)。这里钉成 mac,让用例测的正是用户要的 ⌥⌘↩。
let previousChrome;
beforeEach(() => {
  Object.defineProperty(window.navigator, "platform", {
    value: "MacIntel", configurable: true
  });
  previousChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://example.com" }]),
      get: vi.fn().mockResolvedValue({ id: 1, url: "https://example.com" }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: { elements: [] } }]) }
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

/// 造一个 keydown。mac 上插队是 Option+Command+Enter。
function enter({ alt = false, meta = false, shift = false } = {}) {
  return new window.KeyboardEvent("keydown", {
    key: "Enter", altKey: alt, metaKey: meta, shiftKey: shift,
    bubbles: true, cancelable: true
  });
}

function setup({ running }) {
  mountDom();
  const { deps, snapshot, emit } = stubDeps();
  const app = createSidepanelApp(document, deps);
  app.state.sessionId = "s1";
  emit({ ...snapshot, running });
  return { deps, app, input: document.querySelector("#input") };
}

describe("插队发送", () => {
  it("agent 运行中按 ⌥⌘↩ 用 mode:steer 发出输入框那条", async () => {
    const { deps, input } = setup({ running: true });
    input.value = "插队这条";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    input.dispatchEvent(enter({ alt: true, meta: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    const [sessionId, content, options] = deps.sessions.prompt.mock.calls[0];
    expect(sessionId).toBe("s1");
    // 发的是输入框里这一条,不是队列里的任何东西。
    expect(content).toEqual([{ type: "text", text: "插队这条" }]);
    expect(options).toEqual({ mode: "steer" });
    // 队列一个字都没动。
    expect(deps.sessions.updateQueue).not.toHaveBeenCalled();
    // 输入框被清空 —— 这条已经发走了,不该还留着。
    expect(input.value).toBe("");
  });

  it("运行中普通 Enter 仍然入队,不插队", async () => {
    const { deps, input } = setup({ running: true });
    input.value = "排队这条";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    input.dispatchEvent(enter());
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sessions.prompt.mock.calls[0][2]).toEqual({ mode: "queue" });
  });

  it("空闲时 ⌥⌘↩ 就是普通发送(没有当前轮可插)", async () => {
    const { deps, input } = setup({ running: false });
    input.value = "空闲这条";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    input.dispatchEvent(enter({ alt: true, meta: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sessions.prompt.mock.calls[0][2]).toEqual({ mode: "queue" });
  });

  it("运行中 ⌥⌘↩ 不触发停止", async () => {
    const { deps, input } = setup({ running: true });
    input.value = "别停";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    input.dispatchEvent(enter({ alt: true, meta: true }));
    await Promise.resolve();
    await Promise.resolve();

    // 运行中发送键是"停止"态,但插队手势的语义不是中断。
    expect(deps.sessions.cancel).not.toHaveBeenCalled();
    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
  });

  it("非 mac 上插队键是 Alt+Ctrl+Enter", async () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "Win32", configurable: true
    });
    const { deps, input } = setup({ running: true });
    input.value = "windows 插队";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    input.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter", altKey: true, ctrlKey: true, bubbles: true, cancelable: true
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sessions.prompt.mock.calls[0][2]).toEqual({ mode: "steer" });
  });

  it("Shift+Enter 不发送(仍是换行)", async () => {
    const { deps, input } = setup({ running: true });
    input.value = "换行";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    input.dispatchEvent(enter({ shift: true }));
    await Promise.resolve();

    expect(deps.sessions.prompt).not.toHaveBeenCalled();
  });
});
