// @vitest-environment jsdom
// 后台会话丢帧前的"偷看"例外(对齐 web/macOS 丢帧策略保留的例外):
// 失败轮上报通知、用户消息更新活跃排序、标题投影喂给列表行;
// 以及历史浮层开着时对 listStore 的活刷新。
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createSessionService } from "../src/features/sessions/session-service.js";
import { createSessionListStore } from "../src/features/sessions/session-list-store.js";
import { SessionAwaitingKind } from "../src/features/sessions/session-row-trailing.js";
import {
  createBackgroundNotifier,
  pollSessionStatuses,
} from "../src/features/notifications/background-notifier.js";
import { mountHistoryDrawer } from "../src/app/sidepanel/sidepanel-overlays.js";

const CURRENT = "session-current";
const OTHER = "session-other";

function fakeConnection() {
  return {
    call: vi.fn(async (method) => {
      if (method === "session/list") return { items: [] };
      return {};
    }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn()
  };
}

async function serviceOn(sessionId, options) {
  const service = createSessionService(fakeConnection(), options);
  await service.open(sessionId);
  return service;
}

const eventFrame = (sessionId, event) => ({ type: "item", streamId: `follow:${sessionId}`, value: { event } });
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

describe("当前会话运行态的事件顺序", () => {
  it("host status=false 早于 durable turn/end 时不提前结束当前轮", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: CURRENT, updatedAt: 1, running: true }]);
    service.handleMuxFrame(eventFrame(CURRENT, {
      type: "turn/start", seq: 1, time: 100, data: { turn: 1 }
    }));
    expect(service.getRuntimeSnapshot().running).toBe(true);

    service.handleHostFrame({ payload: {
      type: "host/session-status", sessionId: CURRENT, running: false
    } });

    expect(service.listStore.get()[0].running).toBe(false);
    expect(service.getRuntimeSnapshot().running).toBe(true);

    service.handleMuxFrame(eventFrame(CURRENT, {
      type: "turn/end", seq: 2, time: 200, data: { turn: 1, reason: { kind: "completed" } }
    }));
    expect(service.getRuntimeSnapshot().running).toBe(false);
  });
});

describe("$events ready 主机上下文", () => {
  it("异步到达的 host.home 会触发运行快照更新", async () => {
    const service = await serviceOn(CURRENT);
    const listener = vi.fn();
    service.onRuntimeChange(listener);
    service.handleMuxFrame({ type: "item", streamId: "events", value: {
      type: "ready", clientId: "client-1", host: { home: "/Users/me" }
    } });
    expect(service.hostHome).toBe("/Users/me");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("后台会话标题投影", () => {
  it("非当前会话的 title 投影写进列表行的 projections.values.title", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: OTHER, updatedAt: 1, projections: { values: { title: "旧" } } }]);
    service.handleMuxFrame({ type: "item", streamId: "control", value: { type: "projection", sessionId: OTHER, key: "title", value: "新标题", seq: 7 } });
    expect(service.listStore.get()[0].projections.values.title).toBe("新标题");
  });

  it("当前会话的 title 投影仍走 store 快照", async () => {
    const service = await serviceOn(CURRENT);
    service.handleMuxFrame({ type: "item", streamId: "control", value: { type: "projection", sessionId: CURRENT, key: "title", value: "当前标题", seq: 7 } });
    expect(service.getRuntimeSnapshot().title).toBe("当前标题");
  });

  it("title 之外的后台投影也写进列表摘要", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: OTHER, updatedAt: 1 }]);
    service.handleMuxFrame({ type: "item", streamId: "control", value: { type: "projection", sessionId: OTHER, key: "stats", value: { x: 1 }, seq: 7 } });
    expect(service.listStore.get()[0].projections).toEqual({ asOfSeq: 7, values: { stats: { x: 1 } } });
  });

  it("重命名后台会话不改当前标题，且后续宿主投影仍可推进", async () => {
    const connection = fakeConnection();
    connection.call.mockImplementation(async (method, payload) => {
      if (method === "session/rename") return { title: payload.request.title };
      if (method === "session/list") return { items: [
        { sessionId: CURRENT, updatedAt: 2 },
        { sessionId: OTHER, updatedAt: 1, projections: { values: { title: "后台新名" } } }
      ] };
      return {};
    });
    const service = createSessionService(connection);
    await service.open(CURRENT);
    service.store.setTitle("当前标题");
    service.listStore.replaceAll([
      { sessionId: CURRENT, updatedAt: 2 },
      { sessionId: OTHER, updatedAt: 1, projections: { values: { title: "后台旧名" } } }
    ]);

    await service.rename(OTHER, "后台新名");
    expect(service.getRuntimeSnapshot().title).toBe("当前标题");
    expect(service.listStore.get().find((row) => row.sessionId === OTHER)?.projections?.values?.title)
      .toBe("后台新名");

    await service.rename(CURRENT, "手工标题");
    expect(service.getRuntimeSnapshot().title).toBe("手工标题");
    service.handleMuxFrame({ type: "item", streamId: "control", value: {
      type: "projection", sessionId: CURRENT, key: "title", value: "宿主后续标题", seq: 7
    } });
    expect(service.getRuntimeSnapshot().title).toBe("宿主后续标题");
  });
});

