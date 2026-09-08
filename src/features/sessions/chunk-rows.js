// 历史里的 chunkrow 打包记录展开成逐条 assistant/chunk 事件。
//
// 对齐 dsh-macapp f9a4eab 的 ChunkRunExpansion,以及宿主的打包端:
//   deepseek-harness/packages/core/session/src/chunk-rows.ts  (packChunkRuns / buildRow)
//   deepseek-harness/packages/api/session-controller/src/history.ts:387 (pageRecords)
//
// 宿主把**连续 >=3 条**同 turn/step/index 的同类 assistant/chunk 打成一条记录,
// session/page 与 session/follow 的 snapshot 两条路径都会打包。记录只保留首个
// seq/time(seq0/time0),其余成员由 dt 增量与 texts/args 数组还原 —— 也就是说
// 它实际占据 seq0 .. seq0+n-1 这一整段日志位置。
//
// 不展开会同时坏两件事:
//   1. 内容:整段流式文本/reasoning/tool-call 参数在转录里缺失(未结算的 step
//      尤其明显,因为它没有最终 message 来兜底覆写);
//   2. 协议:lastSeq 只到 seq0,而 snapshot.cursor 是真实日志尾,于是下一条实时
//      帧被判成缺口 → 拉 session/page → 回包又是同样的打包记录 → 缺口永不收敛,
//      每条实时帧都触发一次 HTTP 分页。
//
// 解码保持保守:形状不可信(dt 长度与成员数不符、texts/args 不是数组等)就原样
// 返回,让上层按未知事件处理,而不是猜一个时间戳或伪造 seq。

/// 三种打包类型 → 展开后每个成员的 chunk 类型。
const RUN_KINDS = {
  "chunkrow/text-chunks": "text-delta",
  "chunkrow/reasoning-chunks": "reasoning-delta",
  "chunkrow/tool-call-chunks": "tool-call-delta"
};

const isInt = (value) => Number.isSafeInteger(value);

/// 打包记录里承载成员正文的数组:文本类是 texts,tool-call 是 args。
function membersOf(type, data) {
  const list = type === "chunkrow/tool-call-chunks" ? data.args : data.texts;
  return Array.isArray(list) ? list : null;
}

/// 该事件是否是一条**可信**的 chunkrow 打包记录。
/// 与宿主 classify() 同样做结构校验而非类型信任:历史既来自实时 append,
/// 也可能来自解析出的夹具文件。
export function isChunkRun(event) {
  if (!event || typeof event !== "object") return false;
  const kind = RUN_KINDS[event.type];
  if (!kind) return false;
  const data = event.data;
  if (!data || typeof data !== "object") return false;
  if (!isInt(event.seq) || event.seq < 0 || !isInt(event.time)) return false;
  if (typeof data.turn !== "number" || typeof data.step !== "number") return false;
  if (typeof data.index !== "number") return false;
  const members = membersOf(event.type, data);
  if (!members || members.length === 0) return false;
  if (!members.every((item) => typeof item === "string")) return false;
  // dt 恰好是相邻成员的时间差,故必须是 n-1 项且全为安全整数。
  if (!Array.isArray(data.dt) || data.dt.length !== members.length - 1) return false;
  if (!data.dt.every(isInt)) return false;
  if (event.type === "chunkrow/tool-call-chunks" && typeof data.id !== "string") return false;
  return true;
}

/// 把一条打包记录展开成 n 条 assistant/chunk 事件。
///
/// seq 与 time 按宿主的编码逐成员还原:第 k 个成员的 seq 是 seq0+k,
/// time 是 time0 加上前 k 个 dt 之和。
export function expandChunkRun(event) {
  const kind = RUN_KINDS[event.type];
  const { turn, step, index, dt } = event.data;
  const members = membersOf(event.type, event.data);
  const events = [];
  let time = event.time;
  for (let k = 0; k < members.length; k += 1) {
    if (k > 0) time += dt[k - 1];
    const chunk = kind === "tool-call-delta"
      ? {
        type: kind, index, id: event.data.id,
        // name 只出现在这一段的首个 delta 上(宿主要求整段的 name 一致),
        // 保持同样的形状:让下游对"首个 delta 带 name"的假设继续成立。
        ...(k === 0 && typeof event.data.name === "string" ? { name: event.data.name } : {}),
        argumentsDelta: members[k]
      }
      : { type: kind, index, text: members[k] };
    events.push({
      type: "assistant/chunk",
      seq: event.seq + k,
      time,
      data: { turn, step, chunk }
    });
  }
  return events;
}

/// 历史记录的解码边界:打包记录展开成多条,其余原样透传。
/// 返回的每一项都保留原 entry 的 view(展开出的成员共享同一个 view)。
export function expandHistoryEntry(entry) {
  const event = entry?.event;
  if (!isChunkRun(event)) return [entry];
  return expandChunkRun(event).map((expanded) => ({ ...entry, event: expanded }));
}
