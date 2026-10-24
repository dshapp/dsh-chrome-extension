// 首次使用 API Key 引导:判定口径(对齐 web onboardingReadiness / Mac evaluateOnboarding)
// 与弹窗交互(对齐 Mac DeepSeekOnboardingDialog)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  onboardingReadiness, providerUsable, DEEPSEEK_API_KEYS_URL, DEFAULT_CREDENTIAL_REF
} from "../src/features/onboarding/api-key-readiness.js";
import { createApiKeyOnboarding } from "../src/app/sidepanel/api-key-onboarding.js";
import { setLang, t } from "../src/shared/i18n.js";

function official({ active = true, apiKeyEnv = "DEEPSEEK_API_KEY", configured = false, writable = true } = {}) {
  return {
    entry: { provider: "deepseek-official", settingsNs: "llm-deepseek", settingsPath: [], active },
    apiKeyEnv,
    credential: apiKeyEnv ? { configured, writable } : null
  };
}

function piRow(provider, { active = false, apiKeyEnv = null, configured = false } = {}) {
  return {
    entry: { provider, settingsNs: "llm-pi-ai", settingsPath: ["providers", provider], active },
    apiKeyEnv,
    credential: apiKeyEnv ? { configured, writable: true } : null
  };
}

const fresh = (rows, extra = {}) => ({ rows, writable: true, credentialError: null, ...extra });

test("全新用户:只有未配 key 的官方路由 → 需要引导,引用名取 profile 的 apiKeyEnv", () => {
  assert.deepEqual(
    onboardingReadiness(fresh([official({ apiKeyEnv: "MY_DS_KEY" }), piRow("openai")])),
    { kind: "credential-missing", ref: "MY_DS_KEY" }
  );
});

test("任何一个可用的提供方都结束引导", () => {
  assert.equal(onboardingReadiness(fresh([official({ configured: true })])).kind, "provider-ready");
  // 别家提供方配了 key
  assert.equal(onboardingReadiness(fresh([
    official(), piRow("openai", { active: true, apiKeyEnv: "OPENAI_API_KEY", configured: true })
  ])).kind, "provider-ready");
  // 走自身认证链路的路由(profile 不命名凭证)
  assert.equal(onboardingReadiness(fresh([official(), piRow("bedrock", { active: true })])).kind, "provider-ready");
  // 已登录的账号路由(loadProviderRows 只在登录后保留这一行)
  assert.equal(onboardingReadiness(fresh([
    official(), { entry: { provider: "deepseek-account", settingsNs: "llm-deepseek-account", settingsPath: [], active: true }, apiKeyEnv: null }
  ])).kind, "provider-ready");
});

test("未启用的路由不算可用", () => {
  assert.equal(providerUsable(piRow("bedrock", { active: false })), false);
  assert.equal(providerUsable(official({ configured: true, active: false })), false);
});

test("这一步修不了的情形一律不弹", () => {
  assert.equal(onboardingReadiness(null).kind, "unavailable");
  assert.equal(onboardingReadiness(fresh([piRow("openai")])).kind, "adapter-absent");
  assert.deepEqual(onboardingReadiness(fresh([official({ active: false })])), { kind: "unavailable", reason: "provider-inactive" });
  assert.deepEqual(onboardingReadiness(fresh([official()], { credentialError: "boom" })), { kind: "unavailable", reason: "credentials-unavailable" });
  assert.deepEqual(onboardingReadiness(fresh([official()], { writable: false })), { kind: "unavailable", reason: "settings-read-only" });
  assert.deepEqual(onboardingReadiness(fresh([official({ writable: false })])), { kind: "unavailable", reason: "credential-read-only" });
});

// ---- 弹窗 ----

function setupDom() {
  const dom = new JSDOM('<body><dialog id="d"></dialog></body>', { pretendToBeVisual: true });
  const proto = dom.window.HTMLDialogElement.prototype;
  // jsdom 没实现 <dialog> 的模态 API,补最小语义。
  proto.showModal = function showModal() { this.setAttribute("open", ""); };
  proto.close = function close() { this.removeAttribute("open"); };
  Object.defineProperty(proto, "open", { get() { return this.hasAttribute("open"); }, configurable: true });
  return dom;
}

function fakeService(state, { failSet = null } = {}) {
  const calls = [];
  return {
    calls,
    async loadProviderRows() { return state; },
    async setCredential(ref, value) {
      calls.push({ ref, value });
      if (failSet) throw new Error(failSet);
    }
  };
}

function type(dom, value) {
  const input = dom.window.document.querySelector("#key-onb-input");
  input.value = value;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  return input;
}