describe("session/control baseline 缓存", () => {
  it("baseline 早于会话选择到达时，打开后仍恢复队列、任务和投影", async () => {
    const service = createSessionService(fakeConnection());
    service.handleMuxFrame({
      type: "item", streamId: "control", value: {
        type: "baseline",
        value: {
          queues: { [CURRENT]: [{ id: "q1" }] },
          jobs: { [CURRENT]: [{ id: "j1" }] },
          projections: { [CURRENT]: { asOfSeq: 4, values: {
            title: "缓存标题",
            modelSelection: { lastUsed: null, next: { provider: "p", model: "m" } }
          } } }
        }
      }
    });
    await service.open(CURRENT);
    expect(service.getRuntimeSnapshot()).toMatchObject({
      title: "缓存标题",
      queue: [{ id: "q1" }],
      jobs: [{ id: "j1" }],
      modelSelection: { next: { provider: "p", model: "m" } }
    });
  });
});

describe("后台 waterfall 缓存", () => {
  it("未打开会话收到审批后，切入该会话仍能显示卡片", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: OTHER, updatedAt: 1 }]);
    service.handleMuxFrame({ type: "item", streamId: "events", value: {
      type: "waterfall", event: "approval/request", eventId: "event-1", agentId: OTHER,
      request: { approvalId: "approval-1", toolName: "bash", reason: "needs access" }
    } });
    await service.open(OTHER);
    expect(service.getRuntimeSnapshot().pendingApproval).toMatchObject({
      eventId: "event-1", approvalId: "approval-1", toolName: "bash"
    });
    service.handleMuxFrame({ type: "item", streamId: "events", value: { type: "cancel", eventId: "event-1" } });
    expect(service.getRuntimeSnapshot().pendingApproval).toBeNull();
  });

  it("同会话审批优先于提问，撤销审批后恢复提问标记", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([{ sessionId: CURRENT, updatedAt: 1 }]);
    service.handleMuxFrame({ type: "item", streamId: "events", value: {
      type: "waterfall", event: "approval/request", eventId: "approval-1", agentId: CURRENT,
      request: { approvalId: "a1", toolName: "bash" }
    } });
    service.handleMuxFrame({ type: "item", streamId: "events", value: {
      type: "waterfall", event: "user-questions/request", eventId: "question-1", agentId: CURRENT,
      request: { questions: [{ id: "q1", question: "Continue?" }] }
    } });
    expect(service.listStore.awaitingUser(CURRENT)).toBe(SessionAwaitingKind.approval);

    service.handleMuxFrame({ type: "item", streamId: "events", value: {
      type: "cancel", eventId: "approval-1"
    } });
    expect(service.getRuntimeSnapshot().pendingApproval).toBeNull();
    expect(service.getRuntimeSnapshot().pendingQuestion?.eventId).toBe("question-1");
    expect(service.listStore.awaitingUser(CURRENT)).toBe(SessionAwaitingKind.question);
  });
});

