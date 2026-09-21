// DSH 后端连接设置(chrome.storage.local)。key 前缀 dsh_ 与桥接侧的
// dsh_chrome_* 键错开(那组只属于 background.js)。
const DEFAULT_BACKEND_URL = "http://127.0.0.1:3080";

const KEYS = Object.freeze({
  backendUrl: "dsh_backend_url",
  lang: "dsh_lang",
  notificationsEnabled: "dsh_notifications_enabled",
  // ui-theme.preference 的本地镜像:侧栏要在宿主往返之前就画出正确颜色,
  // 宿主值仍是权威,启动后 describe 会把它纠回来(见 sidepanel-app)。
  themePreference: "dsh_theme_preference"
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
      // 0.1.2 的浏览器会话 Cookie 与 authority 绑定；旧版保存的 localhost、
      // 动态端口或远端地址不能复用，迁移时统一收敛到固定入口。
      return DEFAULT_BACKEND_URL;
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
    },
    async getThemePreference() {
      const area = await resolveArea();
      const value = await area.get([KEYS.themePreference]);
      return value?.[KEYS.themePreference] || "system";
    },
    async setThemePreference(preference) {
      const area = await resolveArea();
      await area.set({ [KEYS.themePreference]: preference });
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
  const normalized = parsed.toString().replace(/\/+$/, "");
  if (normalized !== DEFAULT_BACKEND_URL) throw new Error(`DSH 0.1.2 requires ${DEFAULT_BACKEND_URL}`);
  return normalized;
}

// 从后端 URL 推导 WS 地址(http→ws, https→wss)。
export function toWebSocketUrl(baseUrl, path) {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname}${path}`.replace(/^\/\//, "/");
  return parsed.toString();
}
