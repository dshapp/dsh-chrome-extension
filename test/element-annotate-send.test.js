// @vitest-environment jsdom
// 「圈选即批注」在**真实发送路径**上的接线:页面批注弹窗点「提交」后,
// 侧栏要把整轮元素连同批注发出去 —— 包括 agent 正跑、发送键显示为「停止」的时候。
// 以及侧栏药丸(输入框顶部那颗)要把批注摘要显示出来,让用户能回看与纠错。
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

function setup({ running = false } = {}) {
  mountDom();
  const { deps, snapshot, emit } = stubDeps();
  const app = createSidepanelApp(document, deps);
  app.state.sessionId = "s1";
  emit({ ...snapshot, running });
  return {
    deps, app, snapshot, emit,
    input: document.querySelector("#input"),
    send: document.querySelector("#send")
  };
}

/// 模拟页面把元素(可带批注)交给侧栏:走的就是生产路径 —— drain 注入体的返回值。
/// flags 里的 submit/cancel 对应批注弹窗的「提交」与右上角关闭。
function pageReturns(elements, flags = {}) {
  globalThis.chrome.scripting.executeScript = vi.fn().mockImplementation(({ func }) => {
    if (func?.name === "elementPickerDrainScript") {
      return Promise.resolve([{ result: { elements, submit: false, cancel: false, ...flags } }]);
    }
    return Promise.resolve([{ result: { ok: true } }]);
  });
}

/// 开启圈选模式(点底栏那颗按钮),然后让轮询跑一次 drain。
async function pickAndDrain(elements, flags = {}) {
  pageReturns(elements, flags);
  document.querySelector("#element-picker-btn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  // setActive(true) 里有若干 await(query tab / 两次注入),让它们跑完。
  for (let i = 0; i < 12; i++) await Promise.resolve();
  // 轮询是 400ms 一次,测试里不等定时器,直接触发一次同样的 drain。
  vi.advanceTimersByTime(400);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const promptText = (deps) => {
  const [, content] = deps.sessions.prompt.mock.calls.at(-1);
  return content.find((part) => part.type === "text")?.text ?? "";
};

describe("页面批注弹窗点「提交」→ 侧栏发送", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("提交后把元素连同批注序列化进 <note> 发出去", async () => {
    const { deps } = setup();
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "提交订单", selector: "#buy", url: "https://x.test", note: "点了没反应" }], { submit: true });
    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    const text = promptText(deps);
    expect(text).toContain("<selected_page_elements");
    expect(text).toContain("<note>点了没反应</note>");
  });

  it("元素都带批注时不再补那句 picker.instruction(批注本身就是指令)", async () => {
    const { deps } = setup();
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买", note: "改成蓝色" }], { submit: true });
    expect(promptText(deps)).not.toContain("[指令]");
  });

  it("一条批注都没写时仍补兜底指令,否则模型不知道要它干嘛", async () => {
    const { deps } = setup();
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买" }], { submit: true });
    expect(promptText(deps)).toContain("[指令]");
  });

  it("输入框里另有文字时,那句话优先当指令", async () => {
    const { deps, input } = setup();
    input.value = "把它们都对齐";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买", note: "改成蓝色" }], { submit: true });
    expect(promptText(deps)).toContain("[指令] 把它们都对齐");
  });

  // agent 正跑时提交:必须走 prompt(按投递模式排队/插队),绝不能被
  // 「停止」分支吃掉。停止态的前提是 picked 为空(见 updateSendState),而提交
  // 路径必然带着元素,所以按钮那时是 state-queue —— 这条用例把该不变式钉住:
  // 哪天有人让 picked 不再计入 hasInput,提交就会静默变成「停止本轮」。
  it("agent 正跑时提交走排队发送,而不是被当成「停止本轮」", async () => {
    const { deps, send } = setup({ running: true });
    // 快照渲染被 requestAnimationFrame 节流(高帧率流式下不每帧重建 DOM),
    // 假定时器下必须显式推一帧,否则 running 还没落到按钮上。
    await new Promise((resolve) => { requestAnimationFrame(resolve); vi.advanceTimersByTime(32); });
    expect(send.className).toBe("state-stop");

    let classAtSubmit = null;
    const realPrompt = deps.sessions.prompt;
    deps.sessions.prompt = vi.fn((...args) => { classAtSubmit = send.className; return realPrompt(...args); });
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买", note: "改文案" }], { submit: true });

    expect(deps.sessions.cancel).not.toHaveBeenCalled();
    expect(deps.sessions.prompt).toHaveBeenCalledTimes(1);
    // 元素一进集合,按钮就从「停止」翻成「排队」—— 提交因此永远走不到停止分支。
    expect(classAtSubmit).toBe("state-queue");
    expect(deps.sessions.prompt.mock.calls[0][2]).toEqual({ mode: "queue" });
  });

  it("右上角关闭只退出圈选,不发送", async () => {
    const { deps } = setup();
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买" }], { cancel: true });
    expect(deps.sessions.prompt).not.toHaveBeenCalled();
    expect(document.querySelector("#element-picker-btn").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("侧栏药丸:批注的回看与纠错入口", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("收到元素后药丸现身并报出计数", async () => {
    setup();
    expect(document.querySelector("#picked-elements-chip").hidden).toBe(true);
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买", note: "改文案" }]);
    expect(document.querySelector("#picked-elements-chip").hidden).toBe(false);
    expect(document.querySelector("#picked-elements-label").textContent).toContain("1");
  });

  it("每行把批注摘要显示出来 —— 只显示元素名的话用户无从核对写了什么", async () => {
    setup();
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "提交订单", note: "点了没反应" }]);
    const row = document.querySelector("#picked-elements-menu .picked-element-row");
    expect(row.querySelector(".picked-element-name").textContent).toBe("提交订单");
    expect(row.querySelector(".picked-element-note").textContent).toBe("点了没反应");
  });

  it("没写批注的行不留空的摘要节点", async () => {
    setup();
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买" }]);
    const row = document.querySelector("#picked-elements-menu .picked-element-row");
    expect(row.querySelector(".picked-element-note")).toBeNull();
  });

  it("行内 × 能把选错的那条删掉,计数跟着减", async () => {
    setup();
    await pickAndDrain([
      { ref: "ref_1", tag: "button", name: "买", note: "a" },
      { ref: "ref_2", tag: "a", name: "链接", note: "b" }
    ]);
    expect(document.querySelectorAll("#picked-elements-menu .picked-element-row")).toHaveLength(2);
    document.querySelector("#picked-elements-menu .picked-element-remove")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const rows = document.querySelectorAll("#picked-elements-menu .picked-element-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".picked-element-name").textContent).toBe("链接");
  });

  // 发送失败时元素与批注必须留在药丸里 —— 页面侧已经自我收尾,
  // 没有药丸这一轮批注就全丢了,用户得从头再选一遍。
  it("发送失败后药丸仍在,批注不丢", async () => {
    const { deps } = setup();
    deps.sessions.prompt.mockRejectedValueOnce(new Error("network down"));
    await pickAndDrain([{ ref: "ref_1", tag: "button", name: "买", note: "改文案" }], { submit: true });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(document.querySelector("#picked-elements-chip").hidden).toBe(false);
    expect(document.querySelector(".picked-element-note").textContent).toBe("改文案");
  });
});