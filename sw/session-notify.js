/**
 * Notifies when a session finishes working while the panel is not watching.
 *
 * The downlink streams live in the side panel (they need a backend-origin
 * iframe to satisfy the trust fence, which a worker cannot provide), so the
 * worker cannot observe turn events. It polls `session.list` instead and
 * reports each running → idle transition.
 */

import { createSettings } from "../src/platform/storage/settings.js";
import { createApiClient } from "../src/platform/dsh/api-client.js";
import {
  createBackgroundNotifier,
  pollSessionStatuses,
} from "../src/features/notifications/background-notifier.js";
import {
  sessionIdFromNotificationId,
  createPendingSessionOpen,
} from "../src/features/notifications/notification-click.js";
import { openPanel } from "./sidepanel-open.js";

const POLL_INTERVAL_MS = 15000;

const settings = createSettings();
const notifier = createBackgroundNotifier({
  notifications: chrome.notifications,
  settings,
});

async function pollSessions() {
  // 先恢复持久化的运行集合:worker 可能刚被回收重启,漏了状态会漏报完成通知。
  await notifier.loadRunning();
  try {
    const api = createApiClient({ baseUrl: await settings.getBackendUrl() });
    await pollSessionStatuses(api, notifier);
  } catch {
    // Backend unreachable: stay quiet and retry on the next tick.
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
  // 先落盘再开侧栏:开侧栏成功即触发启动领取,顺序反了会漏。
  pendingOpen.set(sessionId).finally(() => {
    openPanel().catch(() => {});
  });
});

// An alarm rather than setInterval: MV3 evicts idle workers, which would
// silently kill a timer.
chrome.alarms.create("dsh-session-poll", { periodInMinutes: POLL_INTERVAL_MS / 60000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dsh-session-poll") pollSessions();
});

pollSessions();
