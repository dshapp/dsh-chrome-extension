// 任务未读:工具栏图标右上角的红 / 黄 / 绿点(service worker 独占写入)。
//
//   绿 = 有任务跑完了还没看(SW 轮询 session.list 的 running→idle 边沿);
//   黄 = 有任务在等你授权 / 回答(侧栏从实时帧看到挂起请求后报上来);
//   红 = 有任务失败(侧栏帧偷看到 turn/end error 后报上来)。
// 同一时刻只画最要紧的那一个,规则见 unread-policy.js。
//
// 状态只有一份,存在 storage.local(TASK_UNREAD_KEY),只有 SW 写:侧栏经 runtime 消息上报,
// 由这里串行落盘,两个上下文不会互相覆盖。侧栏会话行的点读的也是这一份(storage.onChanged)。
//
// 什么时候消失:
//   - 看过了:侧栏可见、正显示这条会话,且侧栏有焦点或它所在的 Chrome 窗口在前台(isSeen);
//   - 点了这条会话的系统通知;
//   - 会话从 session.list 里消失(删除);
//   - 过期:绿 2 小时、红 / 黄 12 小时,到点由 alarm 撤掉(没有任何事件也会消失)。
import {
  INDICATORS,
  nextUnreadExpiry,
  pruneExpired,
  resolveIndicator,
  unreadKey
} from "./unread-policy.js";

export const TASK_UNREAD_KEY = "dsh_task_unread";
export const TASK_UNREAD_EXPIRY_ALARM = "dsh-task-unread-expiry";
/** 侧栏 → SW 的上报消息类型。 */
export const TASK_UNREAD_MESSAGE = "dsh_task_unread";
/** chrome.alarms 的下限是 30s。 */
const MIN_ALARM_DELAY_MS = 30_000;
/** 已看过的挂起请求 eventId:重连后宿主会重放同一个请求,不该把看过的黄点再点亮。 */
const MAX_SEEN_KEYS = 200;

function emptyState() {
  return { unread: {}, seenKeys: [] };
}

function normalizeState(value) {
  const state = emptyState();
  if (value && typeof value === "object") {
    if (value.unread && typeof value.unread === "object") state.unread = { ...value.unread };
    if (Array.isArray(value.seenKeys)) state.seenKeys = value.seenKeys.filter((key) => typeof key === "string");
  }
  return state;
}

function removeSession(state, sessionId, statuses = Object.keys(INDICATORS)) {
  let removed = 0;
  for (const status of statuses) {
    const key = unreadKey(sessionId, status);
    const event = state.unread[key];
    if (!event) continue;
    if (event.eventId) state.seenKeys.push(event.eventId);
    delete state.unread[key];
    removed += 1;
  }
  if (removed) state.seenKeys = state.seenKeys.slice(-MAX_SEEN_KEYS);
  return removed;
}

