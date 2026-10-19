// Installs the DSH 0.1.2 browser-session cookie signed by the native host.
// The signing secret never enters extension storage; only the short-lived
// signed capability returned by the native host is handed to chrome.cookies.

import { toNativeHostError } from "./native-host-error.js";

const HOST_NAME = "com.dsh.chrome";

function extensionChrome() {
  return typeof chrome !== "undefined" ? chrome : null;
}

export async function installSessionCookie(baseUrl, { chromeApi = extensionChrome() } = {}) {
  if (!chromeApi?.runtime?.sendNativeMessage || !chromeApi?.cookies?.set) return false;
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "3080") {
    throw new Error("DSH 0.1.2 requires http://127.0.0.1:3080");
  }
  let signed;
  try {
    signed = await chromeApi.runtime.sendNativeMessage(HOST_NAME, {
      cmd: "cookie",
      host: url.hostname,
      port: Number(url.port)
    });
  } catch (error) {
    // 新用户最常见的就是这里:宿主没装,Chrome 抛 "Specified native messaging
    // host not found."。换成 NativeHostError,侧栏据此展示安装引导而不是原文。
    throw toNativeHostError(error) ?? error;
  }
  if (!signed?.ok || !signed.name || !signed.value) {
    const reason = signed?.reason || "failed to sign DSH browser session cookie";
    throw toNativeHostError(reason) ?? new Error(reason);
  }
  const installed = await chromeApi.cookies.set({
    url: url.origin + "/",
    name: signed.name,
    value: signed.value,
    path: "/",
    expirationDate: signed.expirationDate,
    // The mux runs in a 127.0.0.1 iframe under a chrome-extension:// top
    // level page. Strict/Lax cookies are excluded from that cross-site
    // WebSocket handshake, so Chrome needs an explicit third-party cookie.
    // Loopback is a potentially trustworthy origin and accepts Secure here.
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction"
  });
  if (!installed) throw new Error("Chrome rejected the DSH browser session cookie");
  return true;
}
