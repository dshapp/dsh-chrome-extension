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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function byUpdatedDesc(a, b) {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}
