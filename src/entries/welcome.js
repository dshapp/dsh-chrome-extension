// 欢迎 / 安装引导页。
//
// 两个入口:扩展首次安装时(且本机还没装好 DSH)由 service worker 打开;设置页
// 「本地启动器」未安装时的「安装引导」按钮也会打开它。内容与侧栏引导是同一份
// (features/onboarding/setup-guide.js),检测到装好后切到「一切就绪」,
// 提示用户打开侧栏开始使用。
import { initTheme } from "../app/sidepanel/theme.js";
import { createSettings } from "../platform/storage/settings.js";
import { probeHost } from "../platform/dsh/native-supervisor.js";
import { mountSetupGuide } from "../features/onboarding/setup-guide.js";
import { lucideIconSvg } from "../features/chat/file-icons.js";
import { setLang, getLang, t } from "../shared/i18n.js";

const theme = initTheme();
const settings = createSettings();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/// 用户在 chrome://extensions/shortcuts 里可能改过快捷键,以实际绑定为准。
async function panelShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const bound = commands.find((command) => command.name === "open_sidepanel")?.shortcut;
    if (bound) return bound;
  } catch { /* 读不到就用默认值 */ }
  return /Mac/i.test(navigator.userAgent) ? "⌘⇧D" : "Ctrl+Shift+D";
}

// sidePanel.open 必须在用户手势的同步调用栈里发起,不能先 await 再开 ——
// 所以窗口 id 提前取好。
let windowId = null;
chrome.windows?.getCurrent?.().then((win) => { windowId = win?.id ?? null; }).catch(() => {});

async function showReady() {
  const host = document.querySelector("#welcome-ready");
  const shortcut = await panelShortcut();
  const [before, after = ""] = t("welcome.readyBody").split("{shortcut}");
  host.innerHTML = "<h2>" + lucideIconSvg("circle-check", { size: 18 }) + escapeHtml(t("welcome.readyTitle")) + "</h2>"
    + "<p>" + escapeHtml(before) + "<kbd>" + escapeHtml(shortcut) + "</kbd>" + escapeHtml(after) + "</p>"
    + '<button class="btn primary" type="button" id="welcome-open-panel">' + escapeHtml(t("welcome.openPanel")) + "</button>"
    + "<p>" + escapeHtml(t("welcome.pin")) + "</p>";
  host.hidden = false;
  host.querySelector("#welcome-open-panel").addEventListener("click", () => {
    const open = windowId != null
      ? chrome.sidePanel.open({ windowId })
      : chrome.runtime.sendMessage({ type: "open_sidepanel" });
    Promise.resolve(open).catch(() => {});
  });
}

async function main() {
  try { setLang(await settings.getLang()); } catch { /* 默认中文 */ }
  settings.getThemePreference?.().then((value) => theme.setPreference(value)).catch(() => {});
  document.documentElement.lang = getLang() === "zh" ? "zh" : "en";
  document.title = t("welcome.title");
  document.querySelector("#welcome-title").textContent = t("welcome.title");

  const status = await probeHost();
  if (status?.ok) { await showReady(); return; }

  const guideHost = document.querySelector("#setup-guide");
  const guide = mountSetupGuide(guideHost, {
    probe: probeHost,
    onReady: async () => {
      // 让"已检测到"在屏幕上停一下,再切到就绪态,免得一闪而过看不清发生了什么。
      await new Promise((resolve) => setTimeout(resolve, 800));
      guide.dispose();
      await showReady();
    }
  });
  const issue = ["host-missing", "host-forbidden", "host-broken", "native-messaging-unavailable"].includes(status?.reason)
    ? status.reason : "host-missing";
  await guide.show(issue, status?.detail ?? "");
}

main().catch((error) => console.error("[dsh] welcome page failed", error));
