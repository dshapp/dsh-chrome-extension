// 对齐 dsh-macapp f9a4eab 的 chunkrow 展开(ChunkRunExpansion)。
//
// 宿主把历史里连续 >=3 条同类 assistant/chunk 打包成**一条** chunkrow 记录:
//   deepseek-harness/packages/core/session/src/chunk-rows.ts:100  MIN_RUN = 3
//   .../api/session-controller/src/history.ts:387 pageRecords()
// 且 session/page(:92)与 session/follow 的 snapshot(:154)**两条路径**都打包。
//
// 打包记录只带首个 seq(seq0)与首个 time(time0),其余成员靠 dt 增量与
// texts/args 数组还原 —— 它实际占据 seq0..seq0+n-1 这一段日志位置。
//
// 扩展此前既不认 chunkrow/*(route 落到 default → applyUnknownSurface,而它
// 没有 surfaceOp 于是被整条丢弃),也不知道它占了多个 seq,于是:
//   1. 中途打开会话时,流式文本/reasoning/tool-call 参数整段缺失;
//   2. lastSeq 只推进到 seq0,而 snapshot.cursor 是真实日志尾 —— 下一条实时帧
//      就被判成缺口,触发 session/page;回包又是同样的打包记录,缺口永不收敛,
//      于是**每条实时帧都拉一次 HTTP 分页**。
import { describe, expect, it, vi } from "vitest";
import { createSessionService } from "../src/features/sessions/session-service.js";
import { isChunkRun, expandChunkRun } from "../src/features/sessions/chunk-rows.js";

/// 真实流里 delta 之前必有 block-start 分配块槽位(见 session-store applyStreamChunk),
/// 夹具照此构造,否则 delta 会因为没有槽位而被丢弃 —— 那是渲染层的既有约定,
/// 不是本次要验证的展开逻辑。
const blockStart = (seq, time, blockType, { turn = 1, step = 0, index = 0 } = {}) => ({
  type: "event",
  event: {
    type: "assistant/chunk", seq, time,
    data: { turn, step, chunk: { type: "block-start", index, blockType } }
  }
});

const textRun = (seq0, time0, texts, { turn = 1, step = 0, index = 0 } = {}) => ({
  type: "chunks",
  event: {
    type: "chunkrow/text-chunks", seq: seq0, time: time0,
    data: { turn, step, index, dt: texts.slice(1).map(() => 10), texts }
  }
});

const toolRun = (seq0, time0, args, { turn = 1, step = 0, index = 0, id = "call-1", name = "bash" } = {}) => ({
  type: "chunks",
  event: {
    type: "chunkrow/tool-call-chunks", seq: seq0, time: time0,
    data: { turn, step, index, dt: args.slice(1).map(() => 5), id, name, args }
  }
});

function service() {
  const call = vi.fn().mockResolvedValue({});
  const svc = createSessionService({ call, subscribe: vi.fn(), unsubscribe: vi.fn() });
  return { svc, call };
}

/// 装一份 follow snapshot,内容由调用方给定。
async function loadSnapshot(svc, records, cursor) {
  await svc.open("s1");
  svc.handleMuxFrame({
    streamId: "follow:s1", type: "item",
    value: { type: "snapshot", cursor, records }
  });
}

