// 快捷键表的守卫。这些断言就是这张表可信的全部理由:
// 1) 没有命令落在浏览器保留和弦上(否则该键位静默失效)
// 2) 同一平台内部没有两条命令抢同一个和弦
// 3) 每条命令两个平台都有交代(给了和弦,或明确写 null)
import { describe, it, expect } from "vitest";
import {
  COMMANDS, SECTIONS, MOD, chord, chordLabel, chordKeys, chordFor, matchesChord,
  commandForEvent, platformOf, shortcutReference,
  BROWSER_RESERVED_MAC, BROWSER_RESERVED_WIN
} from "../src/features/shortcuts/command-table.js";

const fingerprint = (value) => `${value.key}:${value.mods}`;

describe("命令表", () => {
  it("每条命令都有 id / 分区 / 标题,且分区是已声明的", () => {
    for (const command of COMMANDS) {
      expect(command.id, JSON.stringify(command)).toBeTruthy();
      expect(command.titleKey, command.id).toBeTruthy();
      expect(SECTIONS, command.id).toContain(command.section);
    }
  });

  it("id 不重复", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条命令两个平台都有交代(和弦或显式 null)", () => {
    for (const command of COMMANDS) {
      expect(command, command.id).toHaveProperty("mac");
      expect(command, command.id).toHaveProperty("win");
    }
  });

  for (const [kind, reserved] of [["mac", BROWSER_RESERVED_MAC], ["win", BROWSER_RESERVED_WIN]]) {
    it(`${kind}: 没有命令落在浏览器保留和弦上`, () => {
      const blocked = new Set(reserved.map(fingerprint));
      const offenders = [];
      for (const command of COMMANDS) {
        const value = chordFor(command, kind);
        if (!value || !blocked.has(fingerprint(value))) continue;
        // 只放过在表里显式登记的既有债,且必须同时标了 existing。
        if (command.reservedException === kind && command.existing) continue;
        offenders.push(`${command.id} → ${chordLabel(value, kind)}`);
      }
      expect(offenders).toEqual([]);
    });

    it(`${kind}: 同一平台内部和弦不冲突`, () => {
      const seen = new Map();
      const clashes = [];
      for (const command of COMMANDS) {
        const value = chordFor(command, kind);
        if (!value) continue;
        const print = fingerprint(value);
        if (seen.has(print)) clashes.push(`${seen.get(print)} 与 ${command.id} 抢 ${chordLabel(value, kind)}`);
        else seen.set(print, command.id);
      }
      expect(clashes).toEqual([]);
    });
  }

  it("落在保留表上的例外必须是既有键位,新命令不得申报例外", () => {
    for (const command of COMMANDS) {
      if (!command.reservedException) continue;
      expect(command.existing, `${command.id} 申报了例外但不是既有键位`).toBe(true);
    }
    // 当前只允许这一处既有债。新增例外必须先改这条断言,让评审看见。
    const declared = COMMANDS.filter((command) => command.reservedException).map((command) => command.id);
    expect(declared).toEqual(["toggleHistory"]);
  });

  it("既有键位保持不变(已形成肌肉记忆,不得改动)", () => {
    const byId = Object.fromEntries(COMMANDS.map((command) => [command.id, command]));
    expect(chordLabel(byId.toggleHistory.mac, "mac")).toBe("⌘K");
    expect(chordLabel(byId.toggleHistory.win, "win")).toBe("Ctrl+K");
    expect(chordLabel(byId.newSession.mac, "mac")).toBe("⇧⌘K");
    expect(chordLabel(byId.newSession.win, "win")).toBe("Ctrl+Shift+K");
    expect(chordLabel(byId.toggleElementPicker.mac, "mac")).toBe("⌘.");
    expect(chordLabel(byId.toggleElementPicker.win, "win")).toBe("Ctrl+.");
    expect(chordLabel(byId.steerDraft.mac, "mac")).toBe("⌥⌘↩");
    expect(chordLabel(byId.steerDraft.win, "win")).toBe("Ctrl+Alt+Enter");
  });

  it("mac 修饰键字形按 Apple 顺序 ⌃⌥⇧⌘", () => {
    expect(chordLabel(chord("x", MOD.control | MOD.alt | MOD.shift | MOD.primary), "mac")).toBe("⌃⌥⇧⌘X");
  });

  it("win 不产出 mac 专属字形", () => {
    for (const command of COMMANDS) {
      const label = chordLabel(chordFor(command, "win"), "win");
      expect(label, command.id).not.toMatch(/[⌘⌥⌃⇧]/);
    }
  });

  it("win 侧不使用 mac 的 ⌃ 位(Windows 只有一个 Ctrl)", () => {
    for (const command of COMMANDS) {
      const value = chordFor(command, "win");
      if (value) expect(Boolean(value.mods & MOD.control), command.id).toBe(false);
    }
  });

  // Chrome 惯用键的回归锁:这些键位是照官方快捷键表迁出来的,别改回去。
  it("win: Alt+Shift 必须带 Ctrl(裸 Alt+Shift 是 Windows 输入法切换键)", () => {
    for (const command of COMMANDS) {
      const value = chordFor(command, "win");
      if (!value || !(value.mods & MOD.alt) || !(value.mods & MOD.shift)) continue;
      expect(Boolean(value.mods & MOD.primary), command.id).toBe(true);
    }
  });

  it("迁出 Chrome 已占用的 mac 和弦(⌥⌘F 搜索网页 / ⌥⌘P 页面设置 / ⌥⌘↑ 焦点循环)", () => {
    const byId = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));
    expect(chordLabel(byId.findInSession.mac, "mac")).toBe("⇧⌘F");
    expect(chordLabel(byId.choosePermission.mac, "mac")).toBe("⇧⌘P");
    expect(chordLabel(byId.increaseEffort.mac, "mac")).toBe("⌥⇧⌘↑");
    expect(chordLabel(byId.decreaseEffort.mac, "mac")).toBe("⌥⇧⌘↓");
    expect(chordLabel(byId.findInSession.win, "win")).toBe("Ctrl+Shift+F");
    expect(chordLabel(byId.editGoal.win, "win")).toBe("Ctrl+Shift+E");
  });
});

