// @vitest-environment jsdom
// 权限药丸:完全访问时文字染警告色(对齐 Mac PermissionChip 的 warnLabel)。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createComposerDock, isFullAccessOption } from "../src/app/sidepanel/composer-dock.js";
import { setLang, t } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

function setup() {
  const el = (tag) => document.createElement(tag);
  const permBtn = el("button");
  const permLabel = el("span");
  permLabel.id = "perm-label";
  permBtn.append(permLabel);
  const permMenu = el("div");
  permMenu.hidePopover = () => {};
  const elements = {
    planChip: el("button"), permBtn, permLabel, permMenu,
    modelBtn: el("button"), modelLabel: el("span"), modelMenu: el("div"),
    presetBtn: el("button"), presetLabel: el("span"), presetMenu: el("div"),
    permConfirm: el("dialog")
  };
  const state = { sessionId: "s1", permissions: null };
  const deps = {
    commands: { execute: vi.fn().mockResolvedValue({}) },
    sessions: {
      getRuntimeSnapshot: () => ({ agentPreset: null }),
      listStore: { get: () => [] },
      listAgentPresets: vi.fn().mockResolvedValue({ presets: [] })
    }
  };
  const dock = createComposerDock({ elements, deps, state, showToast: vi.fn(), format: String });
  return { elements, dock, deps };
}

const perms = (currentValue) => ({
  currentValue,
  options: [
    { value: "read-only" }, { value: "workspace-write" }, { value: "danger-full-access" }
  ]
});

describe("完全访问识别", () => {
  it("认得宿主用过的几种写法", () => {
    for (const v of ["danger-full-access", "full-access", "full_access", "bypass", "yolo", "DANGER"]) {
      expect(isFullAccessOption(v)).toBe(true);
    }
  });
  it("其余模式不算", () => {
    for (const v of ["read-only", "workspace-write", "custom", null, undefined, ""]) {
      expect(isFullAccessOption(v)).toBe(false);
    }
  });
});

describe("权限药丸配色", () => {
  it("完全访问时标签带 warn", () => {
    const { elements, dock } = setup();
    dock.renderPermMenu(perms("danger-full-access"));
    expect(elements.permLabel.classList.contains("warn")).toBe(true);
    expect(elements.permLabel.textContent).toBe(t("perm.fullAccess"));
  });

  it("其余模式不带 warn", () => {
    const { elements, dock } = setup();
    for (const value of ["read-only", "workspace-write"]) {
      dock.renderPermMenu(perms(value));
      expect(elements.permLabel.classList.contains("warn")).toBe(false);
    }
  });

  it("从完全访问切回普通模式会摘掉 warn", () => {
    const { elements, dock } = setup();
    dock.renderPermMenu(perms("danger-full-access"));
    expect(elements.permLabel.classList.contains("warn")).toBe(true);
    // 同一个 label 复用:切换后必须真的摘掉,否则会一直红着。
    dock.renderPermMenu(perms("read-only"));
    expect(elements.permLabel.classList.contains("warn")).toBe(false);
  });
});
