// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createComposerDock } from "../src/app/sidepanel/composer-dock.js";
import { setLang } from "../src/shared/i18n.js";

function makeEl(tag = "div") {
  const el = document.createElement(tag);
  el.hidePopover = vi.fn();
  el.showPopover = vi.fn();
  return el;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function baseElements() {
  return {
    planChip: makeEl("button"),
    permBtn: makeEl("button"),
    permLabel: makeEl("span"),
    permMenu: makeEl(),
    permConfirm: makeEl("dialog"),
    modelLabel: makeEl("span"),
    modelMenu: makeEl(),
    presetBtn: makeEl("button"),
    presetLabel: makeEl("span"),
    presetMenu: makeEl()
  };
}

function setup(sessionModels) {
  const call = vi.fn(async (method) => {
    if (method === "session/selectModel") return {};
    return {};
  });
  const elements = baseElements();
  const state = { sessionId: "s1", currentModel: null };
  const deps = {
    connection: { call },
    commands: { execute: vi.fn() },
    sessions: { models: vi.fn().mockResolvedValue(sessionModels), listStore: { get: () => [] }, getRuntimeSnapshot: () => ({}) }
  };
  const dock = createComposerDock({ elements, deps, state, showToast: vi.fn(), format: (e) => String(e) });
  return { dock, call, elements, state, deps };
}

const FIXTURE = {
  current: { provider: "p1", model: "m1" },
  groups: [{
    id: "p1", name: "Provider 1",
    models: [{ id: "m1", name: "Model 1" }, { id: "m2", name: "Model 2" }]
  }],
  reasoningEfforts: ["low", "high"]
};

describe("composer-dock 模型与推理档", () => {
  beforeEach(() => setLang("en"));

  it("切换到新模型后再选推理档,应作用在新模型而非旧模型", async () => {
    const { dock, call, elements, state } = setup(FIXTURE);
    await dock.refreshModelMenu();
    expect(state.currentModel).toEqual({ provider: "p1", model: "m1" });

    // 点击模型 m2(PTC 模型切换)
    const m2 = elements.modelMenu.querySelector('[data-item-id="p1::m2"]');
    expect(m2).toBeTruthy();
    m2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const modelCall = call.mock.calls.find(([m]) => m === "session/selectModel");
    expect(modelCall).toBeTruthy();
    expect(modelCall[1].request).toMatchObject({ provider: "p1", model: "m2" });
    expect(elements.modelLabel.textContent).toBe("Model 2");

    // 再点击推理档 high:必须作用在刚选的 m2 上,而不是旧模型 m1
    const high = elements.modelMenu.querySelector('[data-item-id="effort::high"]');
    expect(high).toBeTruthy();
    high.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const effortCall = call.mock.calls.find(([m, p]) => m === "session/selectModel" && p?.request?.reasoningEffort);
    expect(effortCall).toBeTruthy();
    expect(effortCall[1].request).toMatchObject({ provider: "p1", model: "m2", reasoningEffort: "high" });
  });

  it("同一会话的旧模型目录响应不能覆盖后发刷新", async () => {
    const { dock, elements, deps } = setup(FIXTURE);
    let resolveOld;
    let resolveNew;
    deps.sessions.models
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const oldRequest = dock.refreshModelMenu();
    const newRequest = dock.refreshModelMenu();
    resolveNew({ ...FIXTURE, current: { provider: "p1", model: "m2" } });
    await newRequest;
    resolveOld(FIXTURE);
    await oldRequest;
    expect(elements.modelLabel.textContent).toBe("Model 2");
  });
});

describe("composer-dock 预设菜单", () => {
  beforeEach(() => setLang("en"));

  it("切到 B 后应能再切回 A(当前预设引用不过期)", async () => {
    const presets = [{ id: "a", name: "Preset A" }, { id: "b", name: "Preset B" }];
    const selectAgentPreset = vi.fn(async (_sid, id) => id);
    const elements = baseElements();
    const state = { sessionId: "s1", currentModel: null };
    const deps = {
      connection: { call: vi.fn(async () => ({})) },
      commands: { execute: vi.fn() },
      sessions: {
        listAgentPresets: vi.fn(async () => ({ presets })),
        selectAgentPreset,
        listStore: { get: () => [{ sessionId: "s1", agentPreset: "a" }] },
        getRuntimeSnapshot: () => ({ agentPreset: "a" })
      }
    };
    const dock = createComposerDock({ elements, deps, state, showToast: vi.fn(), format: (e) => String(e) });
    await dock.refreshPresetMenu();

    // 切到 B
    elements.presetMenu.querySelector('[data-item-id="b"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(selectAgentPreset).toHaveBeenCalledTimes(1);
    expect(selectAgentPreset).toHaveBeenLastCalledWith("s1", "b");

    // 再切回 A —— 必须再次调用 selectAgentPreset,而不是被“已是当前”的守卫吞掉
    elements.presetMenu.querySelector('[data-item-id="a"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(selectAgentPreset).toHaveBeenLastCalledWith("s1", "a");
  });

  it("较早的预设列表响应晚到时不会覆盖较新的列表", async () => {
    let resolveOld;
    let resolveNew;
    const elements = baseElements();
    const state = { sessionId: "s1", currentModel: null };
    const listAgentPresets = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const deps = {
      connection: { call: vi.fn(async () => ({})) },
      commands: { execute: vi.fn() },
      sessions: {
        listAgentPresets,
        selectAgentPreset: vi.fn(),
        listStore: { get: () => [{ sessionId: "s1", agentPreset: "new" }] },
        getRuntimeSnapshot: () => ({ agentPreset: "new" })
      }
    };
    const dock = createComposerDock({ elements, deps, state, showToast: vi.fn(), format: String });
    const oldRequest = dock.refreshPresetMenu();
    const newRequest = dock.refreshPresetMenu();
    resolveNew({ presets: [{ id: "new", name: "New" }] });
    await newRequest;
    resolveOld({ presets: [{ id: "old", name: "Old" }] });
    await oldRequest;
    expect(elements.presetLabel.textContent).toBe("New");
    expect(elements.presetMenu.querySelector('[data-item-id="old"]')).toBeNull();
  });
});
