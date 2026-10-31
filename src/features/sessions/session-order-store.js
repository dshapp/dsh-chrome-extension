// 会话列表的手动顺序账本(浏览器本地)。
//
// 从 macOS Stores.swift 的 flatManualOrder / manualOrder(of:) / reorderWithinSubset
// 照搬,包括几条踩过的坑:
//
// 1. **只走可见子集,不扫全账本。** 账本随会话数只增不减,可能积累了几年的 id;
//    而一次读取只需要给眼前这几十行排序。所以维护一张 id → 位置 的索引,
//    在账本变更时重建(罕见写),而不是每次读时线性扫(频繁读)。
//
// 2. **交集安全。** 账本里不在当前子集的 id 静默跳过;重排只改写子集**占据的
//    那些槽位**,子集之外的相对顺序纹丝不动。这样在"某个工作目录"里拖一下,
//    不会把"全部"视图里其他会话的顺序搅乱。
//
// 3. **没记录过的排在最前。** 从没被摆过位置的会话(典型:拖过之后才新建的会话)
//    按时间倒序排在账本行**之前**。与 Mac / Web(reconcileManualOrder)不同,
//    它们把这批追加在末尾 —— 但扩展的单列表有 FLAT_ROW_LIMIT 渲染上限,而
//    reorder() 第一次拖动就会把当时整个可见子集(常常上千条)写进账本:之后
//    每个新会话都排在上千条之后、落在上限之外,刚新建、正在跑的会话在列表里
//    直接看不见。新会话出现在顶部,用户拖过它之后它才有自己的手动位置。
//
// 账本存 chrome.storage.local(与 settings.js 同一个前缀)。它是**浏览器本地**的,
// 和 macOS 那边一样不上报宿主:手动顺序是"我这台机器上我习惯的样子",
// 不是会话本身的属性。

const STORAGE_KEY = "dsh_flat_session_order";

async function resolveArea() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage.local;
  const { chromeShim } = await import("../../platform/storage/chrome-shim.js");
  return chromeShim.storage.local;
}

export function createSessionOrderStore() {
  /// 手动顺序账本:被拖过的会话 id,按用户安排的先后。
  let order = [];
  /// id → 在 order 里的下标。随 order 一起重建,读时 O(1)。
  let position = new Map();
  let loaded = false;

  function reindex() {
    position = new Map(order.map((id, index) => [id, index]));
  }

  async function persist() {
    try {
      const area = await resolveArea();
      await area.set({ [STORAGE_KEY]: order });
    } catch {
      // 存不下就只影响"下次启动还记不记得",本次会话的顺序已经在内存里生效了。
    }
  }

  return {
    /// 从 storage 读回账本。启动时调一次;失败则以空账本开始(退化成按时间排)。
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

    /**
     * 按手动顺序解析一个可见子集。
     *
     * 账本为空(从没拖过)时直接按时间倒序 —— 这也是首次使用的样子。
     * 否则:不在账本里的行按时间倒序在前,账本里的行按账本顺序在后。
     *
     * @param {Array} visible 可见行。
     * @returns {Array} 排好序的新数组。
     */
    sort(visible) {
      const rows = [...(visible ?? [])];
      if (!order.length) return rows.sort(byUpdatedDesc);
      const known = [];
      const fresh = [];
      for (const summary of rows) {
        const at = position.get(summary.sessionId);
        if (at === undefined) fresh.push(summary);
        else known.push({ at, summary });
      }
      known.sort((a, b) => a.at - b.at);
      fresh.sort(byUpdatedDesc);
      // 没摆过位置的在前(见文件头第 3 条):新会话不能沉到上千条账本行之后。
      return fresh.concat(known.map((entry) => entry.summary));
    },

    /**
     * 把一次拖放写进账本。
     *
     * 只改写子集占据的槽位:子集外的 id 保留各自原有的位置,所以在一个过滤视图里
     * 重排不会影响另一个视图里那些会话之间的相对顺序。
     *
     * @param {string} movedId 被拖动的会话。
     * @param {string|null} beforeId 插到谁前面;null 表示子集末尾。
     * @param {string[]} subsetIds 当前可见子集的 id,按显示顺序。
     */
    reorder(movedId, beforeId, subsetIds) {
      const subset = [...(subsetIds ?? [])];
      if (movedId === beforeId) return;
      const from = subset.indexOf(movedId);
      if (from === -1) return;
      subset.splice(from, 1);
      const at = beforeId == null ? -1 : subset.indexOf(beforeId);
      if (at === -1) subset.push(movedId);
      else subset.splice(at, 0, movedId);

      // 子集在账本里占了哪些槽位 —— 只有这些槽位会被重写。
      const members = new Set(subset);
      const slots = [];
      for (let i = 0; i < order.length; i++) {
        if (members.has(order[i])) slots.push(i);
      }
      const next = [...order];
      let cursor = 0;
      for (const slot of slots) {
        if (cursor >= subset.length) break;
        next[slot] = subset[cursor++];
      }
      // 子集里还没进过账本的成员(第一次被拖),按新的相对顺序追加到末尾。
      const appended = subset.slice(cursor).filter((id) => !next.includes(id));
      order = next.concat(appended);
      reindex();
      void persist();
    }
  };
}

function byUpdatedDesc(a, b) {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}
