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

  function notify() {
    for (const listener of listeners) listener(summaries);
  }

  function upsert(summary) {
    const index = summaries.findIndex((item) => item.sessionId === summary.sessionId);
    if (index === -1) {
      summaries = [...summaries, summary];
    } else {
      summaries = summaries.map((item, i) => (i === index ? { ...item, ...summary } : item));
    }
  }

  return {
    replaceAll(items) {
      summaries = [...(items ?? [])].sort(byUpdatedDesc);
      notify();
    },
    upsertAndNotify(summary) {
      upsert(summary);
      notify();
    },
    setStatus(sessionId, running) {
      const target = summaries.find((item) => item.sessionId === sessionId);
      if (target && target.running !== running) {
        upsert({ ...target, running });
        notify();
      }
    },
    /// 后台会话来了新的用户消息:更新活跃时间并重排,让列表顺序与
    /// 「谁最近在动」一致(对齐 macOS 丢帧修复保留的 recordActivity 偷看)。
    /// 不在列表里的会话忽略 —— host/session-added 或下次 refreshList 会补上。
    recordActivity(sessionId, updatedAt = Date.now()) {
      const target = summaries.find((item) => item.sessionId === sessionId);
      if (!target) return;
      if ((target.updatedAt ?? 0) >= updatedAt) return;
      upsert({ ...target, updatedAt });
      summaries = [...summaries].sort(byUpdatedDesc);
      notify();
    },
    /// 后台会话的标题投影:写进 summary 的 projections.values.title ——
    /// 与 session.list 基线同形状,列表行读的就是这个位置。
    setTitle(sessionId, title) {
      const target = summaries.find((item) => item.sessionId === sessionId);
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
