// 发送手势 → 投递模式,以及插队快捷键识别。
import { describe, it, expect } from "vitest";
import { resolveSubmitMode, isSteerChord, steerChordLabel } from "../src/features/prompt-queue/submit-mode.js";

describe("resolveSubmitMode", () => {
  it("queues when the agent is idle", () => {
    expect(resolveSubmitMode(false, "enter")).toBe("queue");
    // 空闲时连插队手势也只是普通发送:没有当前轮可插。
    expect(resolveSubmitMode(false, "modifier")).toBe("queue");
  });

  it("queues when steering is unavailable (subagent session)", () => {
    expect(resolveSubmitMode(true, "modifier", false)).toBe("queue");
  });

  it("steers on the modifier gesture while running", () => {
    expect(resolveSubmitMode(true, "modifier", true, "queue")).toBe("steer");
  });

  it("queues on a plain Enter while running by default", () => {
    expect(resolveSubmitMode(true, "enter", true, "queue")).toBe("queue");
  });

  it("inverts when the preference is steer", () => {
    expect(resolveSubmitMode(true, "enter", true, "steer")).toBe("steer");
    expect(resolveSubmitMode(true, "modifier", true, "steer")).toBe("queue");
  });
});

describe("isSteerChord", () => {
  const chord = (extra) => ({ key: "Enter", altKey: true, metaKey: true, ctrlKey: false, ...extra });

  it("accepts Option+Command+Enter on mac", () => {
    expect(isSteerChord(chord(), { mac: true })).toBe(true);
  });

  it("rejects Command+Enter without Option", () => {
    expect(isSteerChord(chord({ altKey: false }), { mac: true })).toBe(false);
  });

  it("rejects Option+Enter without Command", () => {
    expect(isSteerChord(chord({ metaKey: false }), { mac: true })).toBe(false);
  });

  it("rejects a plain Enter", () => {
    expect(isSteerChord({ key: "Enter" }, { mac: true })).toBe(false);
  });

  it("ignores non-Enter keys", () => {
    expect(isSteerChord(chord({ key: "a" }), { mac: true })).toBe(false);
  });

  it("uses Alt+Ctrl+Enter off mac", () => {
    expect(isSteerChord({ key: "Enter", altKey: true, ctrlKey: true }, { mac: false })).toBe(true);
    expect(isSteerChord(chord(), { mac: false })).toBe(false);
  });

  it("tolerates a missing event", () => {
    expect(isSteerChord(null)).toBe(false);
  });
});

describe("steerChordLabel", () => {
  it("renders per platform", () => {
    expect(steerChordLabel(true)).toBe("⌥⌘↩");
    // 主修饰键在前是 Windows 的书写惯例(Ctrl+Alt+Del,不是 Alt+Ctrl+Del)。
    expect(steerChordLabel(false)).toBe("Ctrl+Alt+Enter");
  });
});
