// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSidepanelApp } from "../src/app/sidepanel/sidepanel-app.js";
import { createSessionService, locationOf } from "../src/features/sessions/session-service.js";

const html = readFileSync(resolve(process.cwd(), "pages/sidepanel/index.html"), "utf8");
let prevChrome;
beforeEach(() => {
  prevChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: "https://x.com" }]), get: vi.fn(),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() } },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, connect: vi.fn(() => ({
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } })) },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: {} }]) }
  };
  const proto = window.HTMLElement.prototype;
  if (!proto.hidePopover) {
    proto.hidePopover = function () {}; proto.showPopover = function () {}; proto.togglePopover = function () {};
  }
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, "").replace(/<script[\s\S]*?<\/script>/g, "");
});
afterEach(() => { if (prevChrome === undefined) delete globalThis.chrome; else globalThis.chrome = prevChrome; });

function deps() {
  const snapshot = { sessionId: null, title: "", cwd: null, blank: true, running: false, nodes: [],
    todos: [], goal: null, tokenUsage: null, permissions: null, planMode: null, queue: [], jobs: [],
    pendingApproval: null, pendingQuestion: null, contextPressure: null, sessionStats: null,
    imageLimits: null, subagent: null, agentPreset: null };
  return {
    DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting", DISCONNECTED: "disconnected" },
    connection: { baseUrl: "http://127.0.0.1:3080", streamState: "connected",
      ensureStarted: vi.fn().mockResolvedValue(), call: vi.fn().mockResolvedValue({}), respond: vi.fn() },
    onFrame: vi.fn(),
    sessions: {
      store: { toolCall: () => null }, listStore: { get: () => [] },
      onRuntimeChange: vi.fn(), getRuntimeSnapshot: () => snapshot,
      handleMuxFrame: vi.fn(), handleHostFrame: vi.fn(),
      refreshList: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue("new-session-1"),
      open: vi.fn().mockResolvedValue("new-session-1"),
      loadHistory: vi.fn().mockResolvedValue({}),
      prompt: vi.fn(), cancel: vi.fn(), fork: vi.fn(), updateQueue: vi.fn(),
      search: vi.fn().mockResolvedValue(null), archive: vi.fn(),
      listAgentPresets: vi.fn().mockResolvedValue({ presets: [] }), selectAgentPreset: vi.fn()
    },
    models: { refresh: vi.fn().mockResolvedValue([]) },
    skills: { skills: [], refresh: vi.fn().mockResolvedValue([]) },
    commands: { commands: [], refresh: vi.fn().mockResolvedValue([]), execute: vi.fn() },
    workspaces: { refresh: vi.fn().mockResolvedValue([]) },
    references: { files: vi.fn().mockResolvedValue([]), sessions: vi.fn().mockResolvedValue([]) },
    goals: { create: vi.fn(), edit: vi.fn(), pause: vi.fn(), resume: vi.fn(), clear: vi.fn() },
    attachments: { pending: [], clear: vi.fn(), onChange: vi.fn(), setLimits: vi.fn() },
    settings: {}, formatErrorDetails: (e) => String(e?.message ?? e),
    setLang: vi.fn(), getLang: () => "zh"
  };
}

describe("新建会话", () => {
  it("start() 后点击左上角新建按钮会真的建会话", async () => {
    const d = deps();
    const app = createSidepanelApp(document, d);
    await app.start();
    await new Promise((r) => setTimeout(r, 30));
    d.sessions.create.mockClear();
    document.querySelector("#hdr-new").click();
    await new Promise((r) => setTimeout(r, 30));
    expect(d.sessions.create, "点击新建没有发起 session.create").toHaveBeenCalled();
  });

  it("新建按钮当监听器时传入的 MouseEvent 不会被当成 options", async () => {
    // newSession 直接挂在 addEventListener 上,回调参数是 MouseEvent。
    // 若把它当 options 解构,_retried 会被 event 上的同名属性污染。
    const d = deps();
    const app = createSidepanelApp(document, d);
    await expect(app.newSession(new window.MouseEvent("click"))).resolves.not.toThrow;
    expect(d.sessions.create).toHaveBeenCalled();
  });

  it("后端连不上/很慢时,新建按钮也必须可用(真实故障场景)", async () => {
    const d = deps();
    // ensureStarted 永不 resolve —— 后端未启动时就是这种表现
    d.connection.ensureStarted = vi.fn(() => new Promise(() => {}));
    const app = createSidepanelApp(document, d);
    void app.start();
    await new Promise((r) => setTimeout(r, 50));
    document.querySelector("#hdr-new").click();
    await new Promise((r) => setTimeout(r, 50));
    expect(d.sessions.create, "后端卡住时新建按钮失效").toHaveBeenCalled();
  });

  it("直接调用 newSession() 可用(对照组)", async () => {
    const d = deps();
    const app = createSidepanelApp(document, d);
    await app.newSession();
    expect(d.sessions.create).toHaveBeenCalled();
  });
});

