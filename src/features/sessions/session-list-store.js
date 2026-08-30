// 会话列表 store:session.list 基线 + host 帧(host/session-added、host/session-status、
// host/workspace-changed)增量维护。
export function createSessionListStore() {
  let summaries = [];
  const listeners = new Set();
  // 挂起请求与草稿按会话单独记,而不是塞进 summary:
  // 这两样的权威来源是实时帧和输入框,不是 session.list 的基线快照 ——
  // 一次 replaceAll 不该把它们冲掉(对齐 macOS 的 listStore)。
  //
  // 集合负责「有没有卡住」,kind 表负责「叫什么名字」:早于 kind 表写入的
  // 标记(或丢了细节的重放帧)仍按 approval 上报 —— 那是阻塞最硬的一种。
  const awaitingKinds = new Map();
  const draftSessionIds = new Set();
  // sessionId → summary 索引表。侧栏行状态/标题/活跃排序是每帧事件驱动的,
  // 之前都用 summaries.find(...) 线性查找,会话一多就成了 O(n²) 热点。
  const byId = new Map();
  // 子代理名册缓存:每次写 summaries 都换新数组引用,用引用判断失效,名册变化才重建。
  let subagentCache = null;
  let subagentCacheFor = null;

  function notify() {
    for (const listener of listeners) listener(summaries);
  }

  function upsert(summary) {
    const existing = byId.get(summary.sessionId);
    if (!existing) {
      summaries = [...summaries, summary];
      byId.set(summary.sessionId, summary);
      return;
    }
    const merged = { ...existing, ...summary };
    const index = summaries.indexOf(existing);
    const next = summaries.slice();
    next[index] = merged;
    summaries = next;
    byId.set(summary.sessionId, merged);
  }

  return {
    replaceAll(items) {
      summaries = [...(items ?? [])].sort(byUpdatedDesc);
      byId.clear();
      for (const item of summaries) byId.set(item.sessionId, item);
      notify();
    },
    upsertAndNotify(summary) {
      upsert(summary);
      notify();
    },
    setStatus(sessionId, running) {
      const target = byId.get(sessionId);
      if (target && target.running !== running) {
        upsert({ ...target, running });
        notify();
      }
    },
    /// 后台会话来了新的用户消息:更新活跃时间并重排,让列表顺序与
    /// 「谁最近在动」一致(对齐 macOS 丢帧修复保留的 recordActivity 偷看)。
    /// 不在列表里的会话忽略 —— host/session-added 或下次 refreshList 会补上。
    recordActivity(sessionId, updatedAt = Date.now()) {
      const target = byId.get(sessionId);
      if (!target) return;
      if ((target.updatedAt ?? 0) >= updatedAt) return;
      upsert({ ...target, updatedAt });
      summaries = [...summaries].sort(byUpdatedDesc);
      notify();
    },
    /// 后台会话的标题投影:写进 summary 的 projections.values.title ——
    /// 与 session.list 基线同形状,列表行读的就是这个位置。
    setTitle(sessionId, title) {
      const target = byId.get(sessionId);
      if (!target) return;
      if (target.projections?.values?.title === title) return;
      upsert({
        ...target,
        projections: {
          ...target.projections,
          values: { ...target.projections?.values, title }
        }
      });
      notify();
    },
    remove(sessionId) {
      summaries = summaries.filter((item) => item.sessionId !== sessionId);
      byId.delete(sessionId);
      awaitingKinds.delete(sessionId);
      draftSessionIds.delete(sessionId);
      notify();
    },
    /// 记录/清除某个会话的挂起请求。kind 传 null 表示已解决。
    setAwaitingUser(sessionId, kind) {
      if (!sessionId) return;
      const previous = awaitingKinds.get(sessionId) ?? null;
      if (previous === (kind ?? null)) return;
      if (kind) awaitingKinds.set(sessionId, kind);
      else awaitingKinds.delete(sessionId);
      notify();
    },
    awaitingUser: (sessionId) => awaitingKinds.get(sessionId) ?? null,
    /// 记录某个会话的输入框是否有未发送文字。
    setDraft(sessionId, hasDraft) {
      if (!sessionId) return;
      const had = draftSessionIds.has(sessionId);
      if (had === Boolean(hasDraft)) return;
      if (hasDraft) draftSessionIds.add(sessionId);
      else draftSessionIds.delete(sessionId);
      notify();
    },
    hasDraft: (sessionId) => draftSessionIds.has(sessionId),
    get: () => summaries,
    /// origin == "subagent" 的边,按 parentSessionId 分组(对齐 Mac subagentChildren)。
    subagentChildren() {
      if (subagentCacheFor !== summaries) {
        subagentCache = indexSubagentChildren(summaries);
        subagentCacheFor = summaries;
      }
      return subagentCache;
    },
    /// rootId 的整条子代理后裔统计(count + runningCount),visited 防环、普通 fork 停下。
    subagentDescendants(rootId) {
      if (subagentCacheFor !== summaries) {
        subagentCache = indexSubagentChildren(summaries);
        subagentCacheFor = summaries;
      }
      return walkSubagentChildren(subagentCache, rootId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function byUpdatedDesc(a, b) {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

// ---------- 子代理名册派生 ----------

/// 仅保留 origin == "subagent" 的边(对齐 Mac SubagentChildren 的 stop-at-fork 规则)。
/// @returns Map<parentSessionId, SessionSummary[]>
export function indexSubagentChildren(summaries) {
  const byParent = new Map();
  for (const s of summaries ?? []) {
    if (s.origin !== "subagent") continue;
    const parent = s.parentSessionId;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(s);
  }
  return byParent;
}

/// 从已分组的父映射 walk 出 count/runningCount。visited 防环、子代理在普通 fork 边处停下。
/// @param byParent Map<parentSessionId, SessionSummary[]>
export function walkSubagentChildren(byParent, rootId) {
  const result = { count: 0, runningCount: 0 };
  if (!rootId || !byParent) return result;
  const visited = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.pop();
    for (const child of byParent.get(parent) ?? []) {
      if (visited.has(child.sessionId)) continue;
      visited.add(child.sessionId);
      result.count += 1;
      if (child.running) result.runningCount += 1;
      queue.push(child.sessionId);
    }
  }
  return result;
}

/// 一次性索引 + walk 的组合入口(单测/无缓存的调用方直接从这里拿)。
export function indexSubagentDescendants(summaries, rootId) {
  return walkSubagentChildren(indexSubagentChildren(summaries), rootId);
}
