// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSubagentCatalog } from "../src/features/subagents/subagent-catalog-view.js";

function makeDom() {
  const trigger = document.createElement("button");
  trigger.innerHTML = '<span class="subagent-dot"></span><span class="subagent-label"></span>';
  const menu = document.createElement("div");
  menu.matches = () => false;         // jsdom 无 popover 打开态,refresh 不回画列表
  menu.hidePopover = () => {};
  document.body.append(trigger, menu);
  return { trigger, menu };
}

function makeDeps({ count = 0, runningCount = 0 } = {}) {
  const listStore = {
    get: () => [],
    subagentDescendants: () => ({ count, runningCount }),
    subagentChildren: () => new Map()
  };
  return {
    deps: { sessions: { listStore, listSubagents: vi.fn() } }
  };
}

describe("mountSubagentCatalog 入口 chip", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("无子代理后代时隐藏 chip", () => {
    const { trigger, menu } = makeDom();
    const { deps } = makeDeps({ count: 0, runningCount: 0 });
    const m = mountSubagentCatalog(trigger, menu, { deps, getSessionId: () => "root", onOpenSubagent: vi.fn() });
    m.refresh();
    expect(trigger.hidden).toBe(true);
  });

  it("有运行中的子代理:显示 chip、点亮状态点", () => {
    const { trigger, menu } = makeDom();
    const { deps } = makeDeps({ count: 1, runningCount: 1 });
    mountSubagentCatalog(trigger, menu, { deps, getSessionId: () => "root", onOpenSubagent: vi.fn() }).refresh();
    expect(trigger.hidden).toBe(false);
    expect(trigger.querySelector(".subagent-label").textContent).toContain("子代理");
    expect(trigger.querySelector(".subagent-dot").classList.contains("running")).toBe(true);
  });
});
