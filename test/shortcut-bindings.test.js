// @vitest-environment jsdom
// 快捷键分派:命令表 → 动作的接线。分两层测:
// 1) createShortcutDispatcher 的按键判定(默认行为、组字、长按、设置页、平台);
// 2) 真实 sidepanel-app 上按命令表生成事件,验证命令真的落到动作上。
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createShortcutDispatcher } from "../src/app/sidepanel/shortcut-bindings.js";
import { COMMANDS, MOD, chordFor, platformOf } from "../src/features/shortcuts/command-table.js";
import { createSidepanelApp } from "../src/app/sidepanel/sidepanel-app.js";

const html = readFileSync(resolve(process.cwd(), "pages/sidepanel/index.html"), "utf8");

function chordOf(id, kind) {
  const command = COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`unknown command ${id}`);
  return chordFor(command, kind);
}

/// 按命令表的和弦构造一个 KeyboardEvent(修饰键映射与 modsOf 一致)。
function makeEvent(id, kind, extra = {}) {
  const chord = chordOf(id, kind);
  const init = { key: chord.key, bubbles: true, cancelable: true, ...extra };
  if (kind === "mac") {
    if (chord.mods & MOD.primary) init.metaKey = true;
    if (chord.mods & MOD.control) init.ctrlKey = true;
  } else if (chord.mods & MOD.primary) init.ctrlKey = true;
  if (chord.mods & MOD.alt) init.altKey = true;
  if (chord.mods & MOD.shift) init.shiftKey = true;
  return new KeyboardEvent("keydown", init);
}