describe("和弦拆成按键 token", () => {
  it("mac 逐个修饰键 + 主键,顺序同 ⌃⌥⇧⌘", () => {
    expect(chordKeys(chord("l", MOD.primary | MOD.control), "mac")).toEqual(["⌃", "⌘", "L"]);
    expect(chordKeys(chord("x", MOD.control | MOD.alt | MOD.shift | MOD.primary), "mac"))
      .toEqual(["⌃", "⌥", "⇧", "⌘", "X"]);
  });

  it("win 用词形修饰键,主修饰键在前", () => {
    expect(chordKeys(chord("enter", MOD.primary | MOD.alt), "win")).toEqual(["Ctrl", "Alt", "Enter"]);
  });

  it("多字符主键不被拆坏", () => {
    expect(chordKeys(chord("escape", MOD.none), "win")).toEqual(["Esc"]);
    expect(chordKeys(chord("escape", MOD.none), "mac")).toEqual(["Esc"]);
    expect(chordKeys(chord("backspace", MOD.primary | MOD.alt), "mac")).toEqual(["⌥", "⌘", "⌫"]);
  });

  it("token 拼起来等于 chordLabel(两条路径不会各说一套)", () => {
    for (const command of COMMANDS) {
      for (const kind of ["mac", "win"]) {
        const value = chordFor(command, kind);
        if (!value) continue;
        const joined = chordKeys(value, kind).join(kind === "mac" ? "" : "+");
        expect(joined, `${kind}/${command.id}`).toBe(chordLabel(value, kind));
      }
    }
  });

  it("没有和弦时是空数组,不是 [undefined]", () => {
    expect(chordKeys(null, "mac")).toEqual([]);
  });
});

describe("平台判定", () => {
  it("按 platform 串分档,linux 单独成档", () => {
    expect(platformOf("MacIntel")).toBe("mac");
    expect(platformOf("macOS")).toBe("mac");
    expect(platformOf("Win32")).toBe("win");
    expect(platformOf("Windows")).toBe("win");
    expect(platformOf("Linux x86_64")).toBe("linux");
    expect(platformOf("")).toBe("win");
  });
});

describe("和弦匹配", () => {
  const event = (over) => ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

  it("修饰键必须完全相等,子集不算命中", () => {
    const target = chord("enter", MOD.primary | MOD.alt);
    expect(matchesChord(event({ key: "Enter", metaKey: true, altKey: true }), target, "mac")).toBe(true);
    // 只按 ⌘ 不该命中 ⌥⌘↩ —— 否则普通发送会抢掉插队
    expect(matchesChord(event({ key: "Enter", metaKey: true }), target, "mac")).toBe(false);
    // 多按 ⇧ 也不算
    expect(matchesChord(event({ key: "Enter", metaKey: true, altKey: true, shiftKey: true }), target, "mac")).toBe(false);
  });

  it("输入法组字中不抢键", () => {
    const target = chord("k", MOD.primary);
    expect(matchesChord(event({ metaKey: true }), target, "mac")).toBe(true);
    expect(matchesChord({ ...event({ metaKey: true }), isComposing: true }, target, "mac")).toBe(false);
  });

  it("mac 的 ⌃ 与 ⌘ 分属不同位,不会互相误判", () => {
    const ctrlCmd = chord("l", MOD.primary | MOD.control);
    expect(matchesChord(event({ key: "l", metaKey: true, ctrlKey: true }), ctrlCmd, "mac")).toBe(true);
    expect(matchesChord(event({ key: "l", metaKey: true }), ctrlCmd, "mac")).toBe(false);
  });

  it("win 上 ctrlKey 映射到 primary", () => {
    expect(matchesChord(event({ ctrlKey: true }), chord("k", MOD.primary), "win")).toBe(true);
  });

  it("commandForEvent 能分派到具体命令", () => {
    expect(commandForEvent(event({ key: "k", metaKey: true }), "mac")).toBe("toggleHistory");
    expect(commandForEvent(event({ key: "k", metaKey: true, shiftKey: true }), "mac")).toBe("newSession");
    expect(commandForEvent(event({ key: "z", metaKey: true }), "mac")).toBe(null);
  });
});

describe("参考表视图", () => {
  it("按分区分组,每项都带该平台的文案", () => {
    for (const kind of ["mac", "win"]) {
      const groups = shortcutReference(kind);
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(SECTIONS).toContain(group.section);
        expect(group.items.length).toBeGreaterThan(0);
        for (const item of group.items) {
          expect(item.titleKey).toBeTruthy();
          // 要么有和弦文案,要么用 literalKey 交代(如 ⌘K 再按数字)
          expect(Boolean(item.label) || Boolean(item.literalKey), `${kind}/${item.id}`).toBe(true);
        }
      }
    }
  });

  it("覆盖了表里所有命令", () => {
    const listed = shortcutReference("mac").flatMap((group) => group.items.map((item) => item.id));
    expect(new Set(listed).size).toBe(COMMANDS.length);
  });
});
