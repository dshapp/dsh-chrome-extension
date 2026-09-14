// @vitest-environment jsdom
// i18n 全覆盖守卫:key 中英对齐、t() 引用的 key 必须存在、静态 DOM 能被本地化。
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { setLang, t } from "../src/shared/i18n.js";
import { applyStaticLabels } from "../src/app/sidepanel/static-labels.js";
import { createBackgroundNotifier } from "../src/features/notifications/background-notifier.js";

const root = resolve(import.meta.dirname, "..");
const i18nSource = readFileSync(resolve(root, "src/shared/i18n.js"), "utf8");
const html = readFileSync(resolve(root, "pages/sidepanel/index.html"), "utf8");
const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];

function keysOf(block) {
  const found = new Set();
  const re = /^\s*"([^"]+)"\s*:/gm;
  let match;
  while ((match = re.exec(block))) found.add(match[1]);
  return found;
}

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "vendor" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkJs(path, out);
    else if (path.endsWith(".js")) out.push(path);
  }
  return out;
}

const enStart = i18nSource.indexOf("en: Object.freeze({");
const zhStart = i18nSource.indexOf("zh: Object.freeze({");
const enKeys = keysOf(i18nSource.slice(enStart, zhStart));
const zhKeys = keysOf(i18nSource.slice(zhStart));

describe("i18n 字典", () => {
  it("中英 key 一一对应", () => {
    expect([...zhKeys].filter((key) => !enKeys.has(key))).toEqual([]);
    expect([...enKeys].filter((key) => !zhKeys.has(key))).toEqual([]);
    expect(enKeys.size).toBeGreaterThan(0);
  });

  it("代码里字面量 t() 引用的 key 都在字典里", () => {
    const missing = [];
    for (const file of walkJs(resolve(root, "src"))) {
      if (file.endsWith("shared/i18n.js")) continue;
      const source = readFileSync(file, "utf8");
      const re = /(?:^|[^\w.])t\(\s*["']([^"']+)["']/g;
      let match;
      while ((match = re.exec(source))) {
        if (!enKeys.has(match[1])) missing.push([file, match[1]].join(" :: "));
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("静态 DOM 本地化", () => {
  let host;
  beforeEach(() => {
    host = document.createElement("div");
    host.innerHTML = body;
  });

  it("英文:关键静态标签全部改写", () => {
    setLang("en");
    applyStaticLabels(host);
    expect(host.lang).toBe("en");
    expect(host.querySelector("#empty-title").textContent).toBe("Start a conversation");
    expect(host.querySelector("#history-search").placeholder).toBe("Search history…");
    expect(host.querySelector("#perm-confirm-title").textContent).toBe("Enable full access?");
    expect(host.querySelector("#settings-title").textContent).toBe("Settings");
    expect(host.querySelector("#attach-btn").getAttribute("aria-label")).toBe("Add context");
    setLang("zh");
  });

  it("中文:与首帧文案一致", () => {
    setLang("zh");
    applyStaticLabels(host);
    expect(host.lang).toBe("zh");
    expect(host.querySelector("#empty-title").textContent).toBe("开始对话");
    expect(host.querySelector("#perm-confirm-cancel").textContent).toBe("取消");
  });
});

describe("后台通知本地化", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("按扩展语言偏好切换通知文案", async () => {
    setLang("zh");
    const calls = [];
    const notifier = createBackgroundNotifier({
      notifications: { create: (id, options) => calls.push([id, options]) },
      settings: { getNotificationsEnabled: async () => true, getLang: async () => "en" }
    });
    notifier.reportFailure("s1", "boom");
    await tick();
    expect(calls[0][1].title).toBe("Agent error");
    expect(calls[0][1].message).toBe("Background task failed: boom");
    setLang("zh");
  });

  it("无语言偏好时退回中文默认文案(原有测试契约)", async () => {
    setLang("zh");
    const calls = [];
    const notifier = createBackgroundNotifier({
      notifications: { create: (id, options) => calls.push([id, options]) },
      settings: { getNotificationsEnabled: async () => true }
    });
    notifier.reportFailure("s1", "boom");
    await tick();
    expect(calls[0][1].message).toBe("后台任务失败:boom");
  });
});

describe("翻译取值", () => {
  it("缺 key 回退英文,再回退 key 本身", () => {
    setLang("zh");
    expect(t("notif.failed")).toBe("后台任务失败");
    setLang("en");
    expect(t("notif.failed")).toBe("Background task failed");
    expect(t("__nope__")).toBe("__nope__");
    setLang("zh");
  });
});
