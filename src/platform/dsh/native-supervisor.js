// Native Messaging supervisor — shared by the worker (daemon autostart) and
// the side panel page (web autostart + settings status row).
//
// Chrome extensions cannot spawn processes. The only sanctioned path is a
// Native Messaging host that this extension talks to over stdio. This module
// wraps that channel and is failure-driven + idempotent: the host probes the
// port before spawning, so a redundant call when the server is already up is a
// no-op, and a per-target cooldown keeps it off the hot reconnect path.
import { createSettings } from "../storage/settings.js";

const HOST_NAME = "com.dsh.chrome";
const COOLDOWN_MS = 30000;

const lastAttemptByTarget = new Map();

function canCallNative() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendNativeMessage);
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
    return { ok: false, reason: String(error?.message || error || "native-call-failed") };
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
    return { ok: false, reason: String(error?.message || error || "native-call-failed") };
  }
}

export const NATIVE_HOST_NAME = HOST_NAME;
