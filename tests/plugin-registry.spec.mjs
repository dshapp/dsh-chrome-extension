// dsh 0.1.7 插件安装下载源 + 多语言元数据。
// 两块都错得很安静:「自动」错把私有源改道到公共镜像不会报错,只会装上别人的包;
// 语言回退错了只会显示英文或技术名。这里逐条钉住 Mac/web 的规则。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY, REGISTRY_CHOICES,
  normalizeRegistry, automaticRegistry, resolveRegistryChoice,
  readRegistryChoice, saveRegistryChoice, registryName, registriesText
} from "../src/features/settings/plugin-registry.js";
import {
  resolveLocalizedText, bundleText, entryText
} from "../src/features/settings/plugin-meta.js";
import { setLang } from "../src/shared/i18n.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value))
  };
}

/// 假 service:记录是否 ping 过。
function probeService(registries, fastest) {
  const calls = [];
  return {
    calls,
    async pluginRegistries() { calls.push("registries"); return registries; },
    async fastestRegistry() { calls.push("fastest"); return fastest; }
  };
}

const DEFAULTS = { registry: null, fallbackRegistries: [NPMMIRROR_REGISTRY], resolved: "https://registry.npmjs.org" };

test("normalizeRegistry:小写主机 + 尾斜杠,非 http(s) 为 null", () => {
  assert.equal(normalizeRegistry("https://Registry.NPMJS.org"), OFFICIAL_NPM_REGISTRY);
  assert.equal(normalizeRegistry("https://npm.example.com/sub"), "https://npm.example.com/sub/");
  assert.equal(normalizeRegistry("ftp://x"), null);
  assert.equal(normalizeRegistry(""), null);
});

test("自动:pnpm 指向 npm 官方且镜像更快 → 从镜像开始", async () => {
  const service = probeService(DEFAULTS, NPMMIRROR_REGISTRY);
  assert.equal(await automaticRegistry(service), NPMMIRROR_REGISTRY);
  assert.deepEqual(service.calls, ["registries", "fastest"]);
});

test("自动:官方更快 / 探测无结果 → 省略 registry,交给宿主配置", async () => {
  assert.equal(await automaticRegistry(probeService(DEFAULTS, OFFICIAL_NPM_REGISTRY)), undefined);
  assert.equal(await automaticRegistry(probeService(DEFAULTS, null)), undefined);
});

test("自动:宿主配了首选源、pnpm 指向私有源或读不出、回退里没有镜像 → 不 ping", async () => {
  for (const registries of [
    { ...DEFAULTS, registry: "https://corp.example.com/" },
    { ...DEFAULTS, resolved: "https://corp.example.com/" },
    { ...DEFAULTS, resolved: null },
    { ...DEFAULTS, fallbackRegistries: [] }
  ]) {
    const service = probeService(registries, NPMMIRROR_REGISTRY);
    assert.equal(await automaticRegistry(service), undefined);
    assert.deepEqual(service.calls, ["registries"]);
  }
});

test("自动:老宿主没有端点(调用抛错)→ 省略 registry,不挡安装", async () => {
  const service = { async pluginRegistries() { throw new Error("unknown method"); } };
  assert.equal(await automaticRegistry(service), undefined);
});

test("选项 → 首先问的源;自定义地址按 REGISTRY_URL 校验", async () => {
  const service = probeService(DEFAULTS, NPMMIRROR_REGISTRY);
  assert.deepEqual(await resolveRegistryChoice({ choice: "official" }, service), { registry: OFFICIAL_NPM_REGISTRY });
  assert.deepEqual(await resolveRegistryChoice({ choice: "mirror" }, service), { registry: NPMMIRROR_REGISTRY });
  assert.deepEqual(await resolveRegistryChoice({ choice: "custom", custom: "  https://npm.corp/  " }, service),
    { registry: "https://npm.corp/" });
  assert.deepEqual(await resolveRegistryChoice({ choice: "custom", custom: "npm.corp" }, service), { invalid: true });
  assert.deepEqual(await resolveRegistryChoice({ choice: "automatic" }, service), { registry: NPMMIRROR_REGISTRY });
  // 显式选项不碰探测。
  assert.deepEqual(service.calls, ["registries", "fastest"]);
});

