// @vitest-environment jsdom
// 设置页接线:用真实 index.html + 真实 mountSettings,配一个假宿主,
// 验证六个 tab 能切、各 pane 真的渲染出内容、写回真的发出了对应 RPC。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mountSettings } from "../src/app/sidepanel/settings/settings-root.js";
import { setLang } from "../src/shared/i18n.js";

const html = readFileSync(resolve(process.cwd(), "pages/sidepanel/index.html"), "utf8");

const NAMESPACES = [
  { ns: "agent-presets", revision: 1, value: { default: "code" }, user: { default: "code" }, base: {} },
  { ns: "permission", revision: 1, value: { defaultPreset: "workspace-write" }, user: {}, base: {} },
  { ns: "locale", revision: 1, value: { preference: "zh" }, user: {}, base: {} },
  { ns: "ui-theme", revision: 1, value: { preference: "system" }, user: {}, base: {} },
  { ns: "ui-conversation", revision: 1, value: { busyEnter: "queue" }, user: {}, base: {} },
  { ns: "shell", revision: 4, value: { timeoutMs: 60000, maxOutputBytes: 64000 }, user: {}, base: { timeoutMs: 60000, maxOutputBytes: 64000 } },
  { ns: "agent-loop", revision: 2, value: { maxParallelToolCalls: 10 }, user: {}, base: {} },
  { ns: "llm-deepseek", revision: 1, value: { apiKeyEnv: "DEEPSEEK_API_KEY" }, user: {}, base: {} },
  { ns: "llm-pi-ai", revision: 1, value: {}, user: {}, base: {}, schema: { refs: { 1: { type: "const", value: "openai-chat" } } } }
];

function mountDom() {
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");
  // jsdom 没实现 <dialog> 的模态方法。
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.showModal = function showModal() { this.open = true; };
    dialog.close = function close() { this.open = false; this.dispatchEvent(new Event("close")); };
  }
}

