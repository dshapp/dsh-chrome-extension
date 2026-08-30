/**
 * DSH web autostart shard (worker side).
 *
 * background.js is imported untouched and its test suite loads that source as a
 * bare function, so this shard must not add an ES import to it. Instead it
 * observes the bridge's state through the same runtime message the side panel
 * uses ({ type:"get_state" -> { connected, shouldConnect, url } }), and when
 * the user wants the bridge attached but it has not connected for a while, it
 * asks the Native Messaging host to bring `dsh web` up — the bridge endpoint
 * (/chrome/ws) now lives inside that same server, so there is no separate
 * daemon to start.
 *
 * Reconnection afterwards is the bridge's own job: its RECONCILE_ALARM already
 * retries every 30s, so once the server answers the bridge reconnects on its
 * next tick — this shard only shortens the "server is down" gap by starting it
 * in the first place. ensureServerRunning("web") resolves the configured DSH
 * server address (host + port) from settings itself.
 */
import { ensureServerRunning } from "../src/platform/dsh/native-supervisor.js";

const ALARM = "dsh-chrome-web-supervisor";
const PERIOD_MIN = 0.5; // 30s

function canReachWorker() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

async function bridgeState() {
  try {
    return await chrome.runtime.sendMessage({ type: "get_state" });
  } catch {
    return null;
  }
}

async function tick() {
  if (!canReachWorker()) return;
  const state = await bridgeState();
  if (!state) return;
  // Only act when the user wants the bridge attached but it has not connected.
  if (state.shouldConnect === false) return;
  if (state.connected) return;
  const result = await ensureServerRunning("web");
  if (result?.ok && !result.alreadyUp) {
    // Nudge the bridge to try again now rather than wait for its 30s alarm.
    // The bridge ignores unknown message types, so a best-effort nudge is safe.
    try { await chrome.runtime.sendMessage({ type: "reconcile" }); } catch {}
  }
}

if (typeof chrome !== "undefined" && chrome.alarms) {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) tick().catch(() => {});
  });
  // Run once at worker startup so a cold start with the server down recovers
  // immediately, not on the next 30s tick.
  tick().catch(() => {});
}
