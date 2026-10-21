// 侧栏在场信息:用户此刻是不是正看着某条会话。
//
// 侧栏经一条长连接端口(PANEL_PRESENCE_PORT)把 { visible, focused, windowFocused, sessionId }
// 报给 service worker;侧栏关掉时端口自动断开,SW 就知道没人在看了,不需要猜新鲜度。
//
// 两个判据,用途不同:
//   - isSeen:侧栏可见、正显示这条会话,且侧栏有焦点**或**它所在的 Chrome 窗口在前台。
//     用来清未读 / 不记未读:点工具栏打开侧栏时焦点还留在网页上,但用户确实在看。
//   - isWatching:同上但只认侧栏本身有焦点。用来压掉系统通知:用户切到别的应用那一刻,
//     窗口失焦要等下一次上报才知道,只认侧栏焦点(blur 立即上报)才不会把该弹的通知吞掉。

import { TASK_UNREAD_MESSAGE } from "./task-unread.js";

export const PANEL_PRESENCE_PORT = "dsh-panel-presence";
/** 侧栏可见时的心跳:窗口前后台切换没有可靠的页面事件,靠它兜底。 */
const HEARTBEAT_MS = 5_000;

/** SW 侧:按端口记每个侧栏实例的在场信息。 */
export function createPresenceRegistry() {
  const entries = new Map();
  function some(predicate) {
    for (const entry of entries.values()) if (predicate(entry)) return true;
    return false;
  }
  return Object.freeze({
    set(port, presence) {
      entries.set(port, {
        visible: Boolean(presence?.visible),
        focused: Boolean(presence?.focused),
        windowFocused: Boolean(presence?.windowFocused),
        sessionId: typeof presence?.sessionId === "string" ? presence.sessionId : null
      });
      return entries.get(port);
    },
    remove(port) {
      entries.delete(port);
    },
    isSeen(sessionId) {
      return Boolean(sessionId) && some((entry) =>
        entry.visible && entry.sessionId === sessionId && (entry.focused || entry.windowFocused));
    },
    isWatching(sessionId) {
      return Boolean(sessionId) && some((entry) => entry.visible && entry.focused && entry.sessionId === sessionId);
    }
  });
}

/** 侧栏侧:连上 SW 并在任何可能改变「在看什么」的时刻上报。 */
export function createPresenceReporter({
  runtime = globalThis.chrome?.runtime,
  windows = globalThis.chrome?.windows,
  doc = globalThis.document,
  win = globalThis.window,
  getSessionId = () => null,
  heartbeatMs = HEARTBEAT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let port = null;
  let timer = null;
  let stopped = false;
  let sequence = 0;
  let lastSessionId;

  function connect() {
    if (stopped || port || !runtime?.connect) return;
    try {
      port = runtime.connect({ name: PANEL_PRESENCE_PORT });
    } catch {
      port = null;
      return;
    }
    // SW 被回收或重启时端口会断:重连并立刻补报一次,SW 的内存登记表才不会空着。
    port.onDisconnect?.addListener(() => {
      port = null;
      if (!stopped) setTimer(() => { connect(); void sync(); }, 1_000);
    });
  }

  async function windowFocused(focused) {
    if (focused) return true;
    try {
      return Boolean((await windows?.getCurrent?.())?.focused);
    } catch {
      return false;
    }
  }

  async function sync() {
    if (stopped) return;
    connect();
    const ticket = ++sequence;
    const visible = doc?.visibilityState === "visible";
    const focused = visible && Boolean(doc?.hasFocus?.());
    const presence = {
      type: "presence",
      visible,
      focused,
      windowFocused: visible ? await windowFocused(focused) : false,
      sessionId: getSessionId() ?? null
    };
    lastSessionId = presence.sessionId;
    // 慢的 getCurrent 不能把更新的一次上报覆盖掉。
    if (ticket !== sequence) return;
    try {
      port?.postMessage(presence);
    } catch {
      port = null;
    }
    clearTimer(timer);
    timer = visible ? setTimer(() => void sync(), heartbeatMs) : null;
  }

  function start() {
    const resync = () => void sync();
    doc?.addEventListener?.("visibilitychange", resync);
    win?.addEventListener?.("focus", resync);
    win?.addEventListener?.("blur", resync);
    windows?.onFocusChanged?.addListener?.(resync);
    void sync();
    return () => {
      stopped = true;
      clearTimer(timer);
      doc?.removeEventListener?.("visibilitychange", resync);
      win?.removeEventListener?.("focus", resync);
      win?.removeEventListener?.("blur", resync);
      windows?.onFocusChanged?.removeListener?.(resync);
      try { port?.disconnect(); } catch { /* 已断开 */ }
      port = null;
    };
  }

  /** 渲染路径上调用:只有当前会话真的变了才上报,不随每一帧刷。 */
  function sessionChanged() {
    if ((getSessionId() ?? null) !== lastSessionId) void sync();
  }

  return Object.freeze({ start, sync, sessionChanged });
}

/** 侧栏 → SW:报一条未读或撤掉一类未读。fire-and-forget,SW 没醒也会被消息唤醒。 */
export function reportTaskUnread(message, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.sendMessage || !message?.sessionId) return;
  try {
    const result = runtime.sendMessage({ ...message, type: TASK_UNREAD_MESSAGE });
    result?.catch?.(() => {});
  } catch {
    // 扩展上下文失效(更新中):这一条丢了也只是少一个点。
  }
}
