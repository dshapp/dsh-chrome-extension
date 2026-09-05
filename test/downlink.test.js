import { afterEach, describe, it, expect, vi } from "vitest";
import { createDownlink, exceedsUtf8ByteLimit, parseMuxFrame } from "../src/platform/dsh/downlink.js";
import { createReconnectBackoff } from "../src/platform/dsh/reconnect-backoff.js";
import { mdToHtml, escapeHtml } from "../src/shared/md-to-html.js";

describe("downlink 帧解析", () => {
  it("解析 item/error/end 逻辑流帧", () => {
    const frame = parseMuxFrame(JSON.stringify({
      type: "item", streamId: "follow:s1",
      value: { type: "snapshot", cursor: 4 }
    }));
    expect(frame).toEqual({ type: "item", streamId: "follow:s1", value: { type: "snapshot", cursor: 4 } });
    expect(parseMuxFrame(JSON.stringify({ type: "end", streamId: "events" }))).toEqual({ type: "end", streamId: "events" });
  });

  it("非法帧返回 undefined", () => {
    expect(parseMuxFrame(JSON.stringify({ type: "server-response", rpcId: "r" }))).toBeUndefined();
    expect(parseMuxFrame(JSON.stringify({ type: "item" }))).toBeUndefined();
    expect(parseMuxFrame("not json")).toBeUndefined();
  });

  it("帧上限按 UTF-8 字节而不是 JS 字符数计算", () => {
    expect(exceedsUtf8ByteLimit("abc", 3)).toBe(false);
    expect(exceedsUtf8ByteLimit("你", 2)).toBe(true);
    expect(exceedsUtf8ByteLimit("你", 3)).toBe(false);
    expect(exceedsUtf8ByteLimit("😀", 3)).toBe(true);
    expect(exceedsUtf8ByteLimit("😀", 4)).toBe(false);
  });
});