function stubDeps(overrides = {}) {
  const calls = [];
  const call = vi.fn(async (method, payload) => {
    calls.push([method, payload]);
    if (overrides.fail?.[method]) throw new Error(overrides.fail[method]);
    switch (method) {
      case "settings.describe":
        return { namespaces: overrides.namespaces ?? NAMESPACES, writable: overrides.writable ?? true, hasDocument: true };
      case "settings.mutate":
      case "settings.update":
        return { ns: payload.ns, revision: 99, value: {}, user: {}, base: {} };
      case "settings.openDocument": return { opened: true };
      case "agentPreset.list":
        return {
          authorable: true,
          presets: [
            { id: "standard", trust: "system", name: "标准模式", description: "d1" },
            { id: "code", trust: "system", name: "PTC 模式", description: "d2" },
            { id: "mine", trust: "user", name: "我的预设", description: "d3" }
          ]
        };
      case "agentPreset.read": return { agentPreset: payload.agentPreset, content: "plugins:\n  - a" };
      case "llm.providers":
        return {
          providers: [
            { provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
            { provider: "acme", displayName: "Acme", settingsNs: "llm-pi-ai", settingsPath: ["providers", "acme"] }
          ]
        };
      case "credentials.describe":
        return { credentials: { DEEPSEEK_API_KEY: { configured: true, writable: true } } };
      case "credentials.set": return {};
      case "pluginInventory/list":
        return { entries: [
          { entryId: "include:llm", moduleName: "@deepseek-ai/dsh-llm", enabled: true, fiberPhase: "active" },
          { entryId: "include:hmr", moduleName: "@deepseek-ai/cordis-plugin-hmr", enabled: false, fiberPhase: null }
        ] };
      case "llm.discoverModels": return { models: overrides.discovered ?? [] };
      case "host.describe": return { home: "/Users/u", version: "1.2.3" };
      default: return {};
    }
  });
  return {
    calls,
    deps: {
      DshStreamState: { CONNECTED: "connected" },
      // 真实 connection 暴露的是 streamState(三态),没有 connected 字段 ——
      // stub 必须照着真接口给,否则会替一个读错字段的实现打掩护。
      connection: {
        baseUrl: "http://127.0.0.1:3080", call,
        streamState: "connected",
        setBackendUrl: vi.fn().mockResolvedValue("http://127.0.0.1:3080")
      },
      settings: {
        getBackendUrl: vi.fn().mockResolvedValue("http://127.0.0.1:3080"),
        getNotificationsEnabled: vi.fn().mockResolvedValue(true),
        setNotificationsEnabled: vi.fn().mockResolvedValue(undefined)
      },
      models: { refresh: vi.fn().mockResolvedValue([]) },
      setLang: vi.fn(),
      getLang: () => "zh",
      formatErrorDetails: (error) => String(error?.message ?? error),
      showToast: vi.fn()
    }
  };
}

/**
 * Stub the two worker channels the server pane reads.
 *
 * - sendNativeMessage → probeHost(): supplies the log directory and the
 *   "reused the server already running" phrase.
 * - sendMessage → get_state: supplies the CDP bridge row.
 *
 * Both matter for rows the design shows, so a test that asserts on them
 * without this helper would be vacuous (the rows are simply absent).
 */
function stubNativeHost({
  host = { ok: true, logDir: "/Users/user/Library/Logs/DSHMac", dsh: "/usr/local/bin/dsh" },
  bridge = { connected: true, shouldConnect: true, url: "ws://127.0.0.1:37086/chrome/ws" }
} = {}) {
  const sendNativeMessage = vi.fn().mockResolvedValue(host);
  const sendMessage = vi.fn().mockResolvedValue(bridge);
  globalThis.chrome = {
    ...(globalThis.chrome ?? {}),
    runtime: { ...(globalThis.chrome?.runtime ?? {}), sendNativeMessage, sendMessage }
  };
  return { sendNativeMessage, sendMessage };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open(overrides) {
  mountDom();
  const stub = stubDeps(overrides);
  const settings = mountSettings(stub.deps);
  document.querySelector("#hdr-settings").click();
  await flush(); await flush(); await flush();
  return { ...stub, settings };
}

function clickTab(name) {
  document.querySelector(`.settings-tab[data-tab="${name}"]`).click();
}

beforeEach(() => {
  setLang("zh");
  // 每个用例自己决定要不要 stubNativeHost():留着上一个用例的 chrome mock 会让
  // 「启动器没装」那条路径永远测不到。
  delete globalThis.chrome;
  // 这套 jsdom 没提供 localStorage(见 theme.test 的同名告警),而设置页把
  // "上次看的 tab" 记在里面 —— 补一个内存实现,顺带证明存取真的走了它。
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  };
});

describe("tab 骨架", () => {
  it("六个 tab 都在,默认选中通用", async () => {
    await open();
    const tabs = [...document.querySelectorAll(".settings-tab")].map((tab) => tab.dataset.tab);
    // Git 不在设置页:它的入口在聊天区右上角(对齐 Mac WorkspaceGitAction)。
    expect(tabs).toEqual(["general", "models", "presets", "plugins", "server", "shortcuts"]);
    expect(document.querySelector(".settings-tab.active").dataset.tab).toBe("general");
    expect(document.querySelector("#settings-pane-general").hidden).toBe(false);
    expect(document.querySelector("#settings-pane-models").hidden).toBe(true);
  });

  it("点 tab 切换可见 pane 并更新 aria-selected", async () => {
    await open();
    clickTab("models");
    await flush(); await flush();
    expect(document.querySelector("#settings-pane-models").hidden).toBe(false);
    expect(document.querySelector("#settings-pane-general").hidden).toBe(true);
    expect(document.querySelector('[data-tab="models"]').getAttribute("aria-selected")).toBe("true");
  });

  it("方向键在 tab 条内左右移动", async () => {
    await open();
    const bar = document.querySelector("#settings-tabs");
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush(); await flush();
    expect(document.querySelector(".settings-tab.active").dataset.tab).toBe("models");
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await flush(); await flush();
    expect(document.querySelector(".settings-tab.active").dataset.tab).toBe("general");
  });

  it("选中的 tab 记在本地,下次打开回到同一页", async () => {
    await open();
    clickTab("plugins");
    await flush(); await flush();
    expect(localStorage.getItem("dsh_settings_tab")).toBe("plugins");
  });

  it("语言切换后 tab 文案跟着换", async () => {
    await open();
    expect(document.querySelector('[data-tab="general"]').textContent).toBe("通用设置");
    setLang("en");
    document.querySelector("#hdr-settings").click();
    await flush(); await flush();
    expect(document.querySelector('[data-tab="general"]').textContent).toBe("General");
  });
});

describe("通用 pane", () => {
  it("通用页只剩宿主设置:后端地址与 CDP 桥都不在这里", async () => {
    await open();
    const pane = document.querySelector("#settings-pane-general");
    expect(pane.querySelector("#set-backend")).toBeNull();
    expect(pane.querySelector("#set-bridge-section")).toBeNull();
  });

  it("照搬 Mac 的行:预设 / 权限 / 语言 / 外观 / 通知 / Enter 行为 / 配置文件", async () => {
    await open();
    for (const id of ["#set-agent-preset", "#set-permission", "#set-lang", "#set-theme",
      "#set-notifications", "#set-enter-behavior", "#set-open-document"]) {
      expect(document.querySelector(id), id).toBeTruthy();
    }
  });

  it("不渲染「打开 Workspace 使用」—— 扩展枚举不到本机应用", async () => {
    await open();
    expect(document.querySelector("#set-workspace-editor")).toBeNull();
  });

  it("预设下拉带上宿主预设,并选中当前默认", async () => {
    await open();
    const select = document.querySelector("#set-agent-preset");
    expect([...select.options].map((option) => option.value)).toEqual(["standard", "code", "mine"]);
    expect(select.value).toBe("code");
  });

  it("改权限默认值发出 settings.mutate", async () => {
    const { calls } = await open();
    const select = document.querySelector("#set-permission");
    select.value = "danger-full-access";
    select.dispatchEvent(new Event("change"));
    await flush(); await flush();
    const mutate = calls.find(([method, payload]) => method === "settings.mutate" && payload.ns === "permission");
    expect(mutate[1]).toMatchObject({
      ns: "permission",
      ops: [{ op: "set", path: ["defaultPreset"], value: "danger-full-access" }],
      expectedRevision: 1
    });
  });

  it("改 Enter 行为写 ui-conversation.busyEnter", async () => {
    const { calls } = await open();
    const select = document.querySelector("#set-enter-behavior");
    select.value = "steer";
    select.dispatchEvent(new Event("change"));
    await flush(); await flush();
    expect(calls.find(([m, p]) => m === "settings.mutate" && p.ns === "ui-conversation")[1].ops)
      .toEqual([{ op: "set", path: ["busyEnter"], value: "steer" }]);
  });

  it("语言改动同时切本地文案与宿主偏好", async () => {
    const { calls, deps } = await open();
    const select = document.querySelector("#set-lang");
    select.value = "en";
    select.dispatchEvent(new Event("change"));
    await flush(); await flush();
    expect(deps.setLang).toHaveBeenCalledWith("en");
    expect(calls.find(([m, p]) => m === "settings.mutate" && p.ns === "locale")).toBeTruthy();
  });

  it("通知开关写扩展本地存储,不打宿主", async () => {
    const { deps } = await open();
    const toggle = document.querySelector("#set-notifications");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(deps.settings.setNotificationsEnabled).toHaveBeenCalledWith(false);
  });

  it("命名空间缺席的行整行不渲染", async () => {
    await open({ namespaces: [] });
    expect(document.querySelector("#set-permission")).toBeNull();
    expect(document.querySelector("#set-enter-behavior")).toBeNull();
    // 语言是本地也有的偏好,所以仍然渲染。
    expect(document.querySelector("#set-lang")).toBeTruthy();
  });

  it("只读部署给出说明", async () => {
    await open({ writable: false });
    expect(document.querySelector("#settings-pane-general").textContent).toContain("只读");
  });
});

describe("模型 pane", () => {
  it("列出已配置提供方与密钥状态", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-models");
    expect(pane.textContent).toContain("DeepSeek");
    expect(pane.textContent).toContain("API 密钥已配置");
  });

  it("未配置的提供方出现在添加标签云里", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    expect(document.querySelector('[data-add-provider="acme"]')).toBeTruthy();
    expect(document.querySelector("#prov-add-custom")).toBeTruthy();
  });

  it("点提供方行打开编辑器,含密钥/地址/目录三段", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    document.querySelector("#prov-edit-deepseek-official").click();
    await flush();
    const sheet = document.querySelector("#settings-sheet-body");
    expect(sheet.querySelector("#prov-key")).toBeTruthy();
    expect(sheet.querySelector("#prov-baseurl")).toBeTruthy();
    expect(sheet.querySelector("#cat-add")).toBeTruthy();
  });

  it("编辑器初始不可保存,改了地址才可保存", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    document.querySelector("#prov-edit-deepseek-official").click();
    await flush();
    expect(document.querySelector("#prov-save").disabled).toBe(true);
    const input = document.querySelector("#prov-baseurl");
    input.value = "https://x/v1";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector("#prov-save").disabled).toBe(false);
  });

  it("保存地址发出对应 path op", async () => {
    const { calls } = await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    document.querySelector("#prov-edit-deepseek-official").click();
    await flush();
    const input = document.querySelector("#prov-baseurl");
    input.value = "https://x/v1";
    input.dispatchEvent(new Event("input"));
    document.querySelector("#prov-save").click();
    await flush(); await flush(); await flush();
    const mutate = calls.find(([m, p]) => m === "settings.mutate" && p.ns === "llm-deepseek");
    expect(mutate[1].ops).toEqual([{ op: "set", path: ["baseURL"], value: "https://x/v1" }]);
  });

  it("自定义提供方:非法路由标识给出提示且不可创建", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    document.querySelector("#prov-add-custom").click();
    await flush();
    const route = document.querySelector("#cst-route");
    route.value = "Bad_Id";
    route.dispatchEvent(new Event("input"));
    await flush();
    expect(document.querySelector("#settings-sheet-body").textContent).toContain("小写字母");
    expect(document.querySelector("#cst-save").disabled).toBe(true);
  });

  it("自定义提供方:连接组顺序为 地址 → 密钥 → 协议", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    document.querySelector("#prov-add-custom").click();
    await flush();
    const ids = [...document.querySelectorAll("#settings-sheet-body .set-input, #settings-sheet-body .set-select")]
      .map((node) => node.id);
    expect(ids.indexOf("cst-baseurl")).toBeLessThan(ids.indexOf("cst-key"));
    expect(ids.indexOf("cst-key")).toBeLessThan(ids.indexOf("cst-api"));
  });

  it("自定义提供方:模型自成一组,不再有独立的凭证组", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    document.querySelector("#prov-add-custom").click();
    await flush();
    const headers = [...document.querySelectorAll("#settings-sheet-body .set-section-header")]
      .map((node) => node.textContent);
    expect(headers).toEqual(["标识", "连接", "模型"]);
  });

  // 自动拉取的防抖是 600ms 真实延时。这里不用 fake timers:open() 本身
  // 要等真实的微任务/宏任务链,两者混用会互相卡死。
  const settle = (ms) => new Promise((done) => setTimeout(done, ms));

  async function openCustomSheet(overrides) {
    const stub = await open(overrides);
    clickTab("models");
    await flush(); await flush(); await flush();
    document.querySelector("#prov-add-custom").click();
    await flush();
    return stub;
  }

  function typeInto(selector, value) {
    const node = document.querySelector(selector);
    node.value = value;
    node.dispatchEvent(new Event("input"));
  }

  it("自定义提供方:填完地址和密钥后自动拉取,不用点按钮", async () => {
    const { calls } = await openCustomSheet();
    typeInto("#cst-baseurl", "https://gw/v1");
    typeInto("#cst-key", "sk-1");
    // 防抖窗口内不该发请求。
    expect(calls.some(([m]) => m === "llm.discoverModels")).toBe(false);
    await settle(800);
    expect(calls.some(([m]) => m === "llm.discoverModels")).toBe(true);
  });

  it("自定义提供方:只填地址不填密钥不会自动拉取", async () => {
    const { calls } = await openCustomSheet();
    typeInto("#cst-baseurl", "https://gw/v1");
    await settle(800);
    expect(calls.some(([m]) => m === "llm.discoverModels")).toBe(false);
  });

  it("自定义提供方:拉到列表后模型 ID 只剩下拉框,文本框和拉取按钮都消失", async () => {
    await openCustomSheet({ discovered: [{ id: "glm-5.1" }, { id: "glm-4" }] });
    expect(document.querySelector("#cst-model")).toBeTruthy();
    typeInto("#cst-baseurl", "https://gw/v1");
    typeInto("#cst-key", "sk-1");
    await settle(800);
    await flush();
    const pick = document.querySelector("#cst-model-pick");
    expect(pick).toBeTruthy();
    expect(pick.value).toBe("glm-5.1");
    // 重复的「模型 ID」文本框必须消失,否则会出现两个绑定同一个值的字段。
    expect(document.querySelector("#cst-model")).toBeNull();
    expect(document.querySelector("#cst-fetch")).toBeNull();
  });

  it("搜索框是原生 type=search", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    const search = document.querySelector("#prov-add-search");
    expect(search.type).toBe("search");
    expect(search.placeholder).toBe("搜索提供方");
  });

  it("说明文字不再写死 OpenAI 协议", async () => {
    await open();
    clickTab("models");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-models");
    expect(pane.textContent).not.toContain("兼容 OpenAI 协议");
    expect(pane.textContent).toContain("受支持 API 协议");
  });

  it("自定义提供方:写回用 path 数组嵌进 providers 下,不是带斜杠的字面量键", async () => {
    // 回归:曾经用 settings.update 传 patch 键 "providers/<id>",而 update 的键是
    // 字面量键名不是路径,结果在命名空间根上建了个名叫 "providers/acme2" 的
    // 兄弟键 —— settings.yaml 里看得到,宿主却完全不认这个提供方。
    const { calls } = await openCustomSheet({ discovered: [{ id: "glm-5.1" }] });
    typeInto("#cst-route", "acme2");
    typeInto("#cst-baseurl", "https://gw/v1");
    typeInto("#cst-key", "sk-1");
    await settle(800);
    await flush();
    document.querySelector("#cst-save").click();
    await flush(); await flush(); await flush();

    expect(calls.find(([m]) => m === "settings.update")).toBeUndefined();
    const mutate = calls.find(([m, p]) => m === "settings.mutate" && p.ns === "llm-pi-ai");
    expect(mutate[1].ops).toEqual([
      { op: "set", path: ["providers", "acme2"], value: expect.objectContaining({ baseURL: "https://gw/v1" }) }
    ]);
    // 路径必须是分段的,任何一段都不能自己带斜杠。
    for (const segment of mutate[1].ops[0].path) expect(segment).not.toContain("/");
  });

  it("目录加载失败时给出重试", async () => {
    await open({ fail: { "llm.providers": "网络断了" } });
    clickTab("models");
    await flush(); await flush(); await flush();
    expect(document.querySelector("#prov-retry")).toBeTruthy();
  });
});

