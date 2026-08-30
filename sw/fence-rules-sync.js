/**
 * Keeps the declarativeNetRequest fence rules in step with the backend URL.
 *
 * DSH's trust fence rejects requests carrying a `chrome-extension://` origin,
 * so the extension's uplink only works while a dynamic rule strips those
 * headers for the backend's authority. Registering at worker startup covers
 * every revival; the storage listener covers the user editing the address.
 */

import { createSettings } from "../src/platform/storage/settings.js";
import { applyFenceRules } from "../src/platform/dsh/fence-rules.js";

const settings = createSettings();

async function refreshFenceRules() {
  if (!chrome.declarativeNetRequest) return;
  const backendUrl = await settings.getBackendUrl();
  await applyFenceRules(chrome.declarativeNetRequest, backendUrl);
}

refreshFenceRules().catch(() => {
  // The backend address is unreadable or the rule was rejected; the panel
  // surfaces the resulting connection failure itself.
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[settings.KEYS.backendUrl]) {
    refreshFenceRules().catch(() => {});
  }
});
