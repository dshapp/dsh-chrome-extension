// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mountTriggerMenu } from "../src/app/sidepanel/trigger-menu.js";
import { projectDraft, reconcileEdit, renderChipMirror, PLACEHOLDER } from "../src/app/sidepanel/composer-chips.js";

function setup() {
  document.body.innerHTML = '<div id="input-wrap"><div id="input-mirror"></div><textarea id="input"></textarea></div><div id="trigger-menu" hidden></div>';
  const elements = { input: document.getElementById("input"), triggerMenu: document.getElementById("trigger-menu"), inputMirror: document.getElementById("input-mirror") };
  let occurrences = [], lastDraft = "";
  const deps = {
    commands: { commands: [] },
    skills: { skills: [{ name: "to-jira-guild", description: "归档" }, { name: "chrome", description: "浏览器" }] },
    sessions: { listStore: { get: () => [] } },
    references: { files: async () => ([{ name: "文件 · theme.js", description: "src/app/sidepanel/theme.js", value: "@src/app/sidepanel/theme.js", insertLabel: "theme.js" }]), sessions: async () => [] }
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
  return { elements, menu, type, state: () => ({ occurrences, sent: projectDraft(elements.input.value, occurrences) }) };
}
const names = (el) => [...el.querySelectorAll(".trigger-item-name")].map(n => n.textContent);

describe("skill fuzzy filtering", () => {
  it("finds to-jira-guild by the mid-word query 'jira'", async () => {
    const { elements, type } = setup();
    await type("/jira");
    expect(names(elements.triggerMenu)).toContain("/to-jira-guild");
  });
  it("still matches by prefix", async () => {
    const { elements, type } = setup();
    await type("/chr");
    expect(names(elements.triggerMenu)).toContain("/chrome");
  });
});

describe("@ reference inserts a chip", () => {
  it("puts one placeholder in the draft and a chip in the mirror", async () => {
    const { elements, menu, type, state } = setup();
    await type("@th");
    menu.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(elements.input.value).toBe(PLACEHOLDER + " ");
    const chips = elements.inputMirror.querySelectorAll(".composer-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("theme.js");
    expect(state().sent).toBe("@src/app/sidepanel/theme.js ");
  });

  it("expands the chip to the full path when sending after more typing", async () => {
    const { elements, menu, type, state } = setup();
    await type("@th");
    menu.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await type(elements.input.value + "看看这个");
    expect(state().sent).toBe("@src/app/sidepanel/theme.js 看看这个");
  });

  it("deleting the chip character removes the reference entirely", async () => {
    const { elements, menu, type, state } = setup();
    await type("@th");
    menu.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await type("");
    expect(state().occurrences).toHaveLength(0);
    expect(state().sent).toBe("");
    expect(elements.inputMirror.querySelectorAll(".composer-chip")).toHaveLength(0);
  });
});
