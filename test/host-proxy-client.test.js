import { describe, it, expect, vi } from "vitest";
import {
  createHostProxyClient,
  HostProxyError,
  HostProxyReason
} from "../src/platform/dsh/host-proxy-client.js";

/// 造一个只回一次的 fetch。
function respondWith({ status = 200, body = {} } = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  });
}

describe("host-proxy-client", () => {
  it("成功时回解析后的 JSON", async () => {
    const fetchImpl = respondWith({ body: { exitCode: 0, stdout: "ok" } });
    const client = createHostProxyClient({ fetch: fetchImpl });
    await expect(client.git("/home/u/r", ["status"])).resolves.toEqual({ exitCode: 0, stdout: "ok" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:37086/host/git");
    expect(JSON.parse(init.body)).toEqual({ cwd: "/home/u/r", args: ["status"] });
  });

  it("子进程非零退出不抛错 —— 由调用方决定怎么展示 stderr", async () => {
    // 这是本模块最容易写错的一条:git 失败是数据,不是传输错误。
    const fetchImpl = respondWith({ body: { exitCode: 1, stdout: "", stderr: "nothing to commit" } });
    const client = createHostProxyClient({ fetch: fetchImpl });
    const result = await client.git("/home/u/r", ["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("nothing to commit");
  });

  it("404 视为 unsupported —— 老 daemon 没有 /host/*,重试永远不会好", async () => {
    const client = createHostProxyClient({ fetch: respondWith({ status: 404, body: "" }) });
    const error = await client.capabilities().catch((e) => e);
    expect(error).toBeInstanceOf(HostProxyError);
    expect(error.reason).toBe(HostProxyReason.UNSUPPORTED);
    expect(error.isUnsupported).toBe(true);
  });

  it("连不上也视为 unsupported", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = createHostProxyClient({ fetch: fetchImpl });
    const error = await client.capabilities().catch((e) => e);
    expect(error.reason).toBe(HostProxyReason.UNSUPPORTED);
  });

  it("403 是 forbidden,400 是 invalid,409 是 busy", async () => {
    const cases = [
      [403, HostProxyReason.FORBIDDEN],
      [400, HostProxyReason.INVALID],
      [409, HostProxyReason.BUSY]
    ];
    for (const [status, reason] of cases) {
      const client = createHostProxyClient({ fetch: respondWith({ status, body: { error: "x" } }) });
      const error = await client.git("/x", ["status"]).catch((e) => e);
      expect(error.reason, `status ${status}`).toBe(reason);
    }
  });

  it("识别 dsh 不是 pnpm 装的这一特定原因", async () => {
    const client = createHostProxyClient({
      fetch: respondWith({ status: 400, body: { error: "...", reason: "dsh-not-installed-via-pnpm" } })
    });
    const error = await client.serverRestart().catch((e) => e);
    expect(error.reason).toBe(HostProxyReason.NOT_PNPM);
  });

  it("非 JSON 的错误体不会变成 SyntaxError", async () => {
    // 代理层返回的 502 往往是 HTML;直接 .json() 会抛出与真实原因无关的错误。
    const client = createHostProxyClient({ fetch: respondWith({ status: 502, body: "<html>bad gateway</html>" }) });
    const error = await client.git("/x", ["status"]).catch((e) => e);
    expect(error).toBeInstanceOf(HostProxyError);
    expect(error.reason).toBe(HostProxyReason.FAILED);
  });

  it("不碰 chrome.storage,也不发 native message", async () => {
    // 本版没有令牌机制。这条断言守住那个简化:若有人加回令牌而没更新方案,
    // 这里会失败,而不是悄悄多出一条落盘/原生调用路径。
    const storageSet = vi.fn();
    const sendNativeMessage = vi.fn();
    const original = globalThis.chrome;
    globalThis.chrome = {
      storage: { session: { get: vi.fn(), set: storageSet }, local: { get: vi.fn(), set: storageSet } },
      runtime: { sendNativeMessage }
    };
    try {
      const client = createHostProxyClient({ fetch: respondWith({ body: { ok: true } }) });
      await client.disable();
      expect(storageSet).not.toHaveBeenCalled();
      expect(sendNativeMessage).not.toHaveBeenCalled();
    } finally {
      globalThis.chrome = original;
    }
  });

  it("capabilities 用 POST —— Chrome 对简单 GET 不带 Origin", async () => {
    // 回归:原先用 GET,实测在真实侧栏里被 daemon 以 "origin required" 拒掉,
    // 整个 Git 页降级成"此部署不提供宿主操作"。POST+json 是预检请求,必带 Origin。
    const fetchImpl = respondWith({ body: { git: true } });
    await createHostProxyClient({ fetch: fetchImpl }).capabilities();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:37086/host/capabilities");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("plugin 的只读动作不带 name,写动作带 name", async () => {
    const fetchImpl = respondWith({ body: { exitCode: 0 } });
    const client = createHostProxyClient({ fetch: fetchImpl });
    await client.plugin("list");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ action: "list" });
    await client.plugin("add", "pkg");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ action: "add", name: "pkg" });
  });
});