describe("设置弹窗的视口居中", () => {
  // 回归:foundation.css 的 `*` 重置把 margin 清成 0,盖掉了 UA 给 <dialog>
  // 的 margin:auto,弹窗因此贴死在左上角。jsdom 不做布局,量不到实际位置,
  // 所以直接断言这两条声明还在 —— 少了任何一条居中就会退化。
  const css = readFileSync(resolve(process.cwd(), "src/app/sidepanel/styles/composer.css"), "utf8");
  // 注释里也写着 inset:0 / margin:auto,不剥掉就会自己把自己测绿。
  const block = css
    .slice(css.indexOf("#settings-sheet {"), css.indexOf("#settings-sheet::backdrop"))
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("弹窗铺满 inset 并用 margin:auto 两轴居中", () => {
    expect(block).toMatch(/inset:\s*0/);
    expect(block).toMatch(/margin:\s*auto/);
  });

  it("高度跟内容走,否则 inset:0 会把弹窗拉满整个视口", () => {
    expect(block).toMatch(/height:\s*fit-content/);
  });
});

describe("预设 pane", () => {
  it("内置与自定义分两段列出", async () => {
    await open();
    clickTab("presets");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-presets");
    expect(pane.textContent).toContain("内置");
    expect(pane.textContent).toContain("自定义");
    expect(pane.textContent).toContain("我的预设");
  });

  it("当前默认预设标记「当前使用」", async () => {
    await open();
    clickTab("presets");
    await flush(); await flush(); await flush();
    const row = document.querySelector("#pset-row-code");
    expect(row.textContent).toContain("当前使用");
  });

  it("点非默认行设为默认", async () => {
    const { calls } = await open();
    clickTab("presets");
    await flush(); await flush(); await flush();
    document.querySelector("#pset-row-standard").click();
    await flush(); await flush(); await flush();
    const mutate = calls.find(([m, p]) => m === "settings.mutate" && p.ns === "agent-presets");
    expect(mutate[1].ops).toEqual([{ op: "set", path: ["default"], value: "standard" }]);
  });

  it("查看按钮读出预设内容", async () => {
    await open();
    clickTab("presets");
    await flush(); await flush(); await flush();
    document.querySelector("#pset-view-standard").click();
    await flush(); await flush();
    expect(document.querySelector("#settings-sheet-body").textContent).toContain("plugins:");
  });

  it("不提供复制 / 删除 / 打开目录 / 创作入口(已确认不做)", async () => {
    await open();
    clickTab("presets");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-presets");
    expect(pane.querySelector('[id^="pset-copy-"]')).toBeNull();
    expect(pane.querySelector('[id^="pset-del-"]')).toBeNull();
    expect(pane.querySelector('[id^="pset-folder-"]')).toBeNull();
    // 注意:"创造模式"是 cordis 预设的展示名,可以出现在列表里;
    // 不该出现的是那句创作按钮文案。
    expect(pane.textContent).not.toContain("用「创造模式」创作");
    // 每行只有"查看"一个尾随动作。
    const actions = pane.querySelectorAll(".set-icon-btn");
    expect(actions.length).toBe(3);
    for (const action of actions) expect(action.id.startsWith("pset-view-")).toBe(true);
  });
});

