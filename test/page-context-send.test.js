// @vitest-environment jsdom
// 「当前网页」在**真实发送路径**上的接线,以及 ＋ 与 @ 共用同一个候选浮层。
//
// 不选时不得改变既有时序(回归:一个多余的 await 会把 prompt 推迟一个微任务,
// 曾经打挂 steer-send / stop-button 这类按微任务计数的用例);
// 选中则插成一枚胶囊,发送时由 projectDraft 展开成 tabId 那一行。
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
    send: document.querySelector("#send")
  };
}

/// 输入一句话。tick 数与 steer-send/stop-button 的用例保持一致 ——
/// 没选「当前网页」时发送必须在同样的微任务预算内走完。
async function type(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}


/// 打开候选浮层(点 ＋),返回当前浮层里的所有行名。
function openMenu() {
  const btn = document.querySelector("#attach-btn");
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return rowNames();
}

const rowNames = () =>
  [...document.querySelectorAll("#trigger-menu .trigger-item-name")].map((n) => n.textContent);

/// 点浮层里名字为 name 的那一行(用 mousedown —— 行本身就监听 mousedown)。
function clickRow(name) {
  const row = [...document.querySelectorAll("#trigger-menu .trigger-item")]
    .find((r) => r.querySelector(".trigger-item-name")?.textContent === name);
  if (!row) throw new Error(`浮层里没有「${name}」这一行,现有:${rowNames().join(" / ")}`);
  row.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  return row;
}

describe("＋ 与 @ 共用同一个浮层", () => {
  it("底栏不再有独立的页面上下文开关", () => {
    setup();
    expect(document.querySelector("#page-context-btn")).toBeNull();
    // 旧的加号专属菜单也一并退休。
    expect(document.querySelector("#attach-menu")).toBeNull();
  });

  it("点 ＋ 打开的就是 #trigger-menu,第一行是「当前网页」", () => {
    setup();
    const names = openMenu();
    expect(document.querySelector("#trigger-menu").hidden).toBe(false);
    expect(names[0]).toBe("当前网页");
    expect(names).toContain("添加图片");
  });

  it("输入 @ 唤起的是同一份浮层,同样带「当前网页」", async () => {
    const { input } = setup();
    await type(input, "@");
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector("#trigger-menu").hidden).toBe(false);
    expect(rowNames()[0]).toBe("当前网页");
  });

  it("再点一次 ＋ 收起浮层", () => {
    setup();
    openMenu();
    document.querySelector("#attach-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(document.querySelector("#trigger-menu").hidden).toBe(true);
  });

  it("点浮层外面收起", () => {
    setup();
    openMenu();
    document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector("#trigger-menu").hidden).toBe(true);
  });

  it("「添加图片」行唤起文件选择器", () => {
    setup();
    const fileInput = document.querySelector("#file-input");
    const clicked = vi.spyOn(fileInput, "click").mockImplementation(() => {});
    openMenu();
    clickRow("添加图片");
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("「当前网页」不出现在 / 的候选里", async () => {
    const { input } = setup();
    await type(input, "/");
    await Promise.resolve(); await Promise.resolve();
    expect(rowNames()).not.toContain("当前网页");
  });
});

describe("发送路径", () => {
  it("没选当前网页:prompt 拿到的就是原文,且时序与没有这个功能时一致", async () => {
    const { deps, input, send } = setup();
    await type(input, "你好");

    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    // 与 steer-send / stop-button 相同的两个 tick 预算:不选就一个 tick 都不该多欠。
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    expect(deps.sessions.prompt.mock.calls[0][1]).toEqual([{ type: "text", text: "你好" }]);
    expect(globalThis.chrome.tabs.query).not.toHaveBeenCalled();
    expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("选了当前网页:输入框出现胶囊,发送时展开成 tabId 前缀", async () => {
    const { deps, input, send } = setup();
    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // 胶囊画在镜像层上,草稿里只留一个占位符。
    expect(document.querySelector("#input-mirror .composer-chip").textContent).toBe("\u00A0当前网页\u00A0");

    input.value = input.value + "这个页面是什么";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));

    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    const [{ text }] = deps.sessions.prompt.mock.calls[0][1];
    // 一行纯文字,没有 XML 包裹。
    expect(text.startsWith("当前页面tabId=42")).toBe(true);
    expect(text).not.toContain("<current_page_context>");
    expect(text.endsWith("这个页面是什么")).toBe(true);
  });

  it("只选一次就只带一次:第二条不再带 tabId", async () => {
    const { deps, input, send } = setup();
    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    input.value = input.value + "第一条";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    await type(input, "第二条");
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(2);
    expect(deps.sessions.prompt.mock.calls[0][1][0].text.startsWith("当前页面tabId=42")).toBe(true);
    // 胶囊随发送一起清空,第二条完全是原文。
    expect(deps.sessions.prompt.mock.calls[1][1][0].text).toBe("第二条");
    // 也不该再去查一次 tabs —— tabId 在选中那一刻就定死了。
    expect(globalThis.chrome.tabs.query).toHaveBeenCalledTimes(1);
  });

  it("再选一次就再带一次", async () => {
    const { deps, input, send } = setup();
    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    input.value = input.value + "第一条";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    input.value = input.value + "第二条";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    const second = deps.sessions.prompt.mock.calls[1][1][0].text;
    expect(second.startsWith("当前页面tabId=42")).toBe(true);
    expect(second.endsWith("第二条")).toBe(true);
  });

  it("删掉胶囊就不带了", async () => {
    const { deps, input, send } = setup();
    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // 用户把胶囊连同它后面的空格一起删掉,重新打字。
    input.value = "改主意了";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(deps.sessions.prompt.mock.calls[0][1]).toEqual([{ type: "text", text: "改主意了" }]);
  });

  it("选了当前网页也不往页面注入脚本 —— 只查一次 tabs", async () => {
    setup();
    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(globalThis.chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });

  it("取不到 tab:不插胶囊,消息照发", async () => {
    const { deps, input, send } = setup();
    globalThis.chrome.tabs.query = vi.fn().mockResolvedValue([]);
    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(document.querySelector("#input-mirror .composer-chip")).toBeNull();

    await type(input, "还是要发出去");
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    expect(deps.sessions.prompt.mock.calls[0][1]).toEqual([{ type: "text", text: "还是要发出去" }]);
  });
});

describe("＋ 打开时的插入位置", () => {
  it("插在光标处,不动已有文本", async () => {
    const { input } = setup();
    input.value = "前面 后面";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    // 把光标放在"前面 "之后。
    input.setSelectionRange(3, 3);

    openMenu();
    clickRow("当前网页");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // 胶囊插在光标处,原文两侧都还在。
    expect(input.value.startsWith("前面")).toBe(true);
    expect(input.value.endsWith("后面")).toBe(true);
    expect(document.querySelector("#input-mirror .composer-chip").textContent).toBe("\u00A0当前网页\u00A0");
  });

  it("＋ 的 mousedown 不抢焦点(preventDefault),textarea 仍可插入", () => {
    setup();
    const btn = document.querySelector("#attach-btn");
    const ev = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
