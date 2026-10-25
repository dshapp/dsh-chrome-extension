/**
 * DSH web autostart shard (worker side).
 *
 * Keeps `dsh web` up while Chrome runs, the way the Mac app keeps its server
 * up: every 30s (and once at worker startup) it checks whether the configured
 * DSH server answers, and when it does not, asks the Native Messaging host to
 * start it.
 *
 * The check is a direct request to the server, not the CDP bridge's state.
 * The bridge talks to the standalone chrome-daemon (:37086), which outlives
 * the dsh web that spawned it — so "bridge connected" said nothing about
 * whether dsh web was up, and a dsh web that had exited stayed down until the
 * side panel happened to be opened. Any HTTP answer (even 401/404) counts as
 * up: only a refused/timed-out connection means the server is gone.
 *
 * A start that fails (port never came up, launcher missing) backs off — 30s,
 * 1m, 2m, … capped at 5m — so a dsh that crashes on boot is not respawned every
 * tick. The native host itself probes the port before spawning, so a start that
 * races the side panel's own autostart is a no-op, not a second server.
 *
 * Once a start succeeds, the bridge is nudged to reconnect now rather than on
 * its own 30s alarm (the server it spawns brings the daemon back too).
 */
import { ensureServerRunning } from "../src/platform/dsh/native-supervisor.js";
import { createSettings } from "../src/platform/storage/settings.js";

const ALARM = "dsh-chrome-web-supervisor";
const PERIOD_MIN = 0.5; // 30s
const PROBE_TIMEOUT_MS = 3000;
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** Whether the DSH server at baseUrl answers HTTP at all. */
export async function isServerUp(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") return true; // cannot tell: never spawn on a guess
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(new URL("/", baseUrl).href, {
      method: "HEAD", cache: "no-store", credentials: "omit", redirect: "manual", signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The supervisor's decision loop, with its collaborators injectable for tests.
 * tick() returns what it did: "up" | "backoff" | "started" | "already-up" | "failed".
 */
export function createWebSupervisor({
  probe = isServerUp,
  ensure = ensureServerRunning,
  backendUrl = () => createSettings().getBackendUrl(),
  onStarted = () => globalThis.__dshBridgeReconcile?.(),
  now = Date.now
} = {}) {
  let failures = 0;
  let retryAt = 0;
  let running = null;
  let last = null;

  async function run(options) {
    const url = options.backendUrl || (await backendUrl());
    if (await probe(url)) {
      failures = 0;
      retryAt = 0;
      return (last = { state: "up", url });
    }
    if (!options.force && now() < retryAt) return (last = { state: "backoff", url, retryAt });
    // force: this loop owns its own backoff; the module-wide 30s cooldown would
    // otherwise swallow every other tick (alarms fire at ~30s, not >30s).
    const result = await ensure("web", { backendUrl: url, force: true });
    if (result?.ok) {
      failures = 0;
      retryAt = 0;
      if (!result.alreadyUp) {
        try { await onStarted(); } catch {}
      }
      return (last = { state: result.alreadyUp ? "already-up" : "started", url, result });
    }
    failures += 1;
    retryAt = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    return (last = { state: "failed", url, result, retryAt });
  }

  return {
    /** One supervision pass. Concurrent calls share the pass already running. */
    tick(options = {}) {
      running ||= run(options).finally(() => { running = null; });
      return running;
    },
    get last() { return last; }
  };
}

if (typeof chrome !== "undefined" && chrome.alarms) {
  const supervisor = createWebSupervisor();
  // Diagnostics hook (read the last decision / run a pass from DevTools).
  globalThis.__dshWebSupervisor = supervisor;
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) supervisor.tick().catch(() => {});
  });
  // Run once at worker startup so a cold start with the server down recovers
  // immediately, not on the next 30s tick.
  supervisor.tick().catch(() => {});
}
