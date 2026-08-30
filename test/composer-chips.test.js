// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { PLACEHOLDER, projectDraft, reconcileEdit, insertReference, renderChipMirror } from "../src/app/sidepanel/composer-chips.js";

const ref = (label, text) => ({ label, text });

describe("composer chips", () => {
  it("inserts a chip as one character plus a space", () => {
    const r = insertReference("", [], { start: 0, end: 0 }, ref("theme.js", "@src/app/theme.js"));
    expect(r.text).toBe(PLACEHOLDER + " ");
    expect(r.caret).toBe(2);
    expect(r.occurrences).toMatchObject([{ label: "theme.js", text: "@src/app/theme.js", invalid: false, offset: 0 }]);
  });

  it("replaces the trigger span", () => {
    const r = insertReference("看 @the", [], { start: 2, end: 6 }, ref("theme.js", "@src/app/theme.js"));
    expect(r.text).toBe("看 " + PLACEHOLDER + " ");
  });

  it("projects placeholders back to full text on send", () => {
    const r = insertReference("看 ", [], { start: 2, end: 2 }, ref("theme.js", "@src/app/theme.js"));
    const final = projectDraft(r.text + "这个文件", r.occurrences);
    expect(final).toBe("看 @src/app/theme.js 这个文件");
  });

  it("keeps two chips independent and ordered", () => {
    let s = insertReference("", [], { start: 0, end: 0 }, ref("a.js", "@a.js"));
    s = insertReference(s.text, s.occurrences, { start: s.caret, end: s.caret }, ref("b.js", "@b.js"));
    expect(projectDraft(s.text, s.occurrences)).toBe("@a.js @b.js ");
  });

  it("drops the occurrence when its placeholder is deleted", () => {
    let s = insertReference("", [], { start: 0, end: 0 }, ref("a.js", "@a.js"));
    s = insertReference(s.text, s.occurrences, { start: s.caret, end: s.caret }, ref("b.js", "@b.js"));
    // user backspaces the FIRST placeholder
    const edited = s.text.slice(1);
    const next = reconcileEdit(s.text, edited, s.occurrences);
    expect(next).toHaveLength(1);
    expect(projectDraft(edited, next)).toBe(" @b.js ");
  });

  it("strips orphan placeholders that have no occurrence", () => {
    expect(projectDraft("hi " + PLACEHOLDER + "!", [])).toBe("hi !");
  });

  it("renders chips into the mirror layer", () => {
    const mirror = document.createElement("div");
    const s = insertReference("看 ", [], { start: 2, end: 2 }, ref("theme.js", "@src/app/theme.js"));
    renderChipMirror(mirror, s.text, s.occurrences);
    const chips = mirror.querySelectorAll(".composer-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("theme.js");
    expect(mirror.textContent.startsWith("看 theme.js")).toBe(true);
  });
});