import { describe, it, expect } from "vitest";
import { resolveTheme, initTheme } from "../src/app/sidepanel/theme.js";

describe("theme", () => {
  it("跟随系统主题:dark 媒体查询命中时为 dark,否则 light", () => {
    expect(resolveTheme({ matches: true })).toBe("dark");
    expect(resolveTheme({ matches: false })).toBe("light");
    expect(resolveTheme(null)).toBe("light");
    expect(resolveTheme(undefined)).toBe("light");
  });

  it("initTheme 启动时应用并监听系统主题变化", () => {
    const listeners = [];
    const media = {
      matches: true,
      addEventListener: (type, fn) => listeners.push(fn)
    };
    const attrs = {};
    const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
    const win = { matchMedia: (query) => (query === "(prefers-color-scheme: dark)" ? media : null) };

    initTheme(doc, win);
    expect(attrs["data-theme"]).toBe("dark");
    expect(listeners).toHaveLength(1);

    media.matches = false;
    listeners[0]();
    expect(attrs["data-theme"]).toBe("light");
  });

  it("无 matchMedia 环境退回 light 且不报错", () => {
    const attrs = {};
    const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
    initTheme(doc, {});
    expect(attrs["data-theme"]).toBe("light");
  });
});
