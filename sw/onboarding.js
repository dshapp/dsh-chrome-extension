/**
 * First-run onboarding.
 *
 * A user who installs the extension from the store usually has no dsh on the
 * machine yet. Before this shard they found out by opening the side panel and
 * reading Chrome's raw "Specified native messaging host not found." — so on a
 * fresh install we probe the Native Messaging host (read-only `status`, which
 * never starts a process) and, only when it is not usable, open the welcome
 * page with the setup guide. Users who already run dsh with the
 * dsh-chrome-control plugin get no extra tab.
 *
 * Updates and Chrome restarts are left alone: `reason === "install"` only.
 */
import { probeHost } from "../src/platform/dsh/native-supervisor.js";

export const WELCOME_PAGE = "pages/welcome/index.html";

export async function openWelcomeIfNeeded({ probe = probeHost, tabs = chrome.tabs, runtime = chrome.runtime } = {}) {
  let status = null;
  try { status = await probe(); } catch { status = null; }
  if (status?.ok) return false;
  await tabs.create({ url: runtime.getURL(WELCOME_PAGE) });
  return true;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details?.reason !== "install") return;
    openWelcomeIfNeeded().catch(() => {});
  });
}
