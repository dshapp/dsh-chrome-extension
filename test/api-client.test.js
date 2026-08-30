import { describe, it, expect } from "vitest";
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
    const value = await client.call("host.describe", {});
    expect(value).toEqual({ hello: 1 });
    expect(calls[0].url).toBe("http://127.0.0.1:3080/api/host.describe");
    expect(calls[0].body.type).toBe("client-request");
    expect(calls[0].body.method).toBe("host.describe");
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
    await expect(client.call("session.history", {})).rejects.toMatchObject({
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
    await expect(client.call("host.describe", {})).rejects.toBeInstanceOf(DshTransportError);
  });

  it("403 返回围栏提示", async () => {
    const client = createApiClient({
      baseUrl: "http://x",
      fetch: async () => ({ ok: false, status: 403, json: async () => ({}) })
    });
    await expect(client.call("host.describe", {})).rejects.toThrow(/信任围栏/);
  });

  it("respond 发送 ClientResponse 信封", async () => {
    let body;
    const client = createApiClient({
      baseUrl: "http://x",
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
        return okResponse({ accepted: true });
      }
    });
    const receipt = await client.respond("rpc-1", { ok: true, value: {} });
    expect(receipt).toEqual({ accepted: true });
    expect(body).toEqual({ type: "client-response", rpcId: "rpc-1", result: { ok: true, value: {} } });
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
