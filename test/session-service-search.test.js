import { describe, expect, it, vi } from "vitest";
import { createSessionService } from "../src/features/sessions/session-service.js";

function serviceWith(error) {
  return createSessionService({
    call: vi.fn().mockRejectedValue(error),
    subscribe: vi.fn(),
    unsubscribe: vi.fn()
  });
}

describe("session search 降级", () => {
  it.each(["internal", "gateway/internal"])("%s 的索引关闭错误返回 null", async (code) => {
    const service = serviceWith(Object.assign(
      new Error('session search failed: SessionQueryError: session search is disabled: openAt "never"'),
      { code }
    ));
    await expect(service.search("plan")).resolves.toBeNull();
  });

  it("其他 internal 错误仍向上抛出", async () => {
    const error = Object.assign(new Error("database unavailable"), { code: "gateway/internal" });
    await expect(serviceWith(error).search("plan")).rejects.toBe(error);
  });
});