describe("插件 pane", () => {
  it("两个子 tab:可配置 / 插件清单", async () => {
    await open();
    clickTab("plugins");
    await flush(); await flush();
    const tabs = [...document.querySelectorAll("[data-subtab]")].map((tab) => tab.dataset.subtab);
    expect(tabs).toEqual(["configurable", "inventory"]);
  });

  it("只渲染部署组装了的可配置卡片,不渲染联网搜索(已确认不做)", async () => {
    await open();
    clickTab("plugins");
    await flush(); await flush();
    const pane = document.querySelector("#settings-pane-plugins");
    expect(pane.querySelector("#plug-head-shell")).toBeTruthy();
    expect(pane.querySelector("#plug-head-agent-loop")).toBeTruthy();
    expect(pane.querySelector("#plug-head-web-search-deepseek")).toBeNull();
  });

  it("展开卡片露出字段与页脚,初始不可保存", async () => {
    await open();
    clickTab("plugins");
    await flush(); await flush();
    document.querySelector("#plug-head-shell").click();
    await flush();
    expect(document.querySelector("#plug-shell-timeoutMs")).toBeTruthy();
    expect(document.querySelector("#plug-save-shell").disabled).toBe(true);
  });

  it("改字段后可保存,保存发出 settings.mutate 并带上 revision", async () => {
    const { calls } = await open();
    clickTab("plugins");
    await flush(); await flush();
    document.querySelector("#plug-head-shell").click();
    await flush();
    const input = document.querySelector("#plug-shell-timeoutMs");
    input.value = "30000";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector("#plug-save-shell").disabled).toBe(false);
    document.querySelector("#plug-save-shell").click();
    await flush(); await flush(); await flush();
    const mutate = calls.find(([m, p]) => m === "settings.mutate" && p.ns === "shell");
    expect(mutate[1]).toMatchObject({
      ops: [{ op: "set", path: ["timeoutMs"], value: 30000 }],
      expectedRevision: 4
    });
  });

  it("非法数字让保存保持禁用", async () => {
    await open();
    clickTab("plugins");
    await flush(); await flush();
    document.querySelector("#plug-head-shell").click();
    await flush();
    const input = document.querySelector("#plug-shell-timeoutMs");
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector("#plug-save-shell").disabled).toBe(true);
  });

  it("部署未组装任何可配置命名空间时给出说明", async () => {
    await open({ namespaces: [] });
    clickTab("plugins");
    await flush(); await flush();
    expect(document.querySelector("#settings-pane-plugins").textContent).toContain("未组装");
  });

  it("插件清单列出条目并可展开看 entryId", async () => {
    await open();
    clickTab("plugins");
    await flush(); await flush();
    document.querySelector('[data-subtab="inventory"]').click();
    await flush(); await flush();
    const pane = document.querySelector("#settings-pane-plugins");
    expect(pane.textContent).toContain("dsh-llm");
    expect(pane.textContent).toContain("已启用");
    pane.querySelector('[data-inv="include:llm"]').click();
    await flush();
    expect(pane.textContent).toContain("include:llm");
  });

  it("插件清单搜索过滤条目", async () => {
    await open();
    clickTab("plugins");
    await flush(); await flush();
    document.querySelector('[data-subtab="inventory"]').click();
    await flush(); await flush();
    const search = document.querySelector("#inv-search");
    search.value = "hmr";
    search.dispatchEvent(new Event("input"));
    await flush();
    const pane = document.querySelector("#settings-pane-plugins");
    expect(pane.textContent).toContain("cordis-plugin-hmr");
    expect(pane.textContent).not.toContain("dsh-llm");
  });
});

