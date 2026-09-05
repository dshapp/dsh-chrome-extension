import { describe, it, expect, vi } from "vitest";
import { createApiClient, DshRpcError, DshTransportError } from "../src/platform/dsh/api-client.js";
import { normalizeBackendUrl, toWebSocketUrl } from "../src/platform/storage/settings.js";

function okResponse(value) {
  return { ok: true, json: async () => value } ;
}

describe("api-client", () => {
  it("发送 ClientRequest 信封并解析成功响应", async () => {
    const calls = [];
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:3080",
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return okResponse({ type: "server-response", rpcId: calls[0].body.rpcId, result: { ok: true, value: { hello: 1 } } });
      }
    });
    const value = await client.call("session/modelCatalog", {});
    expect(value).toEqual({ hello: 1 });
    expect(calls[0].url).toBe("http://127.0.0.1:3080/api/session/modelCatalog");
    expect(calls[0].body.type).toBe("client-request");
    expect(calls[0].body.method).toBe("session/modelCatalog");
    expect(calls[0].body.payload).toEqual({ args: {} });
  });

  it("业务错误抛 DshRpcError(code/details)", async () => {
    const client = createApiClient({
      baseUrl: "http://x",
      fetch: async () => okResponse({
        type: "server-response", rpcId: "fixed",
        result: { ok: false, error: { code: "session-not-found", message: "nope", details: { id: "s1" } } }
      }),
      makeRpcId: () => "fixed"
    });
    await expect(client.call("session/page", {})).rejects.toMatchObject({
      name: "DshRpcError", code: "session-not-found", details: { id: "s1" }
    });
    expect(DshRpcError).toBeDefined();
  });

  it("rpcId 不匹配抛 transport 错误", async () => {
    const client = createApiClient({
      baseUrl: "http://x",
      fetch: async () => okResponse({ type: "server-response", rpcId: "other", result: { ok: true, value: {} } }),
      makeRpcId: () => "mine"
    });
    await expect(client.call("session/modelCatalog", {})).rejects.toBeInstanceOf(DshTransportError);
  });

  it("403 返回围栏提示", async () => {
    const client = createApiClient({
      baseUrl: "http://x",
      fetch: async () => ({ ok: false, status: 403, json: async () => ({}) })
    });
    await expect(client.call("session/modelCatalog", {})).rejects.toThrow(/信任围栏/);
  });

  it("settleRemoteEvent 通过 $events/result 回传 waterfall 结果", async () => {
    let body;
    const client = createApiClient({
      baseUrl: "http://x",
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
        return okResponse({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: null } });
      }
    });
    const accepted = await client.settleRemoteEvent("client-1", "event-1", { kind: "result", value: "yes" });
    expect(accepted).toBe(true);
    expect(body.method).toBe("$events/result");
    expect(body.payload.args).toEqual({ clientId: "client-1", eventId: "event-1", outcome: { kind: "result", value: "yes" } });
  });

  it("401 后重签并只重试一次", async () => {
    let requests = 0;
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:3080",
      onUnauthorized,
      makeRpcId: () => "fixed",
      fetch: async () => {
        requests += 1;
        if (requests === 1) return { ok: false, status: 401, json: async () => ({}) };
        return okResponse({ type: "server-response", rpcId: "fixed", result: { ok: true, value: 1 } });
      }
    });
    await expect(client.call("session/modelCatalog", {})).resolves.toBe(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
  });
});

describe("settings", () => {
  it("normalizeBackendUrl 补协议、去尾斜杠", () => {
    expect(normalizeBackendUrl("127.0.0.1:3080/")).toBe("http://127.0.0.1:3080");
    expect(normalizeBackendUrl("http://127.0.0.1:3080///")).toBe("http://127.0.0.1:3080");
    expect(normalizeBackendUrl("")).toBe("http://127.0.0.1:3080");
  });

  it("toWebSocketUrl 推导 ws 地址", () => {
    expect(toWebSocketUrl("http://127.0.0.1:3080", "/api/events.mux")).toBe("ws://127.0.0.1:3080/api/events.mux");
    expect(toWebSocketUrl("https://h.example", "/api/events.mux")).toBe("wss://h.example/api/events.mux");
  });
});

describe("畸形响应信封", () => {
  const mk = (result) => createApiClient({
    baseUrl: "http://x",
    fetch: async () => okResponse({ type: "server-response", rpcId: "fixed", result }),
    makeRpcId: () => "fixed"
  });

  // 裸取 result.ok / result.error.code 会抛 TypeError,而 error-details 靠
  // instanceof 分流,裸 TypeError 全落到兜底 —— 用户看到的是一句没有意义的
  // JS 内部报错,而不是"信封无效"。
  it("缺 result 时抛 DshTransportError,不是 TypeError", async () => {
    await expect(mk(undefined).call("m", {})).rejects.toBeInstanceOf(DshTransportError);
  });

  it("ok:false 但缺 error 时抛 DshRpcError,不是 TypeError", async () => {
    const error = await mk({ ok: false }).call("m", {}).catch((e) => e);
    expect(error).toBeInstanceOf(DshRpcError);
    expect(error.code).toBe("unknown");
  });

  it("result 不是对象时也按信封无效处理", async () => {
    await expect(mk("nope").call("m", {})).rejects.toBeInstanceOf(DshTransportError);
  });
});