describe("mux 订阅", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("一条 socket 上发送 open、去重重复订阅并发送 cancel", () => {
    const sockets = [];
    class FakeWebSocket {
      static OPEN = 1;
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
      send(text) { this.sent.push(JSON.parse(text)); }
      close() { this.readyState = 3; }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const downlink = createDownlink({ apiClient: { baseUrl: "http://127.0.0.1:3080" } });
    downlink.subscribe("events", "$events", {});
    downlink.start();
    const socket = sockets[0];
    expect(socket.url).toBe("ws://127.0.0.1:3080/api/remote.mux");
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen();
    expect(socket.sent).toEqual([{ type: "open", streamId: "events", endpoint: "$events", payload: { args: {} } }]);
    downlink.subscribe("events", "$events", {});
    expect(socket.sent).toHaveLength(1);
    downlink.subscribe("events", "$events", { scope: "next" });
    expect(socket.sent.slice(1)).toEqual([
      { type: "cancel", streamId: "events" },
      { type: "open", streamId: "events", endpoint: "$events", payload: { args: { scope: "next" } } }
    ]);
    downlink.unsubscribe("events");
    expect(socket.sent[3]).toEqual({ type: "cancel", streamId: "events" });
    downlink.stop();
  });

  it("短连接连续断开时退避递增，稳定连接后才重置", async () => {
    vi.useFakeTimers();
    const sockets = [];
    class FakeWebSocket {
      static OPEN = 1;
      constructor() { this.readyState = 0; sockets.push(this); }
      send() {}
      close() { this.readyState = 3; }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const downlink = createDownlink({
      apiClient: { baseUrl: "http://127.0.0.1:3080" },
      backoff: { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 },
      stableGenerationMs: 300
    });
    downlink.start();

    sockets[0].readyState = FakeWebSocket.OPEN;
    sockets[0].onopen();
    sockets[0].onclose();
    vi.advanceTimersByTime(49);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1].readyState = FakeWebSocket.OPEN;
    sockets[1].onopen();
    sockets[1].onclose();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2].readyState = FakeWebSocket.OPEN;
    sockets[2].onopen();
    vi.advanceTimersByTime(300);
    sockets[2].onclose();
    vi.advanceTimersByTime(49);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
    downlink.stop();
  });

  it("服务端接受后立刻断开两次仍会唤起 native supervisor", () => {
    vi.useFakeTimers();
    const sockets = [];
    const ensureServerRunning = vi.fn(async () => true);
    class FakeWebSocket {
      static OPEN = 1;
      constructor() { this.readyState = 0; sockets.push(this); }
      send() {}
      close() { this.readyState = 3; }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const downlink = createDownlink({
      apiClient: { baseUrl: "http://127.0.0.1:3080" },
      backoff: { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 },
      ensureServerRunning
    });
    downlink.start();

    sockets[0].readyState = FakeWebSocket.OPEN;
    sockets[0].onopen();
    sockets[0].onclose();
    vi.advanceTimersByTime(50);
    sockets[1].readyState = FakeWebSocket.OPEN;
    sockets[1].onopen();
    sockets[1].onclose();

    expect(ensureServerRunning).toHaveBeenCalledTimes(1);
    expect(ensureServerRunning).toHaveBeenCalledWith("web", {
      backendUrl: "http://127.0.0.1:3080"
    });
    downlink.stop();
  });

  it("连续握手失败时等待 Cookie 恢复完成后才发起下一次连接", async () => {
    vi.useFakeTimers();
    const sockets = [];
    let finishRecovery;
    const recoverConnection = vi.fn(() => new Promise((resolve) => { finishRecovery = resolve; }));
    class FakeWebSocket {
      static OPEN = 1;
      constructor() { this.readyState = 0; sockets.push(this); }
      send() {}
      close() { this.readyState = 3; }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const downlink = createDownlink({
      apiClient: { baseUrl: "http://127.0.0.1:3080" },
      backoff: { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 },
      recoverConnection
    });
    downlink.start();
    sockets[0].readyState = FakeWebSocket.OPEN;
    sockets[0].onopen();
    sockets[0].onclose();
    vi.advanceTimersByTime(50);
    sockets[1].readyState = FakeWebSocket.OPEN;
    sockets[1].onopen();
    sockets[1].onclose();

    expect(recoverConnection).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    finishRecovery();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(3);
    downlink.stop();
  });
});

describe("reconnect backoff", () => {
  it("指数增长且封顶", () => {
    const backoff = createReconnectBackoff({ random: () => 0 });
    const delays = Array.from({ length: 7 }, () => backoff.next());
    expect(delays[0]).toBe(250);
    expect(delays[1]).toBe(500);
    expect(delays[2]).toBe(1000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(10000);
    backoff.reset();
    expect(backoff.next()).toBe(250);
  });
});

describe("md-to-html", () => {
  it("转义 HTML 注入", () => {
    expect(mdToHtml("<script>alert(1)</script>")).not.toContain("<script>");
    expect(escapeHtml('<a href="x">')).toBe("&lt;a href=&quot;x&quot;&gt;");
  });

  it("渲染标题/代码/列表/链接", () => {
    const html = mdToHtml("## Title\n\n- a\n- b\n\n`code`\n\n[link](https://example.com)");
    expect(html).toContain("<h4>Title</h4>");
    expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
  });

  it("fenced code 原样转义", () => {
    const html = mdToHtml("```js\nconst x = \"<b>\";\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("&lt;b&gt;");
  });

  it("渲染表格:表头/分隔行/数据行,支持行内加粗", () => {
    const html = mdToHtml("| 名称 | 值 |\n| --- | --- |\n| a | **1** |\n| b | 2 |");
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<thead><tr><th>名称</th><th>值</th></tr></thead>");
    expect(html).toContain("<td>a</td><td><strong>1</strong></td>");
    expect(html).toContain("<td>b</td><td>2</td>");
  });
});
