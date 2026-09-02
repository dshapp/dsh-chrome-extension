// 帧监听器应随连接实例隔离:dispose 一个连接不得清空另一个连接的订阅。
import { describe, it, expect, vi, afterEach } from "vitest";
import { createDshConnection } from "../src/platform/dsh/dsh-connection.js";

function frameJson() {
  return JSON.stringify({
    type: "server-request",
    rpcId: "r1",
    method: "session/subscribed",
    payload: { type: "session/subscribed", sessionId: "s1" }
  });
}

function makeSettings() {
  return { getBackendUrl: async () => "http://127.0.0.1:3080", setBackendUrl: async (u) => u };
}

function mockFetch() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      json: async () => ({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { home: "/home" } } })
    };
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dsh-connection 帧监听器隔离", () => {
  it("实例 B 的 dispose 不清空实例 A 的帧监听器", async () => {
    const sockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        sockets.push(this);
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    // 两个连接用不同端口,便于区分各自的 socket。
    const connA = createDshConnection({ baseUrl: "http://127.0.0.1:3080", settings: makeSettings(), dnr: null, fetch: mockFetch() });
    const connB = createDshConnection({ baseUrl: "http://127.0.0.1:3090", settings: makeSettings(), dnr: null, fetch: mockFetch() });
    await connA.ensureStarted();
    await connB.ensureStarted();

    // 完成握手,让 connect() 走完、不残留轮询定时器。
    for (const s of sockets) s.onopen?.();
    await sleep(150);

    const listenerA = vi.fn();
    connA.onFrame(listenerA);
    connB.onFrame(vi.fn());

    // B 连接销毁 —— 不应波及 A 的订阅。
    await connB.dispose();

    // 触发 A 的下行帧。
    const aMux = sockets.find((s) => s.url.includes("127.0.0.1:3080") && s.url.endsWith("events.mux"));
    aMux.onmessage({ data: frameJson() });

    expect(listenerA).toHaveBeenCalledTimes(1);
  });
});

describe("dsh-connection 启动前改后端地址", () => {
  it("先 setBackendUrl 再 call,下行流仍要开起来", async () => {
    // 真实路径:用户在设置页先把服务器地址改掉,之后才发第一条消息。
    // setBackendUrl 会预建 api 与 downlink,但 hadStarted 为 false 所以不调 start();
    // 而 ensureStarted 的守卫看的是 api 是否为空,此时 api 已非空 —— 于是 start()
    // 永远等不到,上行 HTTP 正常但下行帧一条都收不到。
    const sockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        sockets.push(this);
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const conn = createDshConnection({ settings: makeSettings(), dnr: null, fetch: mockFetch() });
    await conn.setBackendUrl("http://127.0.0.1:3099");
    await conn.call("test/method", {});
    for (const s of sockets) s.onopen?.();
    await sleep(150);

    // 下行流必须已经建立,并且连的是新地址。
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.every((s) => s.url.includes("127.0.0.1:3099"))).toBe(true);
    expect(conn.streamState).not.toBe("disconnected");

    // 帧要真能送达订阅者。
    const listener = vi.fn();
    conn.onFrame(listener);
    const mux = sockets.find((s) => s.url.endsWith("events.mux"));
    mux.onmessage({ data: frameJson() });
    expect(listener).toHaveBeenCalledTimes(1);

    await conn.dispose();
  });
});
