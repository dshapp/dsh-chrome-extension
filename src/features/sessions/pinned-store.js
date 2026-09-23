// 会话置顶账本(浏览器本地)。
//
// 从 macOS Stores.swift 的 pinnedSessionOrder / setPinned / pinnedOrder(of:) /
// reorderPinned 照搬,包括那边写下的两条理由:
//
// 1. **宿主没有"置顶"这个概念。** workspace 控制器只提供 create/rename/delete/
//    insertBefore/insertSessionBefore/archiveSession,所以置顶和手动顺序一样,
//    是"我这台机器上我习惯的样子",记在 chrome.storage.local 里,不上报宿主。
// 2. **用数组而不是 Set。** 置顶区按"先置顶的在上"稳定渲染,而且它自己还能被
//    拖动重排 —— 这两件事 Set 都表达不了。
//
// 与 session-order-store 同一套存储路数(同前缀的 key、读不到就空账本、
// 写失败只影响下次启动),两者互不干扰:置顶只改本账本,手动序只改那一本。

//
// 0.1.7 起宿主有了置顶(workspace/pinSession / unpinSession,集合随 workspace/follow
// 的 baseline.pinnedSessionIds 与 pinned 帧广播,**最近置顶的在前**)。宿主一旦
// 给过置顶集合(applyHost),本账本就切到宿主模式:
//   - 顺序以宿主为准,不再写 storage;
//   - setPinned 乐观更新后调 RPC,回包的全量集合覆盖本地,失败回滚并交给 onError;
//   - 宿主没有置顶区内的重排接口,reorder 在宿主模式下不生效。
// 老宿主(≤0.1.6)不带这个字段,账本保持原来的浏览器本地模式。
//
// 首次进入宿主模式时,把本地账本里的置顶一次性迁到宿主(迁完打标,不再重复)。

const STORAGE_KEY = "dsh_pinned_session_order";
const MIGRATED_KEY = "dsh_pinned_session_order_migrated";

async function resolveArea() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage.local;
  const { chromeShim } = await import("../../platform/storage/chrome-shim.js");
  return chromeShim.storage.local;
}

