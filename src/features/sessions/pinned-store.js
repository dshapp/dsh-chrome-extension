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

const STORAGE_KEY = "dsh_pinned_session_order";

async function resolveArea() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage.local;
  const { chromeShim } = await import("../../platform/storage/chrome-shim.js");
  return chromeShim.storage.local;
}

export function createPinnedStore() {
  /// 置顶的会话 id,按置顶先后。
  let order = [];
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

  async function persist() {
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
      if (loaded) return order;
      loaded = true;
      try {
        const area = await resolveArea();
        const value = await area.get([STORAGE_KEY]);
        const stored = value?.[STORAGE_KEY];
        if (Array.isArray(stored)) {
          order = stored.filter((id) => typeof id === "string");
          reindex();
        }
      } catch { /* 读不到就用空账本 */ }
      return order;
    },

    get order() { return order; },
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
