// Native Messaging supervisor — shared by the worker (daemon autostart) and
// the side panel page (web autostart + settings status row).
//
// Chrome extensions cannot spawn processes. The only sanctioned path is a
// Native Messaging host that this extension talks to over stdio. This module
// wraps that channel and is failure-driven + idempotent: the host probes the
// port before spawning, so a redundant call when the server is already up is a
// no-op, and a per-target cooldown keeps it off the hot reconnect path.
import { createSettings } from "../storage/settings.js";
import { classifyNativeFailure } from "./native-host-error.js";

const HOST_NAME = "com.dsh.chrome";
const COOLDOWN_MS = 30000;

const lastAttemptByTarget = new Map();

function canCallNative() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendNativeMessage);
}

/// sendNativeMessage 的异常 → 结构化失败。认得出的(宿主没装/没授权/起不来)
/// 换成稳定的 reason code,原文留在 detail;认不出的照旧把原文当 reason。
function nativeFailure(error) {
  const detail = String(error?.message || error || "native-call-failed");
  return { ok: false, reason: classifyNativeFailure(detail) ?? detail, detail };
}

function parseHostPort(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: parsed.port ? Number(parsed.port) : null
    };
  } catch {
    return { host: "127.0.0.1", port: null };
  }
}

/**
 * Ask the native host to start a target server, if one is not already up.
 * Returns the host's reply, or { ok:false, reason } when native messaging is
 * unavailable (no host manifest, no nativeMessaging permission, or cooldown).
 */
export async function ensureServerRunning(target, options = {}) {
  if (!canCallNative()) {
    return { ok: false, reason: "native-messaging-unavailable" };
  }
  // 先判目标合法性,再动冷却表。反过来的话,一个非法 target 会白占 30s 冷却:
  // 第一次如实回 unknown-target,第二次却回 cooldown —— 调用方据此以为"刚试过、
  // 稍后会好",而真实原因是个永远不会自愈的配置错误。
  if (target !== "web") return { ok: false, reason: "unknown-target" };

  const now = Date.now();
  const last = lastAttemptByTarget.get(target) || 0;
  if (!options.force && now - last < COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", retryAfter: COOLDOWN_MS - (now - last) };
  }
  lastAttemptByTarget.set(target, now);

  const message = { cmd: "start", target };
  const settings = createSettings();
  const url = options.backendUrl || (await settings.getBackendUrl());
  const { host, port } = parseHostPort(url);
  if (host) message.host = host;
  if (port) message.port = port;

  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST_NAME, message);
    return reply || { ok: false, reason: "empty-reply" };
  } catch (error) {
    return nativeFailure(error);
  }
}

/**
 * Ask the native host to restart dsh web: stop whatever dsh web listens on the
 * configured address, then start a fresh one there (the settings page's
 * "Restart server", the Mac app's restart).
 *
 * No cooldown: this only ever runs because the user pressed a button. An older
 * host answers { ok:false, reason:"unknown-cmd" }; callers fall back to the
 * chrome-daemon's restart in that case.
 */
export async function restartServer(target = "web", options = {}) {
  if (!canCallNative()) return { ok: false, reason: "native-messaging-unavailable" };
  if (target !== "web") return { ok: false, reason: "unknown-target" };
  const message = { cmd: "restart", target };
  const url = options.backendUrl || (await createSettings().getBackendUrl());
  const { host, port } = parseHostPort(url);
  if (host) message.host = host;
  if (port) message.port = port;
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST_NAME, message);
    return reply || { ok: false, reason: "empty-reply" };
  } catch (error) {
    return nativeFailure(error);
  }
}

/**
 * Probe the installed host without starting anything. Used by the settings
 * page to show whether the launcher is installed and resolvable.
 */
export async function probeHost() {
  if (!canCallNative()) return { ok: false, reason: "native-messaging-unavailable" };
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST_NAME, { cmd: "status" });
    return reply || { ok: false, reason: "empty-reply" };
  } catch (error) {
    return nativeFailure(error);
  }
}

export async function requestSessionCookie(host = "127.0.0.1", port = 3080) {
  if (!canCallNative()) return { ok: false, reason: "native-messaging-unavailable" };
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST_NAME, { cmd: "cookie", host, port });
    return reply || { ok: false, reason: "empty-reply" };
  } catch (error) {
    return nativeFailure(error);
  }
}

/**
 * 读 macOS 剪贴板(board:"general")或拖拽板(board:"drag")上文件/文件夹的
 * 绝对路径。浏览器不暴露粘贴/拖入项的真实路径,文件夹只能靠这里按路径引用。
 * 旧版宿主没有这条命令,会回 { ok:false, reason:"unknown-cmd" }。
 */
export async function requestPasteboardPaths(board) {
  if (!canCallNative()) return { ok: false, reason: "native-messaging-unavailable" };
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST_NAME, { cmd: "filePaths", board });
    return reply || { ok: false, reason: "empty-reply" };
  } catch (error) {
    return nativeFailure(error);
  }
}

export const NATIVE_HOST_NAME = HOST_NAME;