export function createPinnedStore({ connection = null, rpc = null, onError: initialOnError = null } = {}) {
  let onError = initialOnError;
  /// 置顶的会话 id。本地模式按置顶先后;宿主模式按宿主顺序(最近置顶在前)。
  let order = [];
  /// 宿主是否给过置顶集合。
  let hostBacked = false;
  let migrationStarted = false;
  /// 在途写的代际:只有最后一次写的回包能落地,避免连点时旧回包覆盖新状态。
  let writeGeneration = 0;
  /// 成员判定用的集合:行要问"我是不是置顶"的次数远多于顺序本身的变化。
  let members = new Set();
  let loaded = false;
  const listeners = new Set();

  function reindex() {
    members = new Set(order);
  }

  function notify() {
    for (const listener of listeners) listener(order);
  }

  function assign(next) {
    const ids = (next ?? []).filter((id) => typeof id === "string");
    if (ids.length === order.length && ids.every((id, index) => id === order[index])) return false;
    order = ids;
    reindex();
    notify();
    return true;
  }

  async function hostWrite(sessionId, pinned, previous) {
    const generation = ++writeGeneration;
    try {
      const value = await connection.call(pinned ? rpc.workspacePinSession : rpc.workspaceUnpinSession,
        { request: { sessionId } });
      if (generation === writeGeneration && Array.isArray(value?.pinnedSessionIds)) assign(value.pinnedSessionIds);
    } catch (error) {
      if (generation === writeGeneration) assign(previous);
      onError?.(error);
    }
  }

  /// 本地账本 → 宿主的一次性迁移。按本地顺序倒着置顶,宿主"最近在前"的
  /// 结果就与原来"先置顶的在上"一致。
  async function migrateLocal() {
    if (migrationStarted || !connection || !rpc) return;
    migrationStarted = true;
    try {
      const area = await resolveArea();
      const value = await area.get([STORAGE_KEY, MIGRATED_KEY]);
      if (value?.[MIGRATED_KEY]) return;
      const local = Array.isArray(value?.[STORAGE_KEY]) ? value[STORAGE_KEY].filter((id) => typeof id === "string") : [];
      for (const id of [...local].reverse()) {
        if (members.has(id)) continue;
        try {
          const settled = await connection.call(rpc.workspacePinSession, { request: { sessionId: id } });
          if (Array.isArray(settled?.pinnedSessionIds)) assign(settled.pinnedSessionIds);
        } catch { /* 会话可能已被删除,跳过 */ }
      }
      await area.set({ [MIGRATED_KEY]: true });
    } catch { /* 迁移失败下次启动再试 */ migrationStarted = false; }
  }

  async function persist() {
    if (hostBacked) return;
    try {
      const area = await resolveArea();
      await area.set({ [STORAGE_KEY]: order });
    } catch {
      // 存不下只影响"下次启动还记不记得",本次的置顶已经在内存里生效了。
    }
  }

  return {
    /// 从 storage 读回账本。启动时调一次;失败以空账本开始(没有置顶区)。
    async load() {
      if (loaded || hostBacked) return order;
      loaded = true;
      try {
        const area = await resolveArea();
        const value = await area.get([STORAGE_KEY]);
        const stored = value?.[STORAGE_KEY];
        // 读 storage 期间宿主集合可能已经到了:宿主为准,不再用本地账本覆盖。
        if (Array.isArray(stored) && !hostBacked) {
          order = stored.filter((id) => typeof id === "string");
          reindex();
        }
      } catch { /* 读不到就用空账本 */ }
      return order;
    },

    get order() { return order; },
    /// 是否由宿主保存置顶(0.1.7+)。宿主模式下置顶区不能拖动重排。
    get hostBacked() { return hostBacked; },
    /// 宿主写失败(已回滚)时的回调,侧栏用它弹 toast。
    setErrorHandler(handler) { onError = typeof handler === "function" ? handler : null; },

    /// 宿主给出的完整置顶集合(workspace/follow baseline 或 pinned 帧)。
    /// null/非数组表示老宿主没有置顶概念,保持本地模式。
    applyHost(ids) {
      if (!Array.isArray(ids)) return;
      hostBacked = true;
      // 在途写期间的广播也按全量处理:宿主集合是权威。
      assign(ids);
      void migrateLocal();
    },
    isPinned: (sessionId) => members.has(sessionId),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /**
     * 置顶/取消置顶一个会话。两个方向都幂等;置顶是**追加**,
     * 所以置顶区保持"先置顶的在上"。
     *
     * @param {string} sessionId 目标会话。
     * @param {boolean} pinned 是否置顶。
     * @returns {boolean} 账本是否真的变了。
     */
    setPinned(sessionId, pinned) {
      if (!sessionId) return false;
      if (hostBacked && connection && rpc) {
        if (pinned === members.has(sessionId)) return false;
        const previous = order;
        assign(pinned ? [sessionId, ...order] : order.filter((id) => id !== sessionId));
        void hostWrite(sessionId, pinned, previous);
        return true;
      }
      if (pinned) {
        if (members.has(sessionId)) return false;
        order = [...order, sessionId];
      } else {
        if (!members.has(sessionId)) return false;
        order = order.filter((id) => id !== sessionId);
      }
      reindex();
      void persist();
      notify();
      return true;
    },

    /**
     * 从一个可见子集里解出置顶区的行,按置顶顺序。
     *
     * 交集安全:账本里还留着、但名册里已经没有的 id 直接跳过 —— 不去复活
     * 一个已经消失的会话,也不因此把它从账本里删掉(它可能只是被过滤掉了)。
     *
     * @param {Array} visible 可见行。
     * @returns {Array} 置顶行,按置顶顺序。
     */
    pinnedRows(visible) {
      if (!order.length) return [];
      const byId = new Map((visible ?? []).map((item) => [item.sessionId, item]));
      return order.map((id) => byId.get(id)).filter(Boolean);
    },

    /**
     * 置顶区内部的一次拖放。只改写置顶账本,手动顺序那本纹丝不动。
     *
     * @param {string} movedId 被拖动的会话。
     * @param {string|null} beforeId 插到谁前面;null 表示末尾。
     * @returns {boolean} 账本是否真的变了。
     */
    reorder(movedId, beforeId) {
      if (hostBacked) return false;
      if (!movedId || movedId === beforeId || !members.has(movedId)) return false;
      const next = order.filter((id) => id !== movedId);
      const at = beforeId == null ? -1 : next.indexOf(beforeId);
      if (at === -1) next.push(movedId);
      else next.splice(at, 0, movedId);
      if (next.every((id, index) => id === order[index]) && next.length === order.length) return false;
      order = next;
      reindex();
      void persist();
      notify();
      return true;
    }
  };
}
