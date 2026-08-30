// 开发/测试环境的最小 chrome.storage shim(浏览器实测走真实 chrome API)。
const memory = new Map();
const listeners = new Set();

export const chromeShim = Object.freeze({
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return Object.fromEntries(memory);
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter((n) => memory.has(n)).map((n) => [n, memory.get(n)]));
      },
      async set(entries) {
        for (const [k, v] of Object.entries(entries)) memory.set(k, v);
        for (const listener of listeners) listener(entries, "local");
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) memory.delete(k);
      }
    },
    onChanged: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }
    }
  },
  __reset() {
    memory.clear();
    listeners.clear();
  }
});