test("缺 key 时弹出:标题、平台链接、保存前按钮不可用", async () => {
  setLang("zh");
  const dom = setupDom();
  const dialog = dom.window.document.querySelector("#d");
  const onboarding = createApiKeyOnboarding({ dialog, settingsService: fakeService(fresh([official()])) });
  const readiness = await onboarding.evaluate();
  assert.equal(readiness.kind, "credential-missing");
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector("#key-onb-title").textContent, "添加一个 API Key 开始使用");
  assert.equal(dialog.querySelector("#key-onb-link").getAttribute("href"), DEEPSEEK_API_KEYS_URL);
  assert.equal(dialog.querySelector("#key-onb-link").getAttribute("target"), "_blank");
  assert.equal(dialog.querySelector("#key-onb-input").type, "password");
  assert.equal(dialog.querySelector("#key-onb-save").disabled, true);
});

test("已配置的用户不弹", async () => {
  const dom = setupDom();
  const dialog = dom.window.document.querySelector("#d");
  const onboarding = createApiKeyOnboarding({ dialog, settingsService: fakeService(fresh([official({ configured: true })])) });
  assert.equal((await onboarding.evaluate()).kind, "provider-ready");
  assert.equal(dialog.open, false);
  assert.equal(dialog.innerHTML, "");
});

test("粘贴事故给出就地提示,合法 key 才能保存;保存写到官方引用并关闭", async () => {
  setLang("zh");
  const dom = setupDom();
  const dialog = dom.window.document.querySelector("#d");
  const service = fakeService(fresh([official()]));
  let saved = 0;
  const onboarding = createApiKeyOnboarding({ dialog, settingsService: service, onSaved: () => { saved += 1; } });
  await onboarding.evaluate();

  type(dom, "   ");
  assert.equal(dialog.querySelector("#key-onb-error").textContent, t("keyOnboarding.required"));
  assert.equal(dialog.querySelector("#key-onb-save").disabled, true);
  type(dom, "DEEPSEEK_API_KEY=sk-abc");
  assert.equal(dialog.querySelector("#key-onb-error").textContent, t("keyOnboarding.illegal"));
  assert.equal(dialog.querySelector("#key-onb-save").disabled, true);
  type(dom, '"sk-abc"');
  assert.equal(dialog.querySelector("#key-onb-error").textContent, t("keyOnboarding.illegal"));

  type(dom, "  sk-live-123  ");
  assert.equal(dialog.querySelector("#key-onb-error").textContent, "");
  assert.equal(dialog.querySelector("#key-onb-save").disabled, false);
  dialog.querySelector("#key-onb-save").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(service.calls, [{ ref: DEFAULT_CREDENTIAL_REF, value: "sk-live-123" }]);
  assert.equal(dialog.open, false);
  assert.equal(saved, 1);
});

test("Enter 提交;写失败时留在弹窗里显示错误并可重试", async () => {
  const dom = setupDom();
  const dialog = dom.window.document.querySelector("#d");
  const service = fakeService(fresh([official()]), { failSet: "credential store unavailable" });
  const onboarding = createApiKeyOnboarding({ dialog, settingsService: service, formatError: (error) => "E: " + error.message });
  await onboarding.evaluate();
  const input = type(dom, "sk-1");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(service.calls.length, 1);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector("#key-onb-error").textContent, "E: credential store unavailable");
  assert.equal(dialog.querySelector("#key-onb-save").disabled, false);
  // 改动输入即清掉宿主错误
  type(dom, "sk-2");
  assert.equal(dialog.querySelector("#key-onb-error").textContent, "");
});

test("「配置其他模型提供商」与 Esc 都把用户交给模型设置页", async () => {
  const dom = setupDom();
  const dialog = dom.window.document.querySelector("#d");
  let routed = 0;
  const onboarding = createApiKeyOnboarding({
    dialog, settingsService: fakeService(fresh([official()])), onConfigureOther: () => { routed += 1; }
  });
  await onboarding.evaluate();
  dialog.querySelector("#key-onb-other").click();
  assert.equal(dialog.open, false);
  assert.equal(routed, 1);

  await onboarding.evaluate();
  assert.equal(dialog.open, true);
  const cancel = new dom.window.Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(dialog.open, false);
  assert.equal(routed, 2);
});

test("切换语言时重画,已输入的内容保留", async () => {
  setLang("zh");
  const dom = setupDom();
  const dialog = dom.window.document.querySelector("#d");
  const onboarding = createApiKeyOnboarding({ dialog, settingsService: fakeService(fresh([official()])) });
  await onboarding.evaluate();
  type(dom, "sk-keep");
  setLang("en");
  onboarding.relabel();
  assert.equal(dialog.querySelector("#key-onb-title").textContent, "Add an API key to get started");
  assert.equal(dialog.querySelector("#key-onb-other").textContent, "Configure another provider");
  assert.equal(dialog.querySelector("#key-onb-input").value, "sk-keep");
  setLang("zh");
});