describe("chunkrow 打包记录的展开", () => {
  it("文本打包记录被展开成逐条 chunk,正文完整可见", async () => {
    const { svc } = service();
    await loadSnapshot(svc, [
      { type: "event", event: { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } } },
      { type: "event", event: { type: "step/start", seq: 1, time: 1000, data: { turn: 1, step: 0 } } },
      blockStart(2, 1000, "text"),
      textRun(3, 1000, ["Hel", "lo ", "world"])
    ], 5);
    const snap = svc.getRuntimeSnapshot();
    const text = JSON.stringify(snap.nodes);
    expect(text).toContain("Hello world");
  });

  it("lastSeq 推进到整段的末尾(seq0+n-1),而不是只到 seq0", async () => {
    const { svc } = service();
    // 一条 3 成员的打包记录从 seq=2 起,占据 2、3、4。
    await loadSnapshot(svc, [textRun(2, 1000, ["a", "b", "c"])], 4);
    expect(svc.getRuntimeSnapshot().lastSeq).toBe(4);
  });

  it("展开后紧接的实时帧不再被误判成缺口,不会触发 session/page", async () => {
    const { svc, call } = service();
    await loadSnapshot(svc, [
      { type: "event", event: { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } } },
      { type: "event", event: { type: "step/start", seq: 1, time: 1000, data: { turn: 1, step: 0 } } },
      blockStart(2, 1000, "text"),
      textRun(3, 1000, ["a", "b", "c"])
    ], 5);
    call.mockClear();
    // 日志尾是 5(打包段占 3、4、5),所以下一条实时事件是 seq=6:连续,不该修缺口。
    svc.handleMuxFrame({
      streamId: "follow:s1", type: "item",
      value: { type: "entry", event: { type: "assistant/chunk", seq: 6, time: 1100,
        data: { turn: 1, step: 0, chunk: { type: "text-delta", index: 0, text: "!" } } } }
    });
    const pagedCalls = call.mock.calls.filter(([method]) => method === "session/page");
    expect(pagedCalls).toHaveLength(0);
  });

  // tool-call 段直接断言展开器本身:一条打包记录 → n 条 tool-call-delta,
  // 参数分片按序还原、seq 逐一递增、name 只落在首个 delta(与宿主编码一致)。
  //
  // 不经 store 断言渲染结果,是因为 store 的 tool-call 槽位要等 tool/call 事件
  // 才拿到 callId(assistantHasVisibleContent 以 callId 为门槛),没有 callId 的
  // 槽位不成行 —— 这对逐条实时 delta 同样成立,与本次展开无关。
  it("tool-call 打包记录展开成逐条 delta,参数分片按序还原", () => {
    const run = toolRun(3, 1000, ['{"cm', 'd":"ls', '"}']).event;
    expect(isChunkRun(run)).toBe(true);
    const events = expandChunkRun(run);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(events.map((e) => e.data.chunk.argumentsDelta).join(""))
      .toBe('{"cmd":"ls"}');
    // name 只在首个 delta 上,后续沿用同一 id。
    expect(events[0].data.chunk.name).toBe("bash");
    expect(events.slice(1).every((e) => !("name" in e.data.chunk))).toBe(true);
    expect(events.every((e) => e.data.chunk.id === "call-1")).toBe(true);
  });

  it("reasoning 打包记录同样展开", async () => {
    const { svc } = service();
    await loadSnapshot(svc, [
      { type: "event", event: { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } } },
      { type: "event", event: { type: "step/start", seq: 1, time: 1000, data: { turn: 1, step: 0 } } },
      blockStart(2, 1000, "reasoning"),
      { type: "chunks", event: { type: "chunkrow/reasoning-chunks", seq: 3, time: 1000,
        data: { turn: 1, step: 0, index: 0, dt: [10, 10], texts: ["thin", "king", " hard"] } } }
    ], 5);
    expect(JSON.stringify(svc.getRuntimeSnapshot().nodes)).toContain("thinking hard");
  });

  it("dt 长度与成员数不符时原样保留,不猜测时间戳", async () => {
    const { svc } = service();
    // dt 应有 n-1 项;这里给错,属于不可信编码。
    await loadSnapshot(svc, [
      { type: "chunks", event: { type: "chunkrow/text-chunks", seq: 2, time: 1000,
        data: { turn: 1, step: 0, index: 0, dt: [10], texts: ["a", "b", "c"] } } }
    ], 4);
    // 不展开也不得崩溃。
    expect(svc.getRuntimeSnapshot()).toBeTruthy();
  });
});
