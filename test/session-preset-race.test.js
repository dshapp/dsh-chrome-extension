import { describe, expect, it, vi } from "vitest";
import { createSessionService } from "../src/features/sessions/session-service.js";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("agent preset 应用竞态", () => {
  it("同一会话的快速选择严格按调用顺序发给宿主，最新选择胜出", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const call = vi.fn()
      .mockImplementationOnce(() => firstGate.promise)
      .mockImplementationOnce(() => secondGate.promise);
    const service = createSessionService({ call, subscribe: vi.fn(), unsubscribe: vi.fn() });
    await service.open("s1");

    const first = service.selectAgentPreset("s1", "first");
    const second = service.selectAgentPreset("s1", "second");
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    firstGate.resolve("first");
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    secondGate.resolve("second");
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(service.getRuntimeSnapshot().agentPreset).toBe("second");
    expect(service.listStore.get().find((row) => row.sessionId === "s1")?.agentPreset).toBe("second");
  });

  it("会话移除后不发送排队的选择，也不采纳在途回包", async () => {
    const gate = deferred();
    const call = vi.fn().mockReturnValue(gate.promise);
    const service = createSessionService({ call, subscribe: vi.fn(), unsubscribe: vi.fn() });
    await service.open("gone");
    const first = service.selectAgentPreset("gone", "first");
    const second = service.selectAgentPreset("gone", "second");
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    service.handleHostFrame({ payload: { type: "host/session-removed", sessionId: "gone" } });
    gate.resolve("first");
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(service.getRuntimeSnapshot().agentPreset).toBeNull();
  });
});
