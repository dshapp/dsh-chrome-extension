// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mountTriggerMenu } from "../src/app/sidepanel/trigger-menu.js";
import { projectDraft, reconcileEdit, renderChipMirror, PLACEHOLDER } from "../src/app/sidepanel/composer-chips.js";

function setup() {
  document.body.innerHTML = '<div id="input-wrap"><div id="input-mirror"></div><textarea id="input"></textarea></div><div id="trigger-menu" hidden></div>';
  const elements = { input: document.getElementById("input"), triggerMenu: document.getElementById("trigger-menu"), inputMirror: document.getElementById("input-mirror") };
  let occurrences = [], lastDraft = "";
  const deps = {
    commands: { commands: [{ name: "compact", description: "压缩" }] },
    skills: { skills: [{ name: "chrome", description: "浏览器" }] },
    sessions: { listStore: { get: () => [] } },
    references: { files: async () => ([{ name: "文件 · theme.js", value: "@src/app/theme.js", insertLabel: "theme.js" }]), sessions: async () => [] }
  };
  const menu = mountTriggerMenu({
    elements, deps, state: { sessionId: "s1" },
    getOccurrences: () => occurrences,
    onInsertReference: (n) => { occurrences = n.occurrences; lastDraft = n.text; renderChipMirror(elements.inputMirror, n.text, occurrences); }
  });
  elements.input.addEventListener("input", () => {
    const d = elements.input.value;
    occurrences = reconcileEdit(lastDraft, d, occurrences); lastDraft = d;
    renderChipMirror(elements.inputMirror, d, occurrences);
    menu.handleInput();
  });
  const type = async (text) => {
    elements.input.value = text; elements.input.selectionStart = text.length;
    elements.input.dispatchEvent(new Event("input", { bubbles: true }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const enter = () => menu.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  return { elements, type, enter, sent: () => projectDraft(elements.input.value, occurrences) };
}
const chips = (el) => [...el.querySelectorAll(".composer-chip")].map(c => c.textContent);

describe("slash picks render as chips", () => {
  it("command becomes a chip labelled /compact", async () => {
    const { elements, type, enter, sent } = setup();
    await type("/comp");
    enter();
    expect(elements.input.value).toBe(PLACEHOLDER + " ");
    expect(chips(elements.inputMirror)).toEqual(["/compact"]);
    // 关键:发送时必须展开成命令原文,否则 tryDispatchCommand 匹配不到
    expect(sent()).toBe("/compact ");
  });

  it("skill becomes a chip and expands back to /chrome", async () => {
    const { elements, type, enter, sent } = setup();
    await type("/chr");
    enter();
    expect(chips(elements.inputMirror)).toEqual(["/chrome"]);
    expect(sent()).toBe("/chrome ");
  });

  it("@ chip still uses the short label", async () => {
    const { elements, type, enter, sent } = setup();
    await type("@th");
    enter();
    expect(chips(elements.inputMirror)).toEqual(["theme.js"]);
    expect(sent()).toBe("@src/app/theme.js ");
  });

  it("a command chip plus extra args still dispatches", async () => {
    const { elements, type, enter, sent } = setup();
    await type("/comp");
    enter();
    await type(elements.input.value + "再压一次");
    expect(sent()).toBe("/compact 再压一次");
    expect(sent().match(/^\/(\S+)/)[1]).toBe("compact");
  });
});
