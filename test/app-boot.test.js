// @vitest-environment jsdom
// 冒烟:用真实 index.html 挂载真实 app,确保重写后的模块图能加载、元素齐备、
// 且交互卡能真正接管输入框。单元测试各自 mock 依赖,唯独这里检查"接线"本身。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSidepanelApp } from "../src/app/sidepanel/sidepanel-app.js";
import { collectElements } from "../src/app/sidepanel/sidepanel-elements.js";

// jsdom 环境下 import.meta.url 不是 file: URL,所以从 vitest 的 cwd(包根)解析。
const html = readFileSync(resolve(process.cwd(), "pages/sidepanel/index.html"), "utf8");

function mountDom() {
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");
  return document;
}

function stubDeps(overrides = {}) {
  let runtimeListener = null;
  const snapshot = {
    sessionId: "s1", title: "T", cwd: "/w", blank: false, running: false,
    nodes: [], todos: [], goal: null, tokenUsage: null, permissions: null,
    planMode: null, queue: [], jobs: [], pendingApproval: null, pendingQuestion: null
  };
  return {
    snapshot,
    emit: (next) => runtimeListener?.(next),
    deps: {
      DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting", DISCONNECTED: "disconnected" },
      connection: {
        baseUrl: "http://127.0.0.1:3080",
        streamState: "connected",
        ensureStarted: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue({}),
        respond: vi.fn().mockResolvedValue({ accepted: true })
      },
      onFrame: vi.fn(),
      sessions: {
        store: { toolCall: () => null },
        listStore: {
          get: () => [{ sessionId: "s1", cwd: "/w" }],
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
        selectAgentPreset: vi.fn().mockResolvedValue("standard"),
        listSubagents: vi.fn().mockResolvedValue({ entries: [], parentAvailable: true }),
        loadSubagentHistory: vi.fn().mockResolvedValue({})
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
      setLang: vi.fn(), getLang: () => "zh",
      ...overrides
    }
  };
}

// jsdom 尚未实现 Popover API;真实 Chrome 有(已在浏览器里验证过页面能正常加载)。
// 这里补上最小垫片,让菜单点击路径可测。
// element-picker 会读 chrome.tabs / chrome.scripting;jsdom 里没有,补最小桩。
// 用 afterEach 还原:vitest 同一 environment 下多个测试文件共享 globalThis,
// 留一个假 chrome 会污染其他文件(composer-menus 就因此挂过)。
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

afterEach(() => {
  if (previousChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = previousChrome;
});

beforeEach(() => {
  stubChrome();
  document.documentElement.innerHTML = "";
  const proto = window.HTMLElement.prototype;
  if (!proto.hidePopover) {
    proto.hidePopover = function () { this.removeAttribute("data-open"); };
    proto.showPopover = function () { this.setAttribute("data-open", ""); };
    proto.togglePopover = function () { this.toggleAttribute("data-open"); };
  }
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
  }
});

describe("应用接线冒烟", () => {
  it("index.html 提供 collectElements 需要的全部元素", () => {
    mountDom();
    expect(() => collectElements(document)).not.toThrow();
    const els = collectElements(document);
    // 本次重写新增的座位必须真的存在于 HTML 里,否则运行时才会炸。
    for (const key of ["composerTakeover", "planChip", "triggerMenu", "permConfirm", "composer"]) {
      expect(els[key], key).toBeTruthy();
    }
  });

  it("createSidepanelApp 能构造(模块图完整)", () => {
    mountDom();
    const { deps } = stubDeps();
    expect(() => createSidepanelApp(document, deps)).not.toThrow();
  });

  it("审批挂起时交互卡接管、输入框让位", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, pendingApproval: { rpcId: "a", sessionId: "s1", approvalId: "ap", toolName: "bash" } });
    expect(document.querySelector("#composer-takeover").hidden).toBe(false);
    expect(document.querySelector("#composer-takeover .approval-card")).toBeTruthy();
    expect(document.querySelector("#composer").hidden).toBe(true);
  });

  it("计划审阅路由到 plan 卡而非通用问答卡", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, pendingQuestion: {
      rpcId: "p", sessionId: "s1",
      questions: [{
        id: "q1", question: "执行?", detail: "# 计划", multiSelect: false,
        intent: { kind: "plan-review", approve: "Approve" },
        options: [{ label: "Approve" }, { label: "Keep planning" }]
      }]
    }});
    expect(document.querySelector("#composer-takeover .plan-card")).toBeTruthy();
    expect(document.querySelector("#composer-takeover .question-card")).toBeNull();
  });

  it("普通提问走向导卡", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, pendingQuestion: {
      rpcId: "q", sessionId: "s1",
      questions: [{ id: "q1", question: "选?", options: [{ label: "A" }] }]
    }});
    expect(document.querySelector("#composer-takeover .question-card")).toBeTruthy();
  });

  it("交互结束后输入框归位", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, pendingApproval: { rpcId: "a", sessionId: "s1", approvalId: "ap", toolName: "bash" } });
    emit({ ...snapshot, pendingApproval: null });
    expect(document.querySelector("#composer-takeover").hidden).toBe(true);
    expect(document.querySelector("#composer").hidden).toBe(false);
  });

  it("plan 投影开启时显示 plan 药丸并改占位符", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, planMode: true });
    expect(document.querySelector("#plan-chip").hidden).toBe(false);
    expect(document.querySelector("#input").placeholder).toContain("计划");
    emit({ ...snapshot, planMode: false });
    expect(document.querySelector("#plan-chip").hidden).toBe(true);
  });

  it("plan 药丸点击走 commands/execute 而非 prompt", async () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, planMode: true });
    document.querySelector("#plan-chip").click();
    await Promise.resolve();
    // 斜杠命令走 prompt 是无效的(真实后端验证过),必须走命令通道。
    expect(deps.commands.execute).toHaveBeenCalledWith("s1", "/plan off");
    expect(deps.sessions.prompt).not.toHaveBeenCalled();
  });

  it("权限切换走 commands/execute", async () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, permissions: {
      currentValue: "read-only",
      options: [{ value: "read-only", name: "read-only" }, { value: "workspace-write", name: "workspace-write" }]
    }});
    const items = [...document.querySelectorAll("#perm-menu [data-item-id]")];
    const target = items.find((i) => i.dataset.itemId === "workspace-write");
    expect(target, "权限菜单未渲染出选项").toBeTruthy();
    target.click();
    await Promise.resolve();
    expect(deps.commands.execute).toHaveBeenCalledWith("s1", "/permission workspace-write");
  });

  it("danger-full-access 需要二次确认后才执行", async () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, permissions: {
      currentValue: "read-only",
      options: [{ value: "danger-full-access", name: "danger-full-access" }]
    }});
    const target = [...document.querySelectorAll("#perm-menu [data-item-id]")]
      .find((i) => i.dataset.itemId === "danger-full-access");
    expect(target, "权限菜单未渲染出选项").toBeTruthy();
    target.click();
    await Promise.resolve();
    // 确认框未确认前不得执行
    expect(deps.commands.execute).not.toHaveBeenCalled();
    expect(document.querySelector("#perm-confirm").open).toBe(true);
  });

  it("目标条按投影渲染并可操作", async () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, goal: { id: "g1", revision: 1, objective: "把活干完", phase: "active" } });
    expect(document.querySelector("#goal-bar-slot").hidden).toBe(false);
    expect(document.querySelector(".goal-objective").textContent).toBe("把活干完");
    [...document.querySelectorAll(".goal-btn")].find((b) => b.title.includes("暂停") || b.title.includes("Pause")).click();
    await Promise.resolve();
    expect(deps.goals.pause).toHaveBeenCalled();
  });

  it("待办面板按投影渲染", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, todos: [{ content: "甲", status: "in_progress" }, { content: "乙", status: "pending" }] });
    expect(document.querySelector("#todo-panel").hidden).toBe(false);
    expect(document.querySelector(".todo-current").textContent).toBe("甲");
  });

  it("上下文吃紧时给出压缩入口并走 /compact", async () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, contextPressure: { projectedTokens: 960, contextWindow: 1000 } });
    const compact = document.querySelector(".context-compact");
    expect(compact).toBeTruthy();
    compact.click();
    await Promise.resolve();
    expect(deps.commands.execute).toHaveBeenCalledWith("s1", "/compact");
  });

  it("imageLimits 投影下发给附件盘", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    const imageLimits = { maxImageBytes: 123, mediaTypes: ["image/png"] };
    emit({ ...snapshot, imageLimits });
    expect(deps.attachments.setLimits).toHaveBeenCalledWith(imageLimits);
  });

  it("子代理会话禁用输入并说明原因", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, subagent: { readOnly: true } });
    const input = document.querySelector("#input");
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toContain("子代理");
  });

  it("选取元素后发送:XML 拼在最前、原话跟在 [指令] 后", async () => {
    mountDom();
    const { deps } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    app.state.streamState = "connected";
    // 模拟已选取一个元素(经 runtime 消息通道进入)
    const onMessage = globalThis.chrome.runtime.onMessage.addListener.mock.calls.at(-1)?.[0];
    expect(onMessage, "picker 未注册消息监听").toBeTruthy();
    onMessage({ type: "ELEMENT_PICKED", element: {
      tag: "button", ref: "ref_1", selector: "#go", xpath: '//*[@id="go"]',
      name: "提交", attrs: { id: "go" }, rect: { x: 1, y: 2, width: 3, height: 4 },
      url: "https://example.com", title: "示例"
    }});
    document.querySelector("#input").value = "把这个按钮改成蓝色";
    await app.sendMessage();
    expect(deps.sessions.prompt).toHaveBeenCalled();
    const [, content] = deps.sessions.prompt.mock.calls[0];
    const text = content.find((c) => c.type === "text").text;
    expect(text.startsWith("<selected_page_elements ")).toBe(true);
    // XPath 里的引号在 XML 里被转义成 &quot; —— 这正是不破坏 XML 结构的关键
    // (定位符现在是属性,属性位的引号转义更关键:漏转义会直接截断标签)。
    expect(text).toContain('xpath="//*[@id=&quot;go&quot;]"');
    expect(text).toContain("[指令] 把这个按钮改成蓝色");
    // 发出后元素被消费,不会带到下一轮
    expect(document.querySelector("#picked-elements-chip").hidden).toBe(true);
  });

  it("只选元素不打字也能发送(元素本身就是指代)", async () => {
    mountDom();
    const { deps } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    const onMessage = globalThis.chrome.runtime.onMessage.addListener.mock.calls.at(-1)?.[0];
    onMessage({ type: "ELEMENT_PICKED", element: { tag: "a", ref: "r1", selector: "#x", xpath: "/html/body/a" } });
    await app.sendMessage();
    const [, content] = deps.sessions.prompt.mock.calls[0];
    const text = content.find((c) => c.type === "text").text;
    expect(text).toContain("<selected_page_elements ");
    expect(text).toContain("[指令]");
  });

  it("已选元素条显示数量并可清空", () => {
    mountDom();
    const { deps } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    const onMessage = globalThis.chrome.runtime.onMessage.addListener.mock.calls.at(-1)?.[0];
    onMessage({ type: "ELEMENT_PICKED", element: { tag: "a", ref: "r1", name: "链接" } });
    const chip = document.querySelector("#picked-elements-chip");
    expect(chip.hidden).toBe(false);
    expect(document.querySelector("#picked-elements-label").textContent).toContain("1");
    expect(document.querySelector(".picked-element-text").textContent).toBe("链接");
    document.querySelector("#picked-elements-clear").click();
    expect(chip.hidden).toBe(true);
  });

  it("节点渲染进消息列表", () => {
    mountDom();
    const { deps, snapshot, emit } = stubDeps();
    const app = createSidepanelApp(document, deps);
    app.state.sessionId = "s1";
    emit({ ...snapshot, nodes: [{
      kind: "user", seq: 1, time: Date.now(), messageId: "m1",
      content: [{ type: "text", text: "你好" }]
    }]});
    expect(document.querySelector("#msg-list .msg-user").textContent).toContain("你好");
    expect(document.querySelector("#empty-hint").hidden).toBe(true);
  });
});