test("记住选择:缺省自动,非法值回落自动,自定义地址单独保存", () => {
  const storage = memoryStorage();
  assert.deepEqual(readRegistryChoice(storage), { choice: "automatic", custom: "" });
  saveRegistryChoice({ choice: "mirror" }, storage);
  saveRegistryChoice({ custom: "https://npm.corp/" }, storage);
  assert.deepEqual(readRegistryChoice(storage), { choice: "mirror", custom: "https://npm.corp/" });
  saveRegistryChoice({ choice: "bogus" }, storage);
  assert.equal(readRegistryChoice(storage).choice, "automatic");
  assert.deepEqual(REGISTRY_CHOICES, ["automatic", "official", "mirror", "custom"]);
});

test("源的读法与已尝试列表(Mac pluginRegistryName)", () => {
  setLang("zh");
  assert.equal(registryName(null), "pnpm 配置的源");
  assert.equal(registryName("https://registry.npmjs.org"), "npm 官方源");
  assert.equal(registryName(NPMMIRROR_REGISTRY), "npmmirror 国内镜像");
  assert.equal(registryName("https://npm.corp.example:8443/x/"), "npm.corp.example:8443");
  assert.equal(registriesText([NPMMIRROR_REGISTRY, null]), "已尝试的下载源:npmmirror 国内镜像 → pnpm 配置的源");
  assert.equal(registriesText([]), "");
  setLang("en");
  assert.equal(registryName(null), "pnpm's configured registry");
  setLang("zh");
});

test("LocalizedText 回退:字符串原样;完整 id → 主语言 → en;空串也算存在", () => {
  const text = { en: "Team", zh: "团队", "zh-tw": "團隊" };
  assert.equal(resolveLocalizedText("literal", "zh"), "literal");
  assert.equal(resolveLocalizedText(text, "zh"), "团队");
  assert.equal(resolveLocalizedText(text, "zh-TW"), "團隊");
  assert.equal(resolveLocalizedText(text, "zh-HK"), "团队");
  assert.equal(resolveLocalizedText(text, "fr"), "Team");
  assert.equal(resolveLocalizedText({ en: "E", zh: "" }, "zh"), "");
  assert.equal(resolveLocalizedText(undefined, "zh"), "");
});

test("bundle 文本:meta 优先;没有 meta 用包名与 manifest 说明", () => {
  setLang("zh");
  const meta = { title: { en: "Agent team", zh: "智能体团队" }, description: { en: "Desc", zh: "说明" } };
  assert.deepEqual(bundleText({ name: "@deepseek-ai/dsh-x", meta }), { title: "智能体团队", description: "说明" });
  setLang("en");
  assert.deepEqual(bundleText({ name: "@deepseek-ai/dsh-x", meta }), { title: "Agent team", description: "Desc" });
  setLang("zh");
  assert.deepEqual(bundleText({ name: "@deepseek-ai/dsh-x", description: "raw" }), { title: "@deepseek-ai/dsh-x", description: "raw" });
  // 译文说明为空串时回退 manifest 原文,不显示空白。
  assert.equal(bundleText({ name: "n", description: "raw", meta: { description: "" } }).description, "raw");
});

test("清单条目文本:译文原样,字面标题/缺省压成短名(web pluginText)", () => {
  setLang("zh");
  assert.deepEqual(entryText({ moduleName: "@scope/dsh-a", meta: { title: { en: "A", zh: "甲" }, description: "d" } }),
    { title: "甲", description: "d" });
  assert.equal(entryText({ moduleName: "@scope/dsh-a", meta: { title: "@scope/dsh-a" } }).title, "dsh-a");
  assert.equal(entryText({ moduleName: "cordis:include" }).title, "include");
  assert.equal(entryText({ moduleName: "@scope/dsh-a" }).description, "");
});