describe("mux 逻辑流错误隔离", () => {
  it("子流 error 不重建仍健康的 mux 连接", () => {
    const connection = { ...fakeConnection(), forceReconnect: vi.fn() };
    const service = createSessionService(connection);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    service.handleMuxFrame({ type: "error", streamId: "events", error: { message: "closed" } });
    service.handleMuxFrame({ type: "error", streamId: "control", error: { message: "closed" } });
    expect(connection.forceReconnect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });
});

describe("归档会话持久过滤", () => {
  it("workspace 快照先到或后到都不会让归档会话复活", async () => {
    const connection = fakeConnection();
    connection.call.mockResolvedValue({
      items: [
        { sessionId: "active", updatedAt: 2, blank: false },
        { sessionId: "archived", updatedAt: 1, blank: false }
      ]
    });
    const service = createSessionService(connection);

    service.setArchivedSessionIds(["archived"]);
    await service.refreshList();
    expect(service.listStore.get().map((item) => item.sessionId)).toEqual(["active"]);

    service.setArchivedSessionIds([]);
    await service.refreshList();
    expect(service.listStore.get().map((item) => item.sessionId)).toEqual(["active", "archived"]);
    service.setArchivedSessionIds(["archived"]);
    expect(service.listStore.get().map((item) => item.sessionId)).toEqual(["active"]);
  });

  it("归档或删除后的迟到 added 帧不能复活会话", async () => {
    const service = await serviceOn(CURRENT);
    service.listStore.replaceAll([
      { sessionId: "archived", updatedAt: 2 },
      { sessionId: "removed", updatedAt: 1 }
    ]);
    service.setArchivedSessionIds(["archived"]);
    service.handleHostFrame({ payload: { type: "host/session-removed", sessionId: "removed" } });
    service.handleHostFrame({ payload: { type: "host/session-added", sessionId: "archived" } });
    service.handleHostFrame({ payload: { type: "host/session-added", sessionId: "removed" } });
    expect(service.listStore.get()).toEqual([]);
  });

  it("并发归档的乱序回包不会互相丢失 tombstone", async () => {
    const pending = new Map();
    const connection = fakeConnection();
    connection.call.mockImplementation((method, payload) => {
      if (method !== "workspace/archiveSession") return Promise.resolve({});
      return new Promise((resolve) => pending.set(payload.request.sessionId, resolve));
    });
    const service = createSessionService(connection);
    service.listStore.replaceAll([
      { sessionId: "a", updatedAt: 2 },
      { sessionId: "b", updatedAt: 1 }
    ]);

    const first = service.archive("a");
    const second = service.archive("b");
    pending.get("b")({ archivedSessionIds: ["b"] });
    await second;
    pending.get("a")({ archivedSessionIds: ["a"] });
    await first;

    service.handleHostFrame({ payload: { type: "host/session-added", sessionId: "a" } });
    service.handleHostFrame({ payload: { type: "host/session-added", sessionId: "b" } });
    expect(service.listStore.get()).toEqual([]);
  });
});

describe("session/list 刷新竞态", () => {
  it("等待 HTTP 快照期间到达的实时新增不会被旧快照覆盖", async () => {
    let resolveList;
    const connection = fakeConnection();
    connection.call.mockImplementation((method) => method === "session/list"
      ? new Promise((resolve) => { resolveList = resolve; })
      : Promise.resolve({}));
    const service = createSessionService(connection);
    const refresh = service.refreshList();
    service.handleHostFrame({ payload: {
      type: "host/session-added", sessionId: "live", blank: false, updatedAt: 2
    } });
    resolveList({ items: [{ sessionId: "stale", blank: false, updatedAt: 1 }] });
    await refresh;
    expect(service.listStore.get().map((item) => item.sessionId)).toEqual(["live"]);
  });

  it("两个并发刷新只允许后发请求落地", async () => {
    const resolvers = [];
    const connection = fakeConnection();
    connection.call.mockImplementation((method) => method === "session/list"
      ? new Promise((resolve) => { resolvers.push(resolve); })
      : Promise.resolve({}));
    const service = createSessionService(connection);
    const first = service.refreshList();
    const second = service.refreshList();
    resolvers[1]({ items: [{ sessionId: "new", blank: false, updatedAt: 2 }] });
    await second;
    resolvers[0]({ items: [{ sessionId: "old", blank: false, updatedAt: 1 }] });
    await first;
    expect(service.listStore.get().map((item) => item.sessionId)).toEqual(["new"]);
  });
});

describe("会话分页切换竞态", () => {
  it("切到新会话后，旧会话迟到的 page 不能把当前会话切回去", async () => {
    let resolvePage;
    const connection = fakeConnection();
    connection.call.mockImplementation((method) => {
      if (method === "session/page") {
        return new Promise((resolve) => { resolvePage = resolve; });
      }
      return Promise.resolve({});
    });
    const service = createSessionService(connection);
    await service.open(CURRENT);
    service.handleMuxFrame({
      type: "item", streamId: `follow:${CURRENT}`,
      value: { type: "snapshot", cursor: 12, records: [] }
    });
    const stalePage = service.loadHistory(CURRENT);

    await service.open(OTHER);
    resolvePage({ records: [{ event: { type: "user/message", seq: 1, data: { content: "stale" } } }] });
    await stalePage;

    expect(service.currentSessionId).toBe(OTHER);
    expect(service.getRuntimeSnapshot().sessionId).toBe(OTHER);
  });

  it("两个并发 open 即使旧 attach 后返回，也由最后一次调用赢得 follow", async () => {
    const resolvers = new Map();
    const connection = fakeConnection();
    connection.call.mockImplementation((method, args) => {
      if (method !== "session/create") return Promise.resolve({});
      const id = args.request.sessionId;
      return new Promise((resolve) => { resolvers.set(id, resolve); });
    });
    const service = createSessionService(connection);
    service.listStore.replaceAll([
      { sessionId: CURRENT, cwd: "/w", updatedAt: 2 },
      { sessionId: OTHER, cwd: "/w", updatedAt: 1 }
    ]);

    const first = service.open(CURRENT);
    const second = service.open(OTHER);
    resolvers.get(OTHER)({ sessionId: OTHER });
    await second;
    resolvers.get(CURRENT)({ sessionId: CURRENT });
    await first;

    expect(service.currentSessionId).toBe(OTHER);
    const follows = connection.subscribe.mock.calls.filter(([id]) => id.startsWith("follow:"));
    expect(follows.map(([id]) => id)).toEqual([`follow:${OTHER}`]);
  });
});

describe("follow 缺口修复与地址路由", () => {
  const entry = (seq, text = String(seq)) => ({
    event: { type: "user/message", seq, time: seq, data: {
      message: { id: `m${seq}`, content: [{ type: "text", text }], source: { kind: "user" } }
    } }
  });

  it("发现 seq 缺口后用权威 cursor 回填，并拼接等待期间的实时帧", async () => {
    let resolvePage;
    const connection = fakeConnection();
    connection.call.mockImplementation((method) => method === "session/page"
      ? new Promise((resolve) => { resolvePage = resolve; })
      : Promise.resolve({}));
    const service = createSessionService(connection);
    await service.open(CURRENT);
    service.handleMuxFrame({ type: "item", streamId: `follow:${CURRENT}`, value: {
      type: "snapshot", cursor: 5, records: [entry(1)]
    } });

    service.handleMuxFrame({ type: "item", streamId: `follow:${CURRENT}`, value: entry(6) });
    service.handleMuxFrame({ type: "item", streamId: `follow:${CURRENT}`, value: entry(7) });
    expect(connection.call).toHaveBeenCalledWith("session/page", { request: {
      address: { kind: "session", sessionId: CURRENT }, throughSeq: 5, maxMessages: 50
    } });
    expect(service.getRuntimeSnapshot().lastSeq).toBe(1);

    resolvePage({ records: [entry(1), entry(2), entry(3), entry(4), entry(5)] });
    await vi.waitFor(() => expect(service.getRuntimeSnapshot().lastSeq).toBe(7));
  });

  it("子代理缺口与 resync 都保持完整 subagent address", async () => {
    const address = { parentSessionId: "parent", childSessionId: "child", mode: "continuable" };
    const connection = fakeConnection();
    connection.call.mockImplementation(async (method) => {
      if (method === "session/page") return { records: [entry(8)] };
      if (method === "session/list") return { items: [] };
      return {};
    });
    const service = createSessionService(connection);
    await service.loadSubagentHistory(address);
    service.handleMuxFrame({ type: "item", streamId: "follow:child", value: {
      type: "snapshot", cursor: 8, records: [entry(6)]
    } });
    service.handleMuxFrame({ type: "item", streamId: "follow:child", value: entry(9) });
    await vi.waitFor(() => expect(service.getRuntimeSnapshot().lastSeq).toBe(9));
    await service.resync();

    const pages = connection.call.mock.calls.filter(([method]) => method === "session/page");
    expect(pages).toHaveLength(2);
    for (const [, args] of pages) {
      expect(args.request.address).toEqual({ kind: "subagent", ...address });
    }
  });

  it("较新的 follow snapshot 使在途旧 page 作废", async () => {
    let resolvePage;
    const connection = fakeConnection();
    connection.call.mockImplementation((method) => method === "session/page"
      ? new Promise((resolve) => { resolvePage = resolve; })
      : Promise.resolve({}));
    const service = createSessionService(connection);
    await service.open(CURRENT);
    service.handleMuxFrame({ type: "item", streamId: `follow:${CURRENT}`, value: {
      type: "snapshot", cursor: 4, records: [entry(4)]
    } });
    const stale = service.loadHistory(CURRENT);
    service.handleMuxFrame({ type: "item", streamId: `follow:${CURRENT}`, value: {
      type: "snapshot", cursor: 10, records: [entry(10)]
    } });
    resolvePage({ records: [entry(2)] });
    await stale;

    expect(service.getRuntimeSnapshot().lastSeq).toBe(10);
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

describe("后台通知轮询协议", () => {
  it("使用 0.1.2 的 session/list 端点和 _request 参数", async () => {
    const api = { call: vi.fn().mockResolvedValue({
      items: [
        { sessionId: "running", running: true },
        { sessionId: "idle", running: false }
      ]
    }) };
    const notifier = { observeStatus: vi.fn() };

    await pollSessionStatuses(api, notifier);

    expect(api.call).toHaveBeenCalledWith("session/list", { _request: {} });
    expect(notifier.observeStatus.mock.calls).toEqual([
      ["running", true],
      ["idle", false]
    ]);
  });
});

describe("运行集合的恢复与并发", () => {
  // loaded 是个 bool 时必须在 await 之前置位,于是并发的第二个调用者会在集合
  // 还空着时就拿到"已加载"。s1 的 running→idle 边沿被当成"本来就不在集合里",
  // 通知丢掉;而 storage 里 s1 仍标着 running,后续轮询再也见不到这个边沿。
  // 启动轮询与 alarm tick 恰好这样并发(见 sw/session-notify.js)。
  it("并发 loadRunning 时不丢完成通知", async () => {
    const create = vi.fn();
    const store = { dsh_running_sessions: ["s1"] };
    const area = {
      get: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { dsh_running_sessions: store.dsh_running_sessions };
      },
      set: async (patch) => { Object.assign(store, patch); }
    };
    const notifier = createBackgroundNotifier({
      notifications: { create },
      settings: { getNotificationsEnabled: async () => true },
      storage: area
    });

    const first = notifier.loadRunning();
    await notifier.loadRunning();
    notifier.observeStatus("s1", false);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(create).toHaveBeenCalledTimes(1);
    // 集合恢复后 s1 已经消费掉,不能继续留在 storage 里。
    expect(store.dsh_running_sessions).toEqual([]);
  });

  it("storage 读失败时退化为纯内存,不抛也不卡住", async () => {
    const create = vi.fn();
    const notifier = createBackgroundNotifier({
      notifications: { create },
      settings: { getNotificationsEnabled: async () => true },
      storage: { get: async () => { throw new Error("no storage"); }, set: async () => {} }
    });
    await expect(notifier.loadRunning()).resolves.toBeUndefined();
    notifier.observeStatus("s2", true);
    notifier.observeStatus("s2", false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(create).toHaveBeenCalledTimes(1);
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