describe("session.create 的归属参数互斥", () => {
  // 宿主校验:workspaceId 与 cwd 不能同时出现,同时给会被判 bad-request 整体拒绝
  // —— 用户看到的就是"点新建没任何反应"。
  it("locationOf 两者都给时只保留 workspaceId", () => {
    expect(locationOf({ workspaceId: "w1", cwd: "/p" })).toEqual({ workspaceId: "w1" });
  });
  it("locationOf 仅 cwd 时保留 cwd", () => {
    expect(locationOf({ cwd: "/p" })).toEqual({ cwd: "/p" });
  });
  it("locationOf 都没有时为空", () => {
    expect(locationOf({})).toEqual({});
    expect(locationOf()).toEqual({});
  });

  it("create() 兜底:调用方两个都传也只发一个", async () => {
    const call = vi.fn().mockResolvedValue({ sessionId: "s1" });
    const svc = createSessionService({ call });
    await svc.create({ workspaceId: "w1", cwd: "/p" });
    const [, payload] = call.mock.calls[0];
    expect(payload.workspaceId).toBe("w1");
    expect(payload).not.toHaveProperty("cwd");
  });

  it("open() 的 attach 路径同样不会同时带两者", async () => {
    const call = vi.fn().mockImplementation((method) =>
      method === "session.history" ? Promise.resolve({ events: [], projections: { values: {} } })
        : Promise.resolve({ sessionId: "s1" }));
    const svc = createSessionService({ call });
    await svc.open("s1", { workspaceId: "w1", cwd: "/p" });
    const createCall = call.mock.calls.find(([m]) => m === "session.create");
    expect(createCall[1].workspaceId).toBe("w1");
    expect(createCall[1]).not.toHaveProperty("cwd");
  });
});

describe("open() 绝不发裸 sessionId(session-conflict 回归)", () => {
  // 会话 cwd 创建时固定;attach 不带归属参数会让宿主回退到它的启动目录
  // (dsh web 的 --cwd,常是 ~),与存档 cwd 不符即 session-conflict。
  const hist = { events: [], projections: { values: {} } };
  const mk = (onCreate) => {
    const seen = [];
    const call = vi.fn().mockImplementation((method, payload) => {
      if (method === "session.create") { seen.push(payload); return onCreate(payload); }
      if (method === "session.history") return Promise.resolve(hist);
      return Promise.resolve({});
    });
    return { call, seen };
  };
  const conflict = () =>
    Promise.reject(Object.assign(new Error("cwd mismatch"), { code: "session-conflict" }));

  it("无归属参数且列表无 cwd:跳过 attach,直接读历史", async () => {
    const { call, seen } = mk(conflict);
    const svc = createSessionService({ call });
    await svc.open("s-stale");
    expect(seen).toEqual([]);
    expect(call.mock.calls.some(([m]) => m === "session.history")).toBe(true);
  });

  it("列表里记过 cwd:用它当锚点", async () => {
    const { call, seen } = mk((p) => Promise.resolve({ sessionId: p.sessionId }));
    const svc = createSessionService({ call });
    svc.listStore.upsertAndNotify({
      sessionId: "s1", updatedAt: 1, running: false, blank: true, cwd: "/w/a"
    });
    await svc.open("s1");
    expect(seen).toEqual([{ sessionId: "s1", cwd: "/w/a" }]);
  });

  it("attach 撞 conflict 时不再二次裸发,也不把错误甩给用户", async () => {
    const { call, seen } = mk(conflict);
    const svc = createSessionService({ call });
    await expect(svc.open("s1", { workspaceId: "w1" })).resolves.toBe("s1");
    expect(seen).toEqual([{ sessionId: "s1", workspaceId: "w1" }]);
  });

  it("非 conflict 错误仍如实抛出", async () => {
    const { call } = mk(() =>
      Promise.reject(Object.assign(new Error("boom"), { code: "internal" })));
    const svc = createSessionService({ call });
    await expect(svc.open("s1", { workspaceId: "w1" })).rejects.toMatchObject({ code: "internal" });
  });
});

// 未选工作目录时新建会话必须能用:payload 里既无 workspaceId 也无 cwd,
// 由宿主决定工作目录(host 契约:"an omitted project uses the Host cwd")。
// 真实宿主验证过 {} 可创建成功。
describe("未选工作目录也能新建会话(临时目录)", () => {
  it("create({}) 发出的 payload 不含 workspaceId/cwd", async () => {
    const call = vi.fn().mockResolvedValue({ sessionId: "s-tmp" });
    const svc = createSessionService({ call });
    const id = await svc.create({});
    expect(id).toBe("s-tmp");
    const [method, payload] = call.mock.calls[0];
    expect(method).toBe("session.create");
    expect(payload).not.toHaveProperty("workspaceId");
    expect(payload).not.toHaveProperty("cwd");
  });

  it("locationOf(null/undefined) 为空对象,不会凭空造出归属参数", () => {
    expect(locationOf(undefined)).toEqual({});
    expect(locationOf({ workspaceId: null, cwd: null })).toEqual({});
  });
});
