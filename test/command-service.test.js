import { describe, it, expect, vi } from "vitest";
import { createCommandService } from "../src/features/commands/command-service.js";

describe("command-service", () => {
  it("refresh 传 endpoint 参数并缓存结果", async () => {
    const call = vi.fn().mockResolvedValue([
      { name: "compact", description: "Compact older conversation history" },
      { name: "goal", description: "Set the session goal", input: { hint: "<text>" } }
    ]);
    const service = createCommandService({ call });
    const result = await service.refresh("session-1");
    expect(call).toHaveBeenCalledWith("commands/list", { agentId: "session-1" });
    expect(result).toHaveLength(2);
    expect(service.commands).toBe(result);
  });

  it("sessionId 为空时不调用 RPC,直接返回当前缓存", async () => {
    const call = vi.fn();
    const service = createCommandService({ call });
    const result = await service.refresh(null);
    expect(call).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("execute 必须带上 images(缺字段会被 Typert 网关整体拒绝)", async () => {
    const call = vi.fn().mockResolvedValue({ commandId: "c1", result: { kind: "success" } });
    const service = createCommandService({ call });
    const execution = await service.execute("session-1", "/compact");
    // 真实网关按描述符逐字段校验:少 images 会报
    // 'args fields do not match the descriptor: missing "images"',每条斜杠命令都失败。
    expect(call).toHaveBeenCalledWith("commands/execute", {
      agentId: "session-1", line: "/compact", images: []
    });
    expect(execution).toEqual({ commandId: "c1", result: { kind: "success" } });
  });

  it("execute 可携带 composer 图片", async () => {
    const call = vi.fn().mockResolvedValue({});
    const service = createCommandService({ call });
    const images = [{ data: "AAA", mediaType: "image/png" }];
    await service.execute("session-1", "/compact", images);
    expect(call).toHaveBeenCalledWith("commands/execute", {
      agentId: "session-1", line: "/compact", images
    });
  });
});
