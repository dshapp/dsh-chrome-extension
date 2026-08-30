
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { mountTriggerMenu } from "../src/app/sidepanel/trigger-menu.js";

function setup(commands = [], skills = []) {
  document.body.innerHTML = '<textarea id="input"></textarea><div id="trigger-menu" hidden></div>';
  const elements = { input: document.getElementById("input"), triggerMenu: document.getElementById("trigger-menu") };
  const deps = {
    commands: { commands },
    skills: { skills },
    sessions: { listStore: { get: () => [] } },
    references: { files: async () => [], sessions: async () => [] }
  };
  const state = { sessionId: "s1" };
  const menu = mountTriggerMenu({ elements, deps, state });
  return { elements, menu };
}
const names = (el) => [...el.querySelectorAll(".trigger-item-name")].map(n => n.textContent);

async function type(elements, menu, text) {
  elements.input.value = text;
  elements.input.selectionStart = text.length;
  menu.handleInput();
  await Promise.resolve(); await Promise.resolve();
}

describe("trigger menu filtering", () => {
  const cmds = [{name:"clear"},{name:"compact"},{name:"config"},{name:"help"}];
  it("shows all on bare /", async () => {
    const { elements, menu } = setup(cmds);
    await type(elements, menu, "/");
    expect(names(elements.triggerMenu)).toEqual(["/clear","/compact","/config","/help"]);
  });
  it("narrows as you type more characters", async () => {
    const { elements, menu } = setup(cmds);
    await type(elements, menu, "/c");
    expect(names(elements.triggerMenu)).toEqual(["/clear","/compact","/config"]);
    await type(elements, menu, "/co");
    expect(names(elements.triggerMenu)).toEqual(["/compact","/config"]);
    await type(elements, menu, "/con");
    expect(names(elements.triggerMenu)).toEqual(["/config"]);
  });
  it("supports arrow keys and Enter", async () => {
    const { elements, menu } = setup(cmds);
    await type(elements, menu, "/c");
    const ev = (key) => { const e = new KeyboardEvent("keydown", { key, cancelable: true }); menu.handleKeyDown(e); return e; };
    ev("ArrowDown");
    expect(elements.triggerMenu.querySelector(".trigger-item.highlighted .trigger-item-name").textContent).toBe("/compact");
    ev("ArrowDown");
    expect(elements.triggerMenu.querySelector(".trigger-item.highlighted .trigger-item-name").textContent).toBe("/config");
    ev("ArrowUp");
    expect(elements.triggerMenu.querySelector(".trigger-item.highlighted .trigger-item-name").textContent).toBe("/compact");
    ev("Enter");
    expect(elements.input.value).toBe("/compact ");
  });
});
