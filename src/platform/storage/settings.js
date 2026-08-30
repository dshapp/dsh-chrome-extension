// DSH 后端连接设置(chrome.storage.local)。key 前缀 codemax_dsh_ 与原扩展隔离。
const DEFAULT_BACKEND_URL = "http://127.0.0.1:3080";

const KEYS = Object.freeze({
  backendUrl: "codemax_dsh_backend_url",
  lang: "codemax_dsh_lang",
  notificationsEnabled: "codemax_dsh_notifications_enabled"
});

async function resolveArea() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage.local;
  const { chromeShim } = await import("./chrome-shim.js");
  return chromeShim.storage.local;
}

export function createSettings() {
  return {
    KEYS,
    DEFAULT_BACKEND_URL,
    async getBackendUrl() {
      const area = await resolveArea();
      const value = await area.get([KEYS.backendUrl]);
      const url = value?.[KEYS.backendUrl];
      return typeof url === "string" && url ? url : DEFAULT_BACKEND_URL;
    },
    async setBackendUrl(url) {
      const normalized = normalizeBackendUrl(url);
      const area = await resolveArea();
      await area.set({ [KEYS.backendUrl]: normalized });
      return normalized;
    },
    async getLang() {
      const area = await resolveArea();
      const value = await area.get([KEYS.lang]);
      return value?.[KEYS.lang] || "zh";
    },
    async setLang(lang) {
      const area = await resolveArea();
      await area.set({ [KEYS.lang]: lang });
    },
    async getNotificationsEnabled() {
      const area = await resolveArea();
      const value = await area.get([KEYS.notificationsEnabled]);
      return value?.[KEYS.notificationsEnabled] !== false;
    },
    async setNotificationsEnabled(enabled) {
      const area = await resolveArea();
      await area.set({ [KEYS.notificationsEnabled]: Boolean(enabled) });
    }
  };
}

export function normalizeBackendUrl(url) {
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_BACKEND_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

// 从后端 URL 推导 WS 地址(http→ws, https→wss)。
export function toWebSocketUrl(baseUrl, path) {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname}${path}`.replace(/^\/\//, "/");
  return parsed.toString();
}