export function createTaskUnreadCoordinator({
  storage,
  alarms = null,
  /** 工具栏圆点:show({ color, title } | null)。不传就只记账不画。 */
  indicator = null,
  /** (sessionId) => boolean:用户此刻正看着这条会话(见 panel-presence.js)。 */
  isSeen = () => false,
  /** (resolved) => string | Promise<string>:圆点的悬停提示(SW 负责按用户语言翻译)。 */
  describe = (resolved) => resolved.titleKey,
  /** (sessionId) => void:一条会话被看过 / 遗忘时,顺手收掉它的系统通知。 */
  onSessionCleared = () => {},
  log = () => {},
  now = () => Date.now()
} = {}) {
  let chain = Promise.resolve();

  /** 所有读改写串行:SW 里轮询、alarm、侧栏消息会并发到达。 */
  function serialize(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  async function readState() {
    try {
      const got = await storage.get([TASK_UNREAD_KEY]);
      return normalizeState(got?.[TASK_UNREAD_KEY]);
    } catch {
      return emptyState();
    }
  }

  async function writeState(state) {
    await storage.set({ [TASK_UNREAD_KEY]: state });
  }

  /** 读状态并清掉过期的未读(只改内存,调用方决定写不写回)。 */
  async function readFresh() {
    const state = await readState();
    const removed = pruneExpired(state.unread, now());
    if (removed) log("TASK_UNREAD_EXPIRED", removed);
    return { state, dirty: removed > 0 };
  }

  async function scheduleExpiry(state) {
    if (!alarms) return;
    const next = nextUnreadExpiry(state.unread);
    try {
      if (next == null) await alarms.clear(TASK_UNREAD_EXPIRY_ALARM);
      else await alarms.create(TASK_UNREAD_EXPIRY_ALARM, { when: Math.max(next, now() + MIN_ALARM_DELAY_MS) });
    } catch (error) {
      log("TASK_UNREAD_ALARM_WARN", String(error?.message || error));
    }
  }

  async function paint(state) {
    const top = resolveIndicator(state.unread);
    try {
      await indicator?.show(top ? { color: top.color, title: await describe(top) } : null);
    } catch (error) {
      log("TASK_UNREAD_PAINT_WARN", String(error?.message || error));
    }
    await scheduleExpiry(state);
  }

  async function commit(state) {
    await writeState(state);
    await paint(state);
  }

  /**
   * 记一条未读。返回 { recorded, reason }:
   *   - seen:用户正看着这条会话(或这个挂起请求已经看过),不记;
   *   - failed:这一轮已经报过失败,不再补一个「完成」(调用方据此也不弹完成通知)。
   * since:这一轮开始被观察到的时刻(SW 轮询的 running 集合记着),用来认「同一轮」。
   */
  function record({ sessionId, status, title = "", eventId = null, since = 0 } = {}) {
    if (!sessionId || !INDICATORS[status]) return Promise.resolve({ recorded: false, reason: "invalid" });
    return serialize(async () => {
      const { state, dirty } = await readFresh();
      let changed = dirty;
      const finish = async (result) => {
        if (changed) await commit(state);
        return result;
      };
      if (eventId && state.seenKeys.includes(eventId)) return finish({ recorded: false, reason: "seen" });
      if (status === "success" || status === "failure") {
        // 轮结束了:挂起请求必然已经结算,黄点随之撤掉。
        if (removeSession(state, sessionId, ["attention"])) changed = true;
      }
      if (status === "success") {
        const failure = state.unread[unreadKey(sessionId, "failure")];
        // 这一轮以失败收尾:红点已经在了,「完成」既不记也不通知。
        if (failure && Number(failure.createdAt) >= Number(since || 0)) return finish({ recorded: false, reason: "failed" });
      }
      if (isSeen(sessionId)) {
        if (eventId) {
          state.seenKeys = [...state.seenKeys, eventId].slice(-MAX_SEEN_KEYS);
          changed = true;
        }
        return finish({ recorded: false, reason: "seen" });
      }
      const key = unreadKey(sessionId, status);
      const existing = state.unread[key];
      // 同一个挂起请求被重放(重连):保留原来的 createdAt,不让它的过期时间一直往后推。
      const createdAt = existing && eventId && existing.eventId === eventId ? existing.createdAt : now();
      state.unread[key] = {
        sessionId,
        status,
        createdAt,
        title: typeof title === "string" ? title.slice(0, 80) : "",
        ...(eventId ? { eventId } : {})
      };
      changed = true;
      log("TASK_UNREAD_RECORD", status, String(sessionId).slice(0, 16));
      return finish({ recorded: true, reason: "recorded" });
    });
  }

  /** 撤掉一条会话的某几类未读(挂起请求结算了 → 撤黄点)。 */
  function clear(sessionId, statuses) {
    if (!sessionId) return Promise.resolve(false);
    return serialize(async () => {
      const { state, dirty } = await readFresh();
      const removed = removeSession(state, sessionId, statuses);
      if (removed || dirty) await commit(state);
      return removed > 0;
    });
  }

  /** 用户看过了这条会话:它的所有未读一起清掉,系统通知也收掉。 */
  async function markSeen(sessionId) {
    const removed = await clear(sessionId);
    if (removed) {
      log("TASK_UNREAD_SEEN", String(sessionId).slice(0, 16));
      onSessionCleared(sessionId);
    }
    return removed;
  }

  /** 只保留仍在 session.list 里的会话:删掉的会话不该在图标上留一个永远点不进去的点。 */
  function retain(sessionIds) {
    const keep = sessionIds instanceof Set ? sessionIds : new Set(sessionIds ?? []);
    return serialize(async () => {
      const { state, dirty } = await readFresh();
      let removed = 0;
      for (const [key, event] of Object.entries(state.unread)) {
        if (keep.has(event?.sessionId)) continue;
        delete state.unread[key];
        removed += 1;
      }
      if (removed || dirty) await commit(state);
      return removed;
    });
  }

  /** 清过期 + 重画 + 重排闹钟。SW 启动、alarm 到点、改语言后调用。 */
  function refresh() {
    return serialize(async () => {
      const { state, dirty } = await readFresh();
      if (dirty) await writeState(state);
      await paint(state);
      return state.unread;
    });
  }

  async function handleAlarm(alarm) {
    if (alarm?.name !== TASK_UNREAD_EXPIRY_ALARM) return false;
    await refresh();
    return true;
  }

  async function read() {
    return (await readFresh()).state.unread;
  }

  return Object.freeze({ record, clear, markSeen, retain, refresh, handleAlarm, read });
}