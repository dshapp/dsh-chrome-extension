import { describe, it, expect, vi, beforeAll } from "vitest";
import { createSessionService } from "../src/features/sessions/session-service.js";
import { RPC, STREAM } from "../src/platform/dsh/rpc-methods.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));

function userEvent(seq, text) {
  return {
    event: {
      type: "user/message",
      seq,
      time: 1000 + seq,
      data: { id: `m${seq}`, content: [{ type: "text", text }], source: { kind: "user" } }
    },
    view: {}
  };
}

function makeService() {
  const connection = {
    call: vi.fn().mockResolvedValue({ records: [], hasMore: false }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn()
  };
  return { service: createSessionService(connection), connection };
}

describe("service 轨迹前翻页", () => {
  it("follow 快照记录左边界与 hasMore", async () => {
    const { service } = makeService();
    await service.open("s1");
    service.handleMuxFrame({
      streamId: "follow:s1",
      type: "item",
      value: { type: "snapshot", cursor: 10, records: [userEvent(5, "第五"), userEvent(6, "第六")], hasMore: true }
    });
    expect(service.hasMoreHistory("s1")).toBe(true);
    expect(service.store.getTrajectory().records.map((record) => record.previewMarkdown)).toEqual(["第五", "第六"]);
  });

  it("loadEarlier 带 beforeSeq 取更早一页并归并", async () => {
    const { service, connection } = makeService();
    await service.open("s1");
    service.handleMuxFrame({
      streamId: "follow:s1",
      type: "item",
      value: { type: "snapshot", cursor: 10, records: [userEvent(5, "第五")], hasMore: true }
    });
    connection.call.mockResolvedValueOnce({
      records: [userEvent(3, "第三"), userEvent(4, "第四")],
      hasMore: false
    });
    await service.loadEarlier("s1");
    expect(connection.call).toHaveBeenCalledWith(RPC.sessionPage, {
      request: {
        address: { kind: "session", sessionId: "s1" },
        throughSeq: 10,
        beforeSeq: 5,
        maxMessages: 50
      }
    });
    expect(service.store.getTrajectory().records.map((record) => record.previewMarkdown))
      .toEqual(["第三", "第四", "第五"]);
    expect(service.hasMoreHistory("s1")).toBe(false);
  });

  it("没有更早历史时不发请求", async () => {
    const { service, connection } = makeService();
    await service.open("s1");
    service.handleMuxFrame({
      streamId: "follow:s1",
      type: "item",
      value: { type: "snapshot", cursor: 10, records: [userEvent(5, "第五")], hasMore: false }
    });
    expect(await service.loadEarlier("s1")).toBeNull();
    expect(connection.call).not.toHaveBeenCalled();
  });

  it("跳页后清掉旧左边界", async () => {
    const { service } = makeService();
    await service.open("s1");
    service.handleMuxFrame({
      streamId: "follow:s1",
      type: "item",
      value: { type: "snapshot", cursor: 10, records: [userEvent(5, "第五")], hasMore: true }
    });
    await service.loadThrough("s1", 5);
    expect(service.hasMoreHistory("s1")).toBe(false);
  });
});

describe("service follow 订阅", () => {
  it("open 订阅 follow 流", async () => {
    const { service, connection } = makeService();
    await service.open("s1");
    expect(connection.subscribe).toHaveBeenCalledWith("follow:s1", STREAM.follow, expect.any(Object));
  });
});