describe("服务端 pane", () => {
  it("按稿铺开:状态 / 服务地址 / Harness 主目录 / 重启", async () => {
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    expect(pane.textContent).toContain("已连接");
    expect(pane.textContent).toContain("服务地址");
    expect(pane.textContent).toContain("http://127.0.0.1:3080");
    // host.describe 回了 home,所以主目录行连按钮一起出现。
    expect(pane.textContent).toContain("Harness 主目录");
    expect(pane.querySelector("#srv-reveal-home")).toBeTruthy();
  });

  it("启动器 probe 成功后画出日志行", async () => {
    stubNativeHost();
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    // 路径按 native-host 的约定拼:logDir + /dsh-web.log。
    expect(pane.textContent).toContain("/Users/user/Library/Logs/DSHMac/dsh-web.log");
    expect(pane.querySelector("#srv-view-log")).toBeTruthy();
  });

  it("状态行只报连接状态,不缀服务来源说明", async () => {
    // 曾经缀一句「—— 复用了已在运行的服务」。它讲的是本次是谁拉起了服务,
    // 而这一行要回答的是"现在通不通" —— 两件事挤一行,读的人得先分辨。
    stubNativeHost();
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const state = document.querySelector("#srv-state");
    expect(state.textContent.trim()).toBe("已连接");
    expect(document.querySelector("#settings-pane-server").textContent)
      .not.toContain("复用了已在运行的服务");
  });

  it("查看日志走 host.openPath,带拼好的日志文件路径", async () => {
    stubNativeHost();
    const { calls } = await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    document.querySelector("#srv-view-log").click();
    await flush(); await flush();
    const opened = calls.filter(([m]) => m === "host.openPath");
    expect(opened.length).toBe(1);
    expect(opened[0][1]).toEqual({ path: "/Users/user/Library/Logs/DSHMac/dsh-web.log" });
  });

  it("启动器没装时,日志行不画(不编造路径)", async () => {
    // 没有 chrome.runtime.sendNativeMessage → probeHost 直接回 ok:false。
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    expect(pane.querySelector("#srv-view-log")).toBeNull();
    expect(pane.textContent).not.toContain("dsh-web.log");
  });

  it("连不上本地 daemon 时,重启段整段不画", async () => {
    // 测试环境里没有 chrome-daemon,serverOps.version() 会失败 → dshUnsupported。
    // 此时画一个按不动的「重启服务」比不画更糟:它承诺了一个做不到的操作。
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    expect(pane.querySelector("#srv-dsh-restart")).toBeNull();
    expect(pane.textContent).not.toContain("重启会中断进行中的会话");
  });

  it("服务地址按链接色渲染,但不是可点的 <a>", async () => {
    // 扩展页打不开 file:,做成 <a> 只会给出一个哪儿都到不了的手势。
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const url = document.querySelector("#settings-pane-server .srv-url");
    expect(url).toBeTruthy();
    expect(url.tagName).toBe("SPAN");
  });

  it("不再有后端地址输入框与宿主代理开关(版式以稿为准)", async () => {
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    for (const id of ["#srv-backend", "#srv-backend-save", "#srv-launcher-test", "#srv-host-disable"]) {
      expect(pane.querySelector(id), id).toBeNull();
    }
  });

  it("Agent 浏览器控制并进服务信息卡的最后一行,不再单独占一张卡", async () => {
    stubNativeHost();
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    // 桥曾经是一张自带表头、只有一行的独立卡片(#set-bridge-section)。
    expect(pane.querySelector("#set-bridge-section")).toBeNull();
    const state = pane.querySelector("#set-bridge-state");
    expect(state).toBeTruthy();
    // 它现在住在"日志"那一行所在的同一张卡里,并且是最后一行。
    const card = state.closest(".set-section");
    const labels = [...card.querySelectorAll(".set-row-label")].map((el) => el.textContent.trim());
    expect(labels).toContain("日志");
    expect(labels[labels.length - 1]).toBe("Agent 浏览器控制");
  });

  it("桥只报连接状态,没有开关(Agent 控制不可关闭)", async () => {
    stubNativeHost();
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    // 开关一旦存在,用户就能把自己关进"装了却不工作"的故障态里。
    expect(pane.querySelector("#set-bridge-enabled")).toBeNull();
    expect(pane.querySelector(".set-switch")).toBeNull();
    expect(pane.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("桥的状态每秒自刷,且不重画整页(不换掉按钮)", async () => {
    // 回归:桥那一行现在由 pane 渲染,它的刷新必须只补那一行。
    // 整页重画会把用户正按着的按钮换成新节点。
    vi.useFakeTimers();
    try {
      stubNativeHost();
      const stub = stubDeps();
      mountDom();
      mountSettings(stub.deps);
      document.querySelector("#hdr-settings").click();
      await vi.advanceTimersByTimeAsync(10);
      clickTab("server");
      await vi.advanceTimersByTimeAsync(50);
      const restart = document.querySelector("#srv-dsh-restart");
      const state = document.querySelector("#set-bridge-state");
      expect(state).toBeTruthy();
      await vi.advanceTimersByTimeAsync(2500);
      // 桥行还在,重启按钮还是同一个节点。
      expect(document.querySelector("#set-bridge-state")).toBeTruthy();
      expect(document.querySelector("#srv-dsh-restart")).toBe(restart);
    } finally {
      vi.useRealTimers();
    }
  });

  it("这个部署没有桥半部时,整行不画(不画一盏永不亮的灯)", async () => {
    // 没有 chrome.runtime.sendMessage → available:false。
    globalThis.chrome = { runtime: { sendNativeMessage: async () => ({ ok: false }) } };
    await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    const pane = document.querySelector("#settings-pane-server");
    expect(pane.querySelector("#set-bridge-state")).toBeNull();
    expect(pane.textContent).not.toContain("Agent 浏览器控制");
  });

  it("连接状态点区分三态:已连接 / 连接中 / 未连接", async () => {
    for (const [streamState, kind, text] of [
      ["connected", "ok", "已连接"],
      ["connecting", "busy", "连接中…"],
      ["disconnected", "err", "未连接"]
    ]) {
      const stub = stubDeps();
      stub.deps.connection.streamState = streamState;
      stub.deps.DshStreamState = {
        CONNECTED: "connected", CONNECTING: "connecting", DISCONNECTED: "disconnected"
      };
      mountDom();
      mountSettings(stub.deps);
      document.querySelector("#hdr-settings").click();
      await flush(); await flush();
      clickTab("server");
      await flush(); await flush(); await flush();
      const dot = document.querySelector("#srv-state .set-status");
      expect(dot.className, streamState).toContain(kind);
      expect(dot.textContent, streamState).toContain(text);
    }
  });

  it("状态点按秒自刷,且不重画输入框(不抢焦点)", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubDeps();
      stub.deps.connection.streamState = "connecting";
      stub.deps.DshStreamState = {
        CONNECTED: "connected", CONNECTING: "connecting", DISCONNECTED: "disconnected"
      };
      mountDom();
      mountSettings(stub.deps);
      document.querySelector("#hdr-settings").click();
      await vi.advanceTimersByTimeAsync(10);
      clickTab("server");
      await vi.advanceTimersByTimeAsync(10);
      const restart = document.querySelector("#srv-dsh-restart");
      expect(document.querySelector("#srv-state .set-status").className).toContain("busy");
      // 后台连上了:不切 tab、不重开页面,状态点也应自己转绿。
      stub.deps.connection.streamState = "connected";
      await vi.advanceTimersByTimeAsync(1200);
      expect(document.querySelector("#srv-state .set-status").className).toContain("ok");
      // 重启按钮是同一个节点 —— 每秒的状态自刷没有整页重画。
      expect(document.querySelector("#srv-dsh-restart")).toBe(restart);
    } finally {
      vi.useRealTimers();
    }
  });

  it("在 Finder 中查看走 host.openPath,带 host.describe 给的 home", async () => {
    const { deps, calls } = await open();
    clickTab("server");
    await flush(); await flush(); await flush();
    document.querySelector("#srv-reveal-home").click();
    await flush(); await flush();
    const opened = calls.filter(([m]) => m === "host.openPath");
    expect(opened.length).toBe(1);
    expect(opened[0][1]).toEqual({ path: "/Users/u" });
    expect(deps).toBeTruthy();
  });
});

// 用户反馈的两个设置页 bug 的回归位。
describe("模型目录变更的同步与发现", () => {
  it("获取可用模型把 api 协议一并带给宿主", async () => {
    // acme 是自定义提供方,profile 里存着 api —— 宿主靠它选发现驱动。
    // 以前这个字段被丢掉,宿主收不到协议,按钮点下去就报错。
    const namespaces = NAMESPACES.map((ns) => (ns.ns === "llm-pi-ai"
      ? {
          ...ns,
          value: { providers: { acme: { api: "openai-chat", baseURL: "https://acme/v1", apiKeyEnv: "ACME_API_KEY" } } },
          user: { providers: { acme: { api: "openai-chat", baseURL: "https://acme/v1", apiKeyEnv: "ACME_API_KEY" } } }
        }
      : ns));
    const { calls } = await open({ namespaces });
    clickTab("models");
    await flush(); await flush(); await flush();
    // 有了 profile,acme 就是已配置提供方,走编辑行而不是添加标签。
    document.querySelector("#prov-edit-acme").click();
    await flush();

    // 发现需要密钥:填一个,按钮才可点。
    const key = document.querySelector("#prov-key");
    key.value = "sk-test";
    key.dispatchEvent(new Event("input"));
    await flush();

    document.querySelector("#cat-fetch").click();
    await flush(); await flush(); await flush();

    const discover = calls.find(([m]) => m === "llm.discoverModels");
    expect(discover).toBeTruthy();
    expect(discover[1].api).toBe("openai-chat");
    expect(discover[1].provider).toBe("acme");
    expect(discover[1].baseURL).toBe("https://acme/v1");
  });

  it("保存提供方后通知外部刷新对话框的模型菜单", async () => {
    // 这是"设置页配好新提供方,回到对话框模型选项没更新"那个 bug:
    // 设置页必须把变更喊出来,否则底栏那颗菜单没人通知。
    mountDom();
    const stub = stubDeps();
    const onModelsChanged = vi.fn();
    mountSettings(stub.deps, { onModelsChanged });
    document.querySelector("#hdr-settings").click();
    await flush(); await flush(); await flush();
    clickTab("models");
    await flush(); await flush(); await flush();

    document.querySelector("#prov-edit-deepseek-official").click();
    await flush();
    const input = document.querySelector("#prov-baseurl");
    input.value = "https://x/v1";
    input.dispatchEvent(new Event("input"));
    document.querySelector("#prov-save").click();
    await flush(); await flush(); await flush();

    // 全局目录要重拉,底栏菜单也要被通知 —— 两者缺一都会让用户看到旧模型。
    expect(stub.deps.models.refresh).toHaveBeenCalled();
    expect(onModelsChanged).toHaveBeenCalled();
  });
});
describe("快捷键 pane", () => {
  it("渲染分区与和弦,且不发任何宿主 RPC", async () => {
    const { calls } = await open();
    const before = calls.length;
    clickTab("shortcuts");
    await flush(); await flush();
    const pane = document.querySelector("#settings-pane-shortcuts");
    expect(pane.hidden).toBe(false);
    // 命令表是纯前端数据,这一页不该跟宿主说话。
    expect(calls.length).toBe(before);
    expect(pane.querySelectorAll(".set-section").length).toBeGreaterThan(0);
    expect(pane.querySelectorAll("kbd.sc-key").length).toBeGreaterThan(0);
    expect(pane.textContent).toContain("发送消息");
  });

  it("列出命令表里的每一条命令", async () => {
    const { COMMANDS } = await import("../src/features/shortcuts/command-table.js");
    await open();
    clickTab("shortcuts");
    await flush(); await flush();
    const pane = document.querySelector("#settings-pane-shortcuts");
    expect(pane.querySelectorAll(".set-row").length).toBe(COMMANDS.length);
  });

  // 这条是实测补的:曾经每个和弦只画一个键帽("⌃⌘L" 挤成一块),
  // 因为渲染去按 "+" 拆 chordLabel,而 mac 的字形是连写的。
  it("每个修饰键与主键各自成一个键帽", async () => {
    await open();
    clickTab("shortcuts");
    await flush(); await flush();
    const pane = document.querySelector("#settings-pane-shortcuts");
    const rowOf = (title) => [...pane.querySelectorAll(".set-row")]
      .find((row) => row.querySelector(".set-row-label")?.textContent === title);
    const capsOf = (title) => [...rowOf(title).querySelectorAll("kbd.sc-key")].map((cap) => cap.textContent);
    // mac(jsdom 默认 platform 非 mac,故断言 win 档),⌥⌘↩ → Ctrl+Alt+Enter
    expect(capsOf("把草稿插入正在运行的轮次")).toEqual(["Ctrl", "Alt", "Enter"]);
    expect(capsOf("发送消息")).toEqual(["Enter"]);
    expect(capsOf("停止生成")).toEqual(["Esc"]);
    // 真正的不变量:一个键帽只承载一个键 —— 不塞多个 mac 修饰键字形,
    // 也不残留 "+"。"Backspace" 这类长键名是合法的,所以不能用长度当判据。
    for (const cap of pane.querySelectorAll("kbd.sc-key")) {
      const text = cap.textContent;
      expect(text, text).not.toMatch(/\+/);
      expect(text.match(/[⌘⌥⌃⇧]/g)?.length ?? 0, text).toBeLessThanOrEqual(1);
    }
  });

  it("没有和弦的条目用文字说明代替(⌘K 再按数字)", async () => {
    await open();
    clickTab("shortcuts");
    await flush(); await flush();
    const pane = document.querySelector("#settings-pane-shortcuts");
    expect(pane.querySelector(".sc-chord-note").textContent).toContain("1–9");
  });

  it("跟随语言切换重画", async () => {
    const { settings } = await open();
    clickTab("shortcuts");
    await flush(); await flush();
    setLang("en");
    settings.relabel();
    await flush(); await flush();
    const pane = document.querySelector("#settings-pane-shortcuts");
    expect(pane.textContent).toContain("Send message");
    expect(document.querySelector('[data-tab="shortcuts"]').textContent).toBe("Shortcuts");
    setLang("zh");
  });
});
