import { describe, it, expect, vi } from "vitest";
import { createServerOps } from "../src/features/host-proxy/server-ops.js";
import { HostProxyError, HostProxyReason } from "../src/platform/dsh/host-proxy-client.js";

describe("server-ops", () => {
  it("按语义化版本判断可升级,而不是字典序", async () => {
    // 字典序会说 "0.10.0" < "0.9.0",让每次跨 x.9 的发布都被判成没有新版。
    const client = { serverVersion: vi.fn().mockResolvedValue({ current: "0.9.0", latest: "0.10.0" }) };
    const result = await createServerOps({ client }).version();
    expect(result.updatable).toBe(true);
    expect(result.current).toBe("0.9.0");
    expect(result.latest).toBe("0.10.0");
  });

  it("预发布版升到正式版算可升级", async () => {
    const client = { serverVersion: vi.fn().mockResolvedValue({ current: "0.4.0-beta.1", latest: "0.4.0" }) };
    expect((await createServerOps({ client }).version()).updatable).toBe(true);
  });

  it("同版本与降级都不算可升级", async () => {
    for (const [current, latest] of [["1.2.3", "1.2.3"], ["1.3.0", "1.2.9"]]) {
      const client = { serverVersion: vi.fn().mockResolvedValue({ current, latest }) };
      const result = await createServerOps({ client }).version();
      expect(result.updatable, `${current} -> ${latest}`).toBe(false);
    }
  });

  it("查不到远端版本时标记 checkFailed 而不是报错", async () => {
    // 离线是常态,不该显示成故障。
    const client = { serverVersion: vi.fn().mockResolvedValue({ current: "1.0.0", latest: null }) };
    const result = await createServerOps({ client }).version();
    expect(result.checkFailed).toBe(true);
    expect(result.updatable).toBe(false);
  });

  it("宿主说 updatable 但语义化比较不同意时,以本地比较为准", async () => {
    // daemon 只做字符串不等判断,会把降级也算成可更新。
    const client = { serverVersion: vi.fn().mockResolvedValue({ current: "2.0.0", latest: "1.0.0", updatable: true }) };
    expect((await createServerOps({ client }).version()).updatable).toBe(false);
  });

  it("restart 原样返回结果,端口没起来也不抛错", async () => {
    // started:false 时用户需要的是日志路径,不是一个异常。
    const payload = { stopped: true, started: false, pid: 123, log: "/tmp/dsh-web.log" };
    const client = { serverRestart: vi.fn().mockResolvedValue(payload) };
    await expect(createServerOps({ client }).restart()).resolves.toEqual(payload);
  });

  it("update 非零退出时抛出 pnpm 的 stderr", async () => {
    const client = { serverUpdate: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "ERR_PNPM_FETCH_404" }) };
    const error = await createServerOps({ client }).update().catch((e) => e);
    expect(error.name).toBe("ServerUpdateError");
    expect(error.message).toBe("ERR_PNPM_FETCH_404");
  });

  it("识别 dsh 不是 pnpm 装的,好给出可执行的下一步", async () => {
    const ops = createServerOps({ client: {} });
    const err = new HostProxyError(HostProxyReason.NOT_PNPM, "not pnpm", 400);
    expect(ops.isNotPnpmInstall(err)).toBe(true);
    expect(ops.isNotPnpmInstall(new HostProxyError(HostProxyReason.FAILED, "x", 500))).toBe(false);
  });
});
