// @vitest-environment jsdom
// 胶囊 = 草稿里的真实字符段("\u00A0label\u00A0"),占真实宽度;
// 触碰即整体失效,残余字符由 reconcileDraft 剔除。
import { describe, it, expect } from "vitest";
import {
  CHIP_PAD, chipRun, projectDraft, reconcileEdit, reconcileDraft,
  insertReference, renderChipMirror
} from "../src/app/sidepanel/composer-chips.js";

const ref = (label, text) => ({ label, text });

describe("composer chips", () => {
  it("inserts the label run plus a trailing space", () => {
    const r = insertReference("", [], { start: 0, end: 0 }, ref("theme.js", "@src/app/theme.js"));
    expect(r.text).toBe(chipRun("theme.js") + " ");
    expect(r.caret).toBe(chipRun("theme.js").length + 1);
    expect(r.occurrences).toMatchObject([
      { label: "theme.js", text: "@src/app/theme.js", invalid: false, offset: 0, length: chipRun("theme.js").length }
    ]);
  });

  it("replaces the trigger span", () => {
    const r = insertReference("看 @the", [], { start: 2, end: 6 }, ref("theme.js", "@src/app/theme.js"));
    expect(r.text).toBe("看 " + chipRun("theme.js") + " ");
  });

  it("projects label runs back to full text on send", () => {
    const r = insertReference("看 ", [], { start: 2, end: 2 }, ref("theme.js", "@src/app/theme.js"));
    const final = projectDraft(r.text + "这个文件", r.occurrences);
    expect(final).toBe("看 @src/app/theme.js 这个文件");
  });

  it("keeps two chips independent and ordered", () => {
    let s = insertReference("", [], { start: 0, end: 0 }, ref("a.js", "@a.js"));
    s = insertReference(s.text, s.occurrences, { start: s.caret, end: s.caret }, ref("b.js", "@b.js"));
    expect(projectDraft(s.text, s.occurrences)).toBe("@a.js @b.js ");
  });

  it("backspacing into a chip removes the whole run, not one character", () => {
    const s = insertReference("", [], { start: 0, end: 0 }, ref("theme.js", "@src/app/theme.js"));
    // 光标在胶囊后的空格前退格:删掉 run 的最后一个字符
    const edited = s.text.slice(0, s.text.length - 2) + " ";
    const caretAfterBackspace = s.text.length - 2;
    const next = reconcileDraft(s.text, edited, s.occurrences, caretAfterBackspace);
    expect(next.occurrences).toHaveLength(0);
    expect(next.text).toBe(" ");
    expect(next.caret).toBe(0);
  });

  it("typing inside a chip dissolves it and keeps only the typed character", () => {
    const s = insertReference("", [], { start: 0, end: 0 }, ref("theme.js", "@x"));
    const mid = 3;
    const edited = s.text.slice(0, mid) + "z" + s.text.slice(mid);
    const next = reconcileDraft(s.text, edited, s.occurrences, mid + 1);
    expect(next.occurrences).toHaveLength(0);
    expect(next.text).toBe("z ");
    expect(next.caret).toBe(1);
  });

  it("keeps chips after the excised fragment aligned", () => {
    let s = insertReference("", [], { start: 0, end: 0 }, ref("a.js", "@a.js"));
    s = insertReference(s.text, s.occurrences, { start: s.caret, end: s.caret }, ref("b.js", "@b.js"));
    // 触碰第一枚(删它的第一个字符),第二枚必须原样存活
    const edited = s.text.slice(1);
    const next = reconcileDraft(s.text, edited, s.occurrences, 0);
    expect(next.occurrences).toHaveLength(1);
    expect(next.occurrences[0].label).toBe("b.js");
    expect(projectDraft(next.text, next.occurrences)).toBe(" @b.js ");
  });

  it("reconcileEdit only drops, never rewrites the draft (IME path)", () => {
    const s = insertReference("", [], { start: 0, end: 0 }, ref("a.js", "@a.js"));
    const edited = s.text.slice(1);
    const next = reconcileEdit(s.text, edited, s.occurrences);
    expect(next).toHaveLength(0);
  });

  it("renders chips into the mirror layer with exact draft characters", () => {
    const mirror = document.createElement("div");
    const s = insertReference("看 ", [], { start: 2, end: 2 }, ref("theme.js", "@src/app/theme.js"));
    renderChipMirror(mirror, s.text, s.occurrences);
    const chips = mirror.querySelectorAll(".composer-chip");
    expect(chips).toHaveLength(1);
    // 胶囊内容与草稿字符段逐字相同(含两侧 NBSP),宽度才能对齐
    expect(chips[0].textContent).toBe(CHIP_PAD + "theme.js" + CHIP_PAD);
    expect(mirror.textContent.startsWith("看 " + CHIP_PAD + "theme.js")).toBe(true);
  });
});
