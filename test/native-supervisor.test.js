import { describe, it, expect, beforeEach, vi } from "vitest";

// native-supervisor 读 globalThis.chrome;测试里按需注入或清空。
const ORIG_CHROME = globalThis.chrome;

describe("native-supervisor", () => {
  beforeEach(() => {
    delete globalThis.chrome;
  });

  it("native messaging 不可用时返回 unavailable,且不抛错", async () => {
    const { ensureServerRunning, probeHost } = await import("../src/platform/dsh/native-supervisor.js");
    const result = await ensureServerRunning("web");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("native-messaging-unavailable");
    const probe = await probeHost();
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe("native-messaging-unavailable");
  });

  it("把消息转发给 host 并原样回传结果", async () => {
    const sendNativeMessage = vi.fn().mockResolvedValue({ ok: true, alreadyUp: true });
    globalThis.chrome = { runtime: { sendNativeMessage } };
    const { ensureServerRunning } = await import("../src/platform/dsh/native-supervisor.js");
    // 第一次调用会走真实 host 路径;成功后立刻第二次应被冷却挡住。
    const first = await ensureServerRunning("web", { force: true, backendUrl: "http://127.0.0.1:3080" });
    expect(first).toEqual({ ok: true, alreadyUp: true });
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);
    expect(sendNativeMessage.mock.calls[0][1].cmd).toBe("start");
    expect(sendNativeMessage.mock.calls[0][1].target).toBe("web");
    expect(sendNativeMessage.mock.calls[0][1].host).toBe("127.0.0.1");
    expect(sendNativeMessage.mock.calls[0][1].port).toBe(3080);

    const second = await ensureServerRunning("web", { backendUrl: "http://127.0.0.1:3080" });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("cooldown");
    // 冷却期内不应再向 host 发消息。
    expect(sendNativeMessage).toHaveBeenCalledTimes(1);

    // force 跳过冷却。
    const third = await ensureServerRunning("web", { force: true, backendUrl: "http://127.0.0.1:3080" });
    expect(third).toEqual({ ok: true, alreadyUp: true });
    expect(sendNativeMessage).toHaveBeenCalledTimes(2);
  });

  it("host 抛错时返回 reason 而非 reject", async () => {
    const sendNativeMessage = vi.fn().mockRejectedValue(new Error("host not installed"));
    globalThis.chrome = { runtime: { sendNativeMessage } };
    const { ensureServerRunning } = await import("../src/platform/dsh/native-supervisor.js");
    const result = await ensureServerRunning("web", { force: true, backendUrl: "http://127.0.0.1:3080" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("host not installed");
  });
});
