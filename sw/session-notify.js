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
import { createBackgroundNotifier } from "../src/features/notifications/background-notifier.js";

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
    const value = await api.call("session.list", {});
    for (const item of value.items ?? []) {
      notifier.observeStatus(item.sessionId, item.running);
    }
  } catch {
    // Backend unreachable: stay quiet and retry on the next tick.
  }
}

// An alarm rather than setInterval: MV3 evicts idle workers, which would
// silently kill a timer.
chrome.alarms.create("dsh-session-poll", { periodInMinutes: POLL_INTERVAL_MS / 60000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dsh-session-poll") pollSessions();
});

pollSessions();
