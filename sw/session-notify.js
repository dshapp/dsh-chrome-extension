/**
 * Notifies when a session finishes working while the panel is not watching,
 * and paints the toolbar dot (red / yellow / green) for unread task results.
 *
 * The downlink streams live in the side panel (they need a backend-origin
 * iframe to satisfy the trust fence, which a worker cannot provide), so the
 * worker cannot observe turn events. It polls `session.list` instead and
 * reports each running → idle transition. Failures and pending approvals are
 * only visible to the panel's live frames; the panel reports them here
 * (TASK_UNREAD_MESSAGE) so that this worker stays the single writer of the
 * unread state.
 */

import { createSettings } from "../src/platform/storage/settings.js";
import { createApiClient } from "../src/platform/dsh/api-client.js";
import { createActionDotIndicator } from "../src/platform/chrome/action-dot-indicator.js";
import {
  createBackgroundNotifier,
  pollSessionStatuses,
} from "../src/features/notifications/background-notifier.js";
import {
  sessionIdFromNotificationId,
  createPendingSessionOpen,
} from "../src/features/notifications/notification-click.js";
import {
  createTaskUnreadCoordinator,
  TASK_UNREAD_MESSAGE,
} from "../src/features/notifications/task-unread.js";
import {
  createPresenceRegistry,
  PANEL_PRESENCE_PORT,
} from "../src/features/notifications/panel-presence.js";
import { setLang, t } from "../src/shared/i18n.js";
import { openPanel } from "./sidepanel-open.js";

// 每次轮询都是一次全量 session/list(约 700KB、数百毫秒)。Chrome 对 alarm
// 周期有 30s 下限:原先写的 15s 在 116–119 上被钳到 60s,在新版 Chrome 被钳到
// 30s —— 反正不会按 15s 跑。这里显式定 60s 降载:侧栏打开时它那条实时流才是
// 状态权威,轮询只负责"侧栏关着时的完成通知",晚一分钟可接受。
const POLL_INTERVAL_MS = 60000;

const settings = createSettings();
const presence = createPresenceRegistry();

/** 收掉某条会话的系统通知:它已经被看过了,通知中心里不该还留着。 */
async function clearSessionNotifications(sessionId) {
  try {
    const all = await chrome.notifications.getAll();
    for (const id of Object.keys(all ?? {})) {
      if (sessionIdFromNotificationId(id) === sessionId) chrome.notifications.clear(id);
    }
  } catch { /* 通知中心不可用:不影响清点 */ }
}

const taskUnread = createTaskUnreadCoordinator({
  storage: chrome.storage.local,
  alarms: chrome.alarms,
  indicator: createActionDotIndicator({ api: chrome, log: (...args) => console.warn("[dsh]", ...args) }),
  isSeen: (sessionId) => presence.isSeen(sessionId),
  // 悬停提示跟随侧栏里选的语言:worker 有自己的模块作用域,每次都取一遍。
  describe: async (top) => {
    const lang = await settings.getLang?.().catch(() => null);
    if (lang) setLang(lang);
    return t(top.titleKey, { n: top.count });
  },
  onSessionCleared: (sessionId) => void clearSessionNotifications(sessionId),
});

const notifier = createBackgroundNotifier({
  notifications: chrome.notifications,
  settings,
  onCompleted: ({ sessionId, title, since }) =>
    taskUnread.record({ sessionId, status: "success", title: title ?? "", since }),
  isWatching: (sessionId) => presence.isWatching(sessionId),
});

// 防叠加:上一次轮询还没结算时 alarm 又到,直接跳过 —— 否则慢请求会和下一次
// 全量拉取排队,把宿主拖得更慢。
let polling = false;
async function pollSessions() {
  if (polling) return;
  polling = true;
  try {
    // 先恢复持久化的运行集合:worker 可能刚被回收重启,漏了状态会漏报完成通知。
    await notifier.loadRunning();
    const api = createApiClient({ baseUrl: await settings.getBackendUrl() });
    const items = await pollSessionStatuses(api, notifier);
    // 删掉的会话不该在图标上留一个永远点不进去的点。
    await taskUnread.retain(items.map((item) => item.sessionId));
  } catch {
    // Backend unreachable: stay quiet and retry on the next tick.
  } finally {
    polling = false;
  }
}

// 点击"任务已完成/失败"通知:打开侧栏并切到对应会话。切换动作只有侧栏
// 应用能做,worker 先把 sessionId 写进 storage 交接,再打开侧栏
// (侧栏启动时领取;已开着时靠 storage.onChanged 即时响应)。
// 侧栏创建的失败通知用同一套 id 格式,点击同样送达这里。
const pendingOpen = createPendingSessionOpen();
chrome.notifications.onClicked.addListener((notificationId) => {
  const sessionId = sessionIdFromNotificationId(notificationId);
  if (!sessionId) return;
  chrome.notifications.clear(notificationId);
  // 点了通知就算看过:工具栏上这条会话的点一起撤掉。
  void taskUnread.markSeen(sessionId);
  // 先落盘再开侧栏:开侧栏成功即触发启动领取,顺序反了会漏。
  pendingOpen.set(sessionId).finally(() => {
    openPanel().catch(() => {});
  });
});

// 侧栏在场:正看着哪条会话。看着的那条立刻算已读。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PRESENCE_PORT) return;
  port.onMessage.addListener((message) => {
    if (message?.type !== "presence") return;
    const entry = presence.set(port, message);
    if (entry.sessionId && presence.isSeen(entry.sessionId)) void taskUnread.markSeen(entry.sessionId);
  });
  port.onDisconnect.addListener(() => presence.remove(port));
});

// 侧栏上报的失败 / 等你处理。不回包:bridge 的 onMessage 会替未知消息回 { ok:false }。
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== TASK_UNREAD_MESSAGE || typeof message.sessionId !== "string") return false;
  if (message.op === "clear") {
    void taskUnread.clear(message.sessionId, Array.isArray(message.statuses) ? message.statuses : undefined);
  } else if (message.status === "failure" || message.status === "attention") {
    void taskUnread.record({
      sessionId: message.sessionId,
      status: message.status,
      title: typeof message.title === "string" ? message.title : "",
      eventId: typeof message.eventId === "string" ? message.eventId : null,
    });
  }
  return false;
});

// 改语言后重画一次悬停提示。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.dsh_lang) void taskUnread.refresh();
});

// An alarm rather than setInterval: MV3 evicts idle workers, which would
// silently kill a timer.
chrome.alarms.create("dsh-session-poll", { periodInMinutes: POLL_INTERVAL_MS / 60000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dsh-session-poll") pollSessions();
  else void taskUnread.handleAlarm(alarm).catch(() => {});
});

// 启动:清掉过期的未读、按剩下的画点、排好下一次到期的闹钟。
void taskUnread.refresh().catch(() => {});
pollSessions();
