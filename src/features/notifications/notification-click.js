// 通知点击 → 打开对应会话的交接。
//
// 通知在 service worker(轮询)或侧栏(失败偷看)里创建,点击事件只会送达
// service worker;而"切到某个会话"只有侧栏应用做得到。两边不共享内存,
// 交接经 storage.local:worker 写入 pending sessionId 并打开侧栏,
// 侧栏启动时领取(take),已开着时靠 storage.onChanged 即时响应(subscribe)。
const PENDING_KEY = "dsh_pending_open_session";
// 领取有 TTL:没人领的残留(比如用户点了通知却随手关掉窗口)不该在
// 几小时后的下一次打开时突兀地跳会话。
const PENDING_TTL_MS = 60_000;

/// 通知 id 携带会话 id:dsh-<sessionId>-<createdAt>。集中在这里生成与解析,
/// 两边的格式不会漂移。sessionId 本身可含连字符,解析靠"尾部纯数字段"锚定。
export function notificationIdForSession(sessionId, createdAt = Date.now()) {
  return `dsh-${sessionId}-${createdAt}`;
}

export function sessionIdFromNotificationId(notificationId) {
  const match = /^dsh-(.+)-\d+$/.exec(notificationId ?? "");
  return match ? match[1] : null;
}

export function createPendingSessionOpen({
  storage = globalThis.chrome?.storage?.local,
  onChanged = globalThis.chrome?.storage?.onChanged,
  ttlMs = PENDING_TTL_MS,
  now = Date.now
} = {}) {
  return Object.freeze({
    /// worker 侧:记下待打开的会话。失败静默 —— 侧栏还是会被打开,只是落在默认会话。
    async set(sessionId) {
      if (!storage) return;
      try {
        await storage.set({ [PENDING_KEY]: { sessionId, at: now() } });
      } catch { /* storage 不可用时退化为只开侧栏 */ }
    },

    /// 侧栏启动时领取:读到即清除(一次性),过期条目丢弃。
    async take() {
      if (!storage) return null;
      try {
        const value = await storage.get([PENDING_KEY]);
        const entry = value?.[PENDING_KEY];
        if (!entry) return null;
        await storage.remove([PENDING_KEY]);
        if (typeof entry.sessionId !== "string" || !entry.sessionId) return null;
        if (typeof entry.at === "number" && now() - entry.at > ttlMs) return null;
        return entry.sessionId;
      } catch {
        return null;
      }
    },

    /// 侧栏已开着时的即时通道。领取后同样清除;清除引发的第二次 onChanged
    /// 没有 newValue,自然被忽略,不会二次触发。
    subscribe(onOpen) {
      if (!onChanged?.addListener) return () => {};
      const listener = (changes, areaName) => {
        if (areaName !== "local") return;
        const entry = changes?.[PENDING_KEY]?.newValue;
        if (typeof entry?.sessionId !== "string" || !entry.sessionId) return;
        storage?.remove?.([PENDING_KEY])?.catch?.(() => {});
        onOpen(entry.sessionId);
      };
      onChanged.addListener(listener);
      return () => onChanged.removeListener?.(listener);
    }
  });
}
