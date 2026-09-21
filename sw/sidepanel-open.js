/**
 * Opening the DSH side panel.
 *
 * The toolbar icon opens the panel directly. That requires the manifest to
 * declare no `action.default_popup`, because Chrome gives a declared popup
 * precedence over `openPanelOnActionClick` — which is why the bridge's status
 * lives in the panel's own settings view instead of a popup.
 *
 * The context menu and keyboard command remain as secondary routes.
 */

const MENU_ID = "dsh-open-sidepanel";
const COMMAND_ID = "open_sidepanel";

/** `sidePanel.open` needs a window; fall back to the focused one. */
export async function openPanel(windowId) {
  const id = windowId ?? (await chrome.windows.getCurrent()).id;
  await chrome.sidePanel.open({ windowId: id });
}

// Make the toolbar icon open the panel. Set on every worker startup, not just
// at install, because the preference does not survive a profile that has never
// seen it and re-asserting it is idempotent.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// The bridge registers its own onInstalled listener; Chrome runs both.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create(
    // 菜单文案跟随浏览器 UI 语言(_locales),与侧栏内的语言偏好相互独立。
    { id: MENU_ID, title: chrome.i18n.getMessage("openSidepanel") || "Open Deepseek Harness APP side panel", contexts: ["page", "selection"] },
    // Re-running the installer would otherwise reject on the existing id.
    () => void chrome.runtime.lastError,
  );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) openPanel(tab?.windowId).catch(() => {});
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === COMMAND_ID) openPanel().catch(() => {});
});

/**
 * Programmatic open, kept for callers that have no gesture of their own (the
 * relay content script's quick-ask route, and anything added later).
 *
 * This is a second onMessage listener alongside the bridge's. Returning a falsy
 * value for anything else leaves those messages to the bridge — claiming them
 * here would swallow `get_state`, which the panel's settings view needs.
 */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "open_sidepanel") return false;
  openPanel(message.windowId).then(
    () => respond({ ok: true }),
    (error) => respond({ ok: false, error: String(error?.message || error) }),
  );
  return true; // respond() is called asynchronously.
});
