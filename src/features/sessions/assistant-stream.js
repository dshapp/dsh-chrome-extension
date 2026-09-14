// 展开 DSH 1.5 内嵌在 durable settlement 里的紧凑 assistant stream。
//
// 对齐 dsh-macapp AssistantStreamExpansion.swift 与宿主的打包端:
//   deepseek-harness/packages/llm/llm/src/assistant-stream.ts (AssistantStreamRecord)
//   deepseek-harness/... (expandAssistantStream)
//
// 1.2 及以前宿主每 token 写一条 assistant/chunk 事件,连续 >=3 条同类被打成
// chunkrow/* 历史记录。1.5 删除了这两者:一次 attempt 现在结算为单条
// assistant/message(或 assistant/attempt),其 stream 字段以与 chunkrow/*
// 逐字节相同的打包形式内嵌整段尝试。所以这里只改容器,成员的语义不变:
//   成员 k 在 time0 + 前 k 个 dt 增量处重建;dt 允许为负(墙钟回拨)。
//   非 run 的记录(字面量 chunk)原样透传。

/// 三种打包类型 → 展开后每个成员的 chunk 类型。
const RUN_CHUNK_TYPES = {
  "text-chunks": "text-delta",
  "reasoning-chunks": "reasoning-delta",
  "tool-call-chunks": "tool-call-delta"
};

const isInt = (value) => Number.isSafeInteger(value);
const isFinite = (value) => typeof value === "number" && Number.isFinite(value);

/// 展开一条 stream 数组(来自 assistant/message、assistant/attempt 的 stream
/// 字段,或 follow snapshot 的 active-attempt baseline)为有序的 [{ time, chunk }]。
///
/// record 两种形状:
///   { type:'chunk', time, chunk }  —— 字面量 chunk
///   { type:'text-chunks'|'reasoning-chunks'|'tool-call-chunks',
///     time0, index, dt, texts|args, id?, name? }  —— 打包 run
///
/// 畸形记录跳过而非猜测:折叠层本就容忍缺失的 delta,durable settlement 仍携带
/// 权威的最终内容兜底。
export function expandAssistantStream(stream) {
  if (!Array.isArray(stream)) return [];
  const out = [];
  for (const record of stream) {
    if (!record || typeof record !== "object") continue;
    const type = record.type;
    if (type === "chunk") {
      const chunk = record.chunk;
      if (chunk != null && isFinite(record.time)) out.push({ time: record.time, chunk });
      continue;
    }
    const chunkType = RUN_CHUNK_TYPES[type];
    if (!chunkType) continue;
    const index = record.index;
    if (!isInt(index) || !isFinite(record.time0)) continue;
    const isToolCall = type === "tool-call-chunks";
    const members = isToolCall ? record.args : record.texts;
    if (!Array.isArray(members) || members.length === 0) continue;
    if (!members.every((m) => typeof m === "string")) continue;
    // 宿主 validateRecord:dt 恰好是相邻成员的时间差(必须 n-1 项)。
    if (!Array.isArray(record.dt) || record.dt.length !== members.length - 1) continue;
    if (!record.dt.every(isInt)) continue;
    const callId = typeof record.id === "string" ? record.id : null;
    const callName = typeof record.name === "string" ? record.name : null;
    let time = record.time0;
    for (let k = 0; k < members.length; k += 1) {
      if (k > 0) time += record.dt[k - 1];
      const chunk = isToolCall
        ? {
            type: chunkType, index, argumentsDelta: members[k],
            ...(callId != null ? { id: callId } : {}),
            ...(callName != null ? { name: callName } : {})
          }
        : { type: chunkType, index, text: members[k] };
      out.push({ time, chunk });
    }
  }
  return out;
}