describe("createShortcutDispatcher", () => {
  it("命中命令:调用处理器、preventDefault、返回已消费", () => {
    const handler = vi.fn(() => true);
    const dispatcher = createShortcutDispatcher({ platform: "MacIntel", handlers: { toggleTodoPanel: handler } });
    const event = makeEvent("toggleTodoPanel", "mac");
    expect(dispatcher.handleKeyDown(event)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("处理器返回 false:不消费,也不 preventDefault", () => {
    const dispatcher = createShortcutDispatcher({ platform: "MacIntel", handlers: { toggleTodoPanel: () => false } });
    const event = makeEvent("toggleTodoPanel", "mac");
    expect(dispatcher.handleKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("已被别处 preventDefault 的键不再处理", () => {
    const handler = vi.fn(() => true);
    const dispatcher = createShortcutDispatcher({ platform: "MacIntel", handlers: { toggleTodoPanel: handler } });
    const event = makeEvent("toggleTodoPanel", "mac");
    event.preventDefault();
    expect(dispatcher.handleKeyDown(event)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("输入法组字中不抢键", () => {
    const handler = vi.fn(() => true);
    const dispatcher = createShortcutDispatcher({ platform: "MacIntel", handlers: { toggleTodoPanel: handler } });
    const event = makeEvent("toggleTodoPanel", "mac");
    Object.defineProperty(event, "isComposing", { value: true });
    expect(dispatcher.handleKeyDown(event)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("开关类命令长按只算一次,步进类命令允许连发", () => {
    const toggle = vi.fn(() => true);
    const step = vi.fn(() => true);
    const dispatcher = createShortcutDispatcher({
      platform: "MacIntel", handlers: { toggleTodoPanel: toggle, nextSession: step }
    });
    expect(dispatcher.handleKeyDown(makeEvent("toggleTodoPanel", "mac", { repeat: true }))).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
    expect(dispatcher.handleKeyDown(makeEvent("nextSession", "mac", { repeat: true }))).toBe(true);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("设置页开着时只放行设置类命令", () => {
    const todo = vi.fn(() => true);
    const open = vi.fn(() => true);
    const dispatcher = createShortcutDispatcher({
      platform: "MacIntel", handlers: { toggleTodoPanel: todo, openSettings: open }, isSettingsOpen: () => true
    });
    expect(dispatcher.handleKeyDown(makeEvent("toggleTodoPanel", "mac"))).toBe(false);
    expect(todo).not.toHaveBeenCalled();
    expect(dispatcher.handleKeyDown(makeEvent("openSettings", "mac"))).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("Windows 平台按 Ctrl 档匹配", () => {
    const handler = vi.fn(() => true);
    const dispatcher = createShortcutDispatcher({ platform: "Win32", handlers: { previousSession: handler } });
    expect(dispatcher.handleKeyDown(makeEvent("previousSession", "win"))).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("没有命中任何命令的键不动", () => {
    const dispatcher = createShortcutDispatcher({ platform: "MacIntel", handlers: { toggleTodoPanel: () => true } });
    const event = new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true });
    expect(dispatcher.handleKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

// ---------- 真实 app 接线 ----------

function mountDom() {
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");
}

let previousChrome;
function stubChrome() {
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
}

function stubDeps() {
  let runtimeListener = null;
  let listed = [{ sessionId: "s1", cwd: "/w" }];
  const snapshot = {
    sessionId: "s1", title: "T", cwd: "/w", blank: false, running: false,
    nodes: [], todos: [], goal: null, tokenUsage: null, permissions: null,
    planMode: null, queue: [], jobs: [], pendingApproval: null, pendingQuestion: null
  };
  const deps = {
    DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting", DISCONNECTED: "disconnected" },
    connection: {
      baseUrl: "http://127.0.0.1:3080", streamState: "connected",
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      call: vi.fn().mockResolvedValue({}), restart: vi.fn(),
      respond: vi.fn().mockResolvedValue({ accepted: true })
    },
    onFrame: vi.fn(),
    sessions: {
      store: { toolCall: () => null, getTrajectory: () => [] },
      listStore: { get: () => listed, subagentDescendants: () => ({ count: 0, runningCount: 0 }), subagentChildren: () => new Map(), setSelected: vi.fn() },
      onRuntimeChange: (listener) => { runtimeListener = listener; return () => {}; },
      getRuntimeSnapshot: () => snapshot,
      handleMuxFrame: vi.fn(), handleHostFrame: vi.fn(),
      refreshList: vi.fn().mockResolvedValue([]),
      loadHistory: vi.fn().mockResolvedValue({}),
      loadEarlier: vi.fn().mockResolvedValue({}),
      hasMoreHistory: () => false,
      open: vi.fn().mockResolvedValue("s1"),
      create: vi.fn().mockResolvedValue("s1"),
      prompt: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({}),
      fork: vi.fn().mockResolvedValue("s2"),
      rename: vi.fn().mockResolvedValue({}),
      updateQueue: vi.fn().mockResolvedValue({}),
      search: vi.fn().mockResolvedValue(null),
      archive: vi.fn().mockResolvedValue([]),
      listAgentPresets: vi.fn().mockResolvedValue({ presets: [] }),
      selectAgentPreset: vi.fn().mockResolvedValue("standard"),
      selectModel: vi.fn().mockResolvedValue({}),
      models: vi.fn().mockResolvedValue({ current: {}, reasoningEfforts: [] }),
      listSubagents: vi.fn().mockResolvedValue({ entries: [], parentAvailable: true }),
      loadSubagentHistory: vi.fn().mockResolvedValue({})
    },
    models: { refresh: vi.fn().mockResolvedValue([]) },
    skills: { skills: [], refresh: vi.fn().mockResolvedValue([]) },
    commands: { commands: [], refresh: vi.fn().mockResolvedValue([]), execute: vi.fn().mockResolvedValue({}) },
    workspaces: { refresh: vi.fn().mockResolvedValue([]) },
    references: { files: vi.fn().mockResolvedValue([]), sessions: vi.fn().mockResolvedValue([]) },
    goals: {
      create: vi.fn().mockResolvedValue({}), edit: vi.fn().mockResolvedValue({}),
      pause: vi.fn().mockResolvedValue({}), resume: vi.fn().mockResolvedValue({}),
      clear: vi.fn().mockResolvedValue({})
    },
    attachments: {
      pending: [], visible: [], reading: false, clear: vi.fn(), onChange: vi.fn(),
      add: vi.fn(), remove: vi.fn(), setLimits: vi.fn()
    },
    settings: {},
    formatErrorDetails: (e) => String(e?.message ?? e),
    setLang: vi.fn(), getLang: () => "zh"
  };
  return {
    deps, snapshot, setList: (l) => { listed = l; },
    // 分派里 copyLastResponse 读的是 getRuntimeSnapshot(),所以 emit 要把内容
    // 同步进快照对象,不能只把副本转给监听者。
    emit: (next) => { Object.assign(snapshot, next); runtimeListener?.(snapshot); }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("真实 app 的快捷键接线", () => {
  let app, deps, snapshot, emit, setList, kind;

  beforeAll(async () => {
    stubChrome();
    const proto = window.HTMLElement.prototype;
    if (!proto.hidePopover) {
      proto.hidePopover = function () { this.removeAttribute("data-open"); };
      proto.showPopover = function () { this.setAttribute("data-open", ""); };
      proto.togglePopover = function () { this.toggleAttribute("data-open"); };
    }
    mountDom();
    ({ deps, snapshot, emit, setList } = stubDeps());
    app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    await app.start();
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    kind = platformOf(platform);
  });

  afterAll(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  beforeEach(() => {
    app.state.sessionId = "s1";
    setList([{ sessionId: "s1", cwd: "/w" }]);
  });

  function press(id, extra = {}) {
    const event = makeEvent(id, kind, extra);
    document.dispatchEvent(event);
    return event;
  }

  it("聚焦输入框", () => {
    document.getElementById("hdr-title")?.focus?.();
    press("focusComposer");
    expect(document.activeElement).toBe(document.getElementById("input"));
  });

  it("清空草稿", () => {
    const input = document.getElementById("input");
    input.value = "还没写完";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press("clearDraft");
    expect(input.value).toBe("");
  });

  it("停止生成走 session.cancel", async () => {
    deps.sessions.cancel.mockClear();
    app.state.running = true;
    press("stopGenerating");
    await tick();
    expect(deps.sessions.cancel).toHaveBeenCalledWith("s1");
    app.state.running = false;
  });

  it("待办面板开合", () => {
    emit({ ...snapshot, todos: [{ id: "t1", content: "写测试", status: "pending" }] });
    const head = () => document.querySelector("#todo-panel .todo-head");
    expect(head()).toBeTruthy();
    const before = head().getAttribute("aria-expanded");
    press("toggleTodoPanel");
    expect(head().getAttribute("aria-expanded")).not.toBe(before);
  });

  it("复制最后一条回复", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    emit({ ...snapshot, nodes: [{
      kind: "assistant", turn: 1, step: 1, startSeq: 2, time: Date.now(),
      status: "completed", blocks: [{ type: "text", text: "这是回答" }],
      usage: null, messageId: "m2", interrupted: false
    }] });
    press("copyLastResponse");
    await tick();
    expect(writeText).toHaveBeenCalledWith("这是回答");
  });

  it("切到只读权限走 /permission", async () => {
    deps.commands.execute.mockClear();
    press("permissionReadOnly");
    await tick();
    expect(deps.commands.execute).toHaveBeenCalledWith("s1", "/permission read-only");
  });

  it("压缩上下文走 /compact", async () => {
    deps.commands.execute.mockClear();
    press("compactContext");
    await tick();
    expect(deps.commands.execute).toHaveBeenCalledWith("s1", "/compact");
  });

  it("提高推理档写回 selectModel", async () => {
    deps.sessions.models.mockResolvedValue({
      current: { provider: "p", model: "m" }, reasoningEfforts: ["low", "high"]
    });
    deps.sessions.selectModel.mockClear();
    app.state.currentModel = { provider: "p", model: "m" };
    app.state.currentReasoningEffort = "low";
    press("increaseEffort");
    await tick();
    await tick();
    expect(deps.sessions.selectModel).toHaveBeenCalledWith("s1", "p", "m", "high");
    app.state.currentModel = null;
    app.state.currentReasoningEffort = null;
  });

  it("上一个会话按列表切", async () => {
    deps.sessions.open.mockClear();
    setList([{ sessionId: "s1", cwd: "/w" }, { sessionId: "s2", cwd: "/w" }]);
    press("previousSession");
    await tick();
    expect(deps.sessions.open).toHaveBeenCalledWith("s2");
  });
});
