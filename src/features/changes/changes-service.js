// 改动文件摘要 / 逐文件对比的读取与缓存(mac TurnChangesStore)。
//
// 记录按"公告事件的 seq"寻址,而不是按 turn:同一 turn 若来了更晚的公告,
// 旧记录就不再可寻址 —— 与宿主替换自己那条记录的口径一致。
//
// 这里的每一次读取都**可能合法地空手而归**:会话被回收后宿主会 404。所以
// "没有"与"有"一样要缓存下来,而不是每帧渲染都去重试一遍;反过来,传输失败
// (宿主重启、断网)不是答案,不写缓存,留给下一次渲染重试。
import { CHANGES_SUMMARY_PATH, CHANGES_DIFF_PATH, decodeChangesSummary, decodeChangesDiff } from "./turn-changes.js";

const SERVED = "served";
const UNAVAILABLE = "unavailable";

export function createChangesService(connection, { onUpdate } = {}) {
  // key → { state, value }
  const summaries = new Map();
  const diffs = new Map();
  const inflight = new Map();

  const summaryKey = (sessionId, seq) => `${sessionId}:${seq}`;
  const diffKey = (sessionId, seq, index) => `${sessionId}:${seq}:${index}`;

  function cached(store, key) {
    const entry = store.get(key);
    return entry?.state === SERVED ? entry.value : null;
  }

  /// 同一条记录只读一次:并发的渲染帧共享同一个 in-flight promise。
  function once(key, run) {
    const pending = inflight.get(key);
    if (pending) return pending;
    const task = run().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  async function read(path, query, decode) {
    const value = await connection.getJson(path, query);
    // 404 → null:宿主不再提供这条记录,是正常的"没东西可展示"。
    if (value == null) return null;
    return decode(value) ?? null;
  }

  const service = {
    /// 已缓存的摘要;还在读、或宿主不再提供时返回 null(两种情况都不画卡)。
    summary(sessionId, seq) {
      if (!sessionId || !Number.isSafeInteger(seq)) return null;
      return cached(summaries, summaryKey(sessionId, seq));
    },
    /// 宿主是否已经明确拒绝提供这条记录(避免无谓重试)。
    isUnavailable(sessionId, seq) {
      return summaries.get(summaryKey(sessionId, seq))?.state === UNAVAILABLE;
    },
    /// 读一次摘要(已读过就直接给缓存)。传输失败不写缓存,交给下一次渲染重试。
    async loadSummary(sessionId, seq) {
      if (!sessionId || !Number.isSafeInteger(seq)) return null;
      const key = summaryKey(sessionId, seq);
      const entry = summaries.get(key);
      if (entry) return entry.state === SERVED ? entry.value : null;
      return once(key, async () => {
        try {
          const value = await read(CHANGES_SUMMARY_PATH, { sessionId, seq }, decodeChangesSummary);
          summaries.set(key, value ? { state: SERVED, value } : { state: UNAVAILABLE });
          if (value) onUpdate?.(sessionId, seq);
          return value;
        } catch {
          return null;
        }
      });
    },
    /// 已缓存的逐文件对比。
    diff(sessionId, seq, index) {
      if (!sessionId || !Number.isSafeInteger(seq) || !Number.isSafeInteger(index)) return null;
      return cached(diffs, diffKey(sessionId, seq, index));
    },
    /// 读一次某个列出文件的对比(index 是它在摘要 files 里的下标)。
    async loadDiff(sessionId, seq, index) {
      if (!sessionId || !Number.isSafeInteger(seq) || !Number.isSafeInteger(index)) return null;
      const key = diffKey(sessionId, seq, index);
      const entry = diffs.get(key);
      if (entry) return entry.state === SERVED ? entry.value : null;
      return once(key, async () => {
        try {
          const value = await read(CHANGES_DIFF_PATH, { sessionId, seq, index }, decodeChangesDiff);
          diffs.set(key, value ? { state: SERVED, value } : { state: UNAVAILABLE });
          return value;
        } catch {
          return null;
        }
      });
    },
    /// 丢弃某个会话的全部记录(会话被归档/删除后)。
    closeSession(sessionId) {
      const prefix = `${sessionId}:`;
      for (const key of [...summaries.keys()]) if (key.startsWith(prefix)) summaries.delete(key);
      for (const key of [...diffs.keys()]) if (key.startsWith(prefix)) diffs.delete(key);
    }
  };
  return service;
}
