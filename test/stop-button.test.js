// @vitest-environment jsdom
// 三个用户反馈的 bug 的回归位:
// 1. 输入框为空、agent 正跑时,右下角"停止"按钮点不动 —— sendMessage 在
//    "没有内容就 return" 那一步就退出了,永远走不到下面的停止分支。
// 2. 设置页配好新提供方回到对话框,底栏模型菜单还是旧的。
// 3. 提供方编辑器里"获取可用模型"没把 api(协议)带给宿主。
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

let previousChrome;
beforeEach(() => {
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

function setup({ running }) {
  mountDom();
  const { deps, snapshot, emit } = stubDeps();
  const app = createSidepanelApp(document, deps);
  app.state.sessionId = "s1";
  emit({ ...snapshot, running });
  return { deps, app, input: document.querySelector("#input"), send: document.querySelector("#send") };
}

describe("停止按钮", () => {
  it("输入框为空、agent 正跑时,发送键呈停止态且可点", () => {
    const { send } = setup({ running: true });
    expect(send.className).toBe("state-stop");
    // 停止态一定不能是 disabled,否则点击事件根本不会派发。
    expect(send.disabled).toBe(false);
  });

  it("点停止按钮真的会调 session.cancel", async () => {
    const { deps, send } = setup({ running: true });
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    // 这是这个 bug 的核心:以前输入框为空会在判空那一步就 return,
    // cancel 一次也不会被调到。
    expect(deps.sessions.cancel).toHaveBeenCalledTimes(1);
    expect(deps.sessions.cancel).toHaveBeenCalledWith("s1");
    // 停止不是发消息。
    expect(deps.sessions.prompt).not.toHaveBeenCalled();
  });

  it("停止走的是取消,不会把空消息发出去", async () => {
    const { deps, send } = setup({ running: true });
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.sessions.prompt).not.toHaveBeenCalled();
  });

  it("停止态默认就是红底白字,红色不靠 hover 才出现", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/sidepanel/styles/composer.css"), "utf8");
    const base = css.match(/#send\.state-stop \{[^}]*\}/)?.[0] ?? "";
    const hover = css.match(/#send\.state-stop:hover \{[^}]*\}/)?.[0] ?? "";
    expect(base).toContain("background: var(--danger)");
    expect(base).toContain("color: #fff");
    // hover 只压暗,不能再由它引入危险色 —— 那正是"只有悬停才红"的旧写法。
    expect(hover).not.toContain("var(--danger)");
  });

  it("有内容时按钮是排队态,点击发消息而不是停止", async () => {
    const { deps, input, send } = setup({ running: true });
    input.value = "排队这条";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(send.className).toBe("state-queue");

    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sessions.cancel).not.toHaveBeenCalled();
    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
  });

  it("空闲且输入框为空时发送键不可点,也不会误发取消", async () => {
    const { deps, send } = setup({ running: false });
    expect(send.className).toBe("state-idle");
    expect(send.disabled).toBe(true);
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(deps.sessions.cancel).not.toHaveBeenCalled();
  });
});
