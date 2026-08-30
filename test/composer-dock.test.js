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

function setup(sessionModels) {
  const call = vi.fn(async (method) => {
    if (method === "session.models") return sessionModels;
    if (method === "session.selectModel") return {};
    return {};
  });
  const elements = {
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
  const state = { sessionId: "s1", currentModel: null };
  const deps = {
    connection: { call },
    commands: { execute: vi.fn() },
    sessions: { listStore: { get: () => [] }, getRuntimeSnapshot: () => ({}) }
  };
  const dock = createComposerDock({ elements, deps, state, showToast: vi.fn(), format: (e) => String(e) });
  return { dock, call, elements, state };
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

    const modelCall = call.mock.calls.find(([m]) => m === "session.selectModel");
    expect(modelCall).toBeTruthy();
    expect(modelCall[1]).toMatchObject({ provider: "p1", model: "m2" });
    expect(elements.modelLabel.textContent).toBe("Model 2");

    // 再点击推理档 high:必须作用在刚选的 m2 上,而不是旧模型 m1
    const high = elements.modelMenu.querySelector('[data-item-id="effort::high"]');
    expect(high).toBeTruthy();
    high.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const effortCall = call.mock.calls.find(([m, p]) => m === "session.selectModel" && p?.reasoningEffort);
    expect(effortCall).toBeTruthy();
    expect(effortCall[1]).toMatchObject({ provider: "p1", model: "m2", reasoningEffort: "high" });
  });
});
