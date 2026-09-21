// 快捷键单一真源表。对齐 macos/.../Commands/AppCommand.swift 的设计:一条命令
// 一行,自带标题、分区与各平台的和弦。菜单/参考表/tooltip 全部从这里派生,所以
// 一条命令不可能只存在于某一处而在另一处缺失。
//
// 为什么按平台分别声明和弦,而不是存一份 mac 和弦再运行时换字符:
// mac 有 ⌘ 与 ⌃ 两个可用主修饰键,Windows 只有一个 Ctrl。把 ⌃⌘X 直译成
// Ctrl+Ctrl+X 是废的,机械替换必然产出无人使用的键位(现存三处 `mac ? A : B`
// 就是这么漂移的)。所以两平台各按本平台习惯选键,不要求字母一致 ——
// 一致性让位于本平台肌肉记忆。
//
// 选键避让的依据见 browser-reserved.js:浏览器保留的和弦根本不会下发到扩展
// 页面,或者会双重触发。command-table.test.js 断言没有任何命令落在保留表上 ——
// 否则下次有人加 ⌘N 会静默失效。
import {
  MOD, chord, BROWSER_RESERVED_MAC, BROWSER_RESERVED_WIN
} from "./browser-reserved.js";

// 词汇表在 browser-reserved.js 里定义,这里转出,让调用方只认一个入口。
export { MOD, chord, BROWSER_RESERVED_MAC, BROWSER_RESERVED_WIN };

/// 参考表的分区。顺序即渲染顺序。
export const SECTIONS = ["session", "composer", "agent", "goal", "view", "page"];

/// 命令表。chord 为 null 表示该平台故意不给和弦(只能点按钮到达)。
///
/// mac 侧把 ⌃⌘ 当结构化/低频档、⌥⌘ 当"就地切换"档,和 Mac 端语言一致。
/// win 侧高频项仍走单 Alt+字母(好按,且 Chrome 只独占了 Alt+D/F/E/Home),
/// 但两类别碰:Alt+F/Alt+E 是 Chrome 主菜单、Alt+Shift 是 Windows 输入法
/// 切换(装了中英双输入法几乎必绑)。所以次高频改用 Ctrl+Shift,方向键/符号
/// 档用 Ctrl+Alt(AltGr 对方向键与标点不产字符,不会变字符输入)。
export const COMMANDS = [
  // ---- 会话 ----
  {
    id: "toggleHistory", section: "session", titleKey: "sc.toggleHistory",
    mac: chord("k", MOD.primary), win: chord("k", MOD.primary), existing: true,
    // 既有债,不是新增:Windows 上 Ctrl+K 是 Chrome 地址栏搜索。侧栏聚焦时事件
    // 确实到得了 DOM,所以现状能用,但它不是安全先例 —— 新命令不得再往保留表里放。
    // 保留原键位是因为它已形成肌肉记忆,改键的代价高于这处冲突。
    reservedException: "win"
  },
  {
    id: "newSession", section: "session", titleKey: "sc.newSession",
    mac: chord("k", MOD.primary | MOD.shift), win: chord("k", MOD.primary | MOD.shift), existing: true
  },
  {
    id: "historyItem", section: "session", titleKey: "sc.historyItem",
    mac: null, win: null, existing: true, literalKey: "sc.chord.historyItem"
  },
  {
    id: "previousSession", section: "session", titleKey: "sc.previousSession",
    mac: chord("arrowleft", MOD.primary | MOD.control), win: chord("arrowleft", MOD.primary | MOD.alt)
  },
  {
    id: "nextSession", section: "session", titleKey: "sc.nextSession",
    mac: chord("arrowright", MOD.primary | MOD.control), win: chord("arrowright", MOD.primary | MOD.alt)
  },
  {
    id: "renameSession", section: "session", titleKey: "sc.renameSession",
    mac: chord("r", MOD.primary | MOD.control), win: chord("r", MOD.alt)
  },
  {
    id: "forkSession", section: "session", titleKey: "sc.forkSession",
    mac: chord("b", MOD.primary | MOD.control), win: chord("b", MOD.alt)
  },
  {
    id: "archiveSession", section: "session", titleKey: "sc.archiveSession",
    mac: chord("a", MOD.primary | MOD.alt), win: chord("a", MOD.alt)
  },
  {
    id: "findInSession", section: "session", titleKey: "sc.findInSession",
    mac: chord("f", MOD.primary | MOD.shift), win: chord("f", MOD.primary | MOD.shift)
  },
  {
    id: "copyLastResponse", section: "session", titleKey: "sc.copyLastResponse",
    mac: chord("c", MOD.primary | MOD.control), win: chord("c", MOD.alt)
  },

  // ---- 输入区 ----
  {
    id: "sendMessage", section: "composer", titleKey: "sc.sendMessage",
    mac: chord("enter", MOD.none), win: chord("enter", MOD.none), existing: true
  },
  {
    id: "steerDraft", section: "composer", titleKey: "sc.steerDraft",
    mac: chord("enter", MOD.primary | MOD.alt), win: chord("enter", MOD.primary | MOD.alt), existing: true
  },
  {
    // mac 与 AppCommand.swift 的 `case .stopGenerating: CommandChord(.escape, .command)`
    // 逐字对齐:⌘Esc。带上主修饰键而不是裸 Esc,和 mac 端同一个理由 —— 裸 Esc
    // 是"就地取消"的公共资源(sheet/浮层/卡片都在用),带上 ⌘ 才能成为一个
    // 不被任何人抢走的独立命令。
    // win 侧不跟着换成 Ctrl+Esc:Ctrl+Esc 是 Windows 开始菜单(系统级,页面
    // 收不到,见 browser-reserved.js),换了等于把这个命令变成不可达。mac 端
    // 是这条命令唯一的参照实现,Windows 没有对应端,所以维持原键位不变。
    id: "stopGenerating", section: "composer", titleKey: "sc.stopGenerating",
    mac: chord("escape", MOD.primary), win: chord("escape", MOD.none)
  },
  {
    id: "focusComposer", section: "composer", titleKey: "sc.focusComposer",
    mac: chord("l", MOD.primary | MOD.control), win: chord("l", MOD.primary | MOD.shift)
  },
  {
    id: "clearDraft", section: "composer", titleKey: "sc.clearDraft",
    mac: chord("backspace", MOD.primary | MOD.alt), win: chord("backspace", MOD.primary | MOD.shift)
  },
  {
    id: "removeLastAttachment", section: "composer", titleKey: "sc.removeLastAttachment",
    mac: chord("backspace", MOD.primary | MOD.alt | MOD.shift),
    win: chord("backspace", MOD.primary | MOD.alt | MOD.shift)
  },

  // ---- 智能体 ----
  {
    id: "choosePermission", section: "agent", titleKey: "sc.choosePermission",
    mac: chord("p", MOD.primary | MOD.shift), win: chord("p", MOD.alt)
  },
  {
    id: "permissionReadOnly", section: "agent", titleKey: "sc.permissionReadOnly",
    mac: chord("1", MOD.primary | MOD.control), win: chord("1", MOD.alt)
  },
  {
    id: "permissionWorkspaceWrite", section: "agent", titleKey: "sc.permissionWorkspaceWrite",
    mac: chord("2", MOD.primary | MOD.control), win: chord("2", MOD.alt)
  },
  {
    id: "permissionFullAccess", section: "agent", titleKey: "sc.permissionFullAccess",
    mac: chord("3", MOD.primary | MOD.control), win: chord("3", MOD.alt)
  },
  {
    id: "chooseModel", section: "agent", titleKey: "sc.chooseModel",
    mac: chord("m", MOD.primary | MOD.alt), win: chord("m", MOD.alt)
  },
  {
    id: "previousModel", section: "agent", titleKey: "sc.previousModel",
    mac: chord("arrowup", MOD.primary | MOD.control), win: chord("arrowup", MOD.alt)
  },
  {
    id: "nextModel", section: "agent", titleKey: "sc.nextModel",
    mac: chord("arrowdown", MOD.primary | MOD.control), win: chord("arrowdown", MOD.alt)
  },
  {
    id: "increaseEffort", section: "agent", titleKey: "sc.increaseEffort",
    mac: chord("arrowup", MOD.primary | MOD.alt | MOD.shift), win: chord("arrowup", MOD.primary | MOD.alt)
  },
  {
    id: "decreaseEffort", section: "agent", titleKey: "sc.decreaseEffort",
    mac: chord("arrowdown", MOD.primary | MOD.alt | MOD.shift), win: chord("arrowdown", MOD.primary | MOD.alt)
  },
  {
    id: "chooseAgentPreset", section: "agent", titleKey: "sc.chooseAgentPreset",
    mac: chord("j", MOD.primary | MOD.control), win: chord("g", MOD.alt)
  },
  {
    id: "exitPlanMode", section: "agent", titleKey: "sc.exitPlanMode",
    mac: chord("p", MOD.primary | MOD.control), win: chord("p", MOD.primary | MOD.shift)
  },
  {
    id: "showSubagents", section: "agent", titleKey: "sc.showSubagents",
    mac: chord("u", MOD.primary | MOD.control), win: chord("u", MOD.alt)
  },
  {
    id: "contextUsage", section: "agent", titleKey: "sc.contextUsage",
    mac: chord("s", MOD.primary | MOD.alt), win: chord("s", MOD.alt)
  },
  {
    id: "compactContext", section: "agent", titleKey: "sc.compactContext",
    mac: chord("k", MOD.primary | MOD.control), win: chord("k", MOD.alt)
  },

  // ---- 目标 ----
  {
    id: "newGoal", section: "goal", titleKey: "sc.newGoal",
    mac: chord("g", MOD.primary | MOD.control), win: chord("n", MOD.alt)
  },
  {
    id: "editGoal", section: "goal", titleKey: "sc.editGoal",
    mac: chord("e", MOD.primary | MOD.control), win: chord("e", MOD.primary | MOD.shift)
  },
  {
    id: "toggleGoalPause", section: "goal", titleKey: "sc.toggleGoalPause",
    mac: chord("g", MOD.primary | MOD.alt), win: chord("g", MOD.primary | MOD.alt)
  },
  {
    id: "clearGoal", section: "goal", titleKey: "sc.clearGoal",
    mac: chord("backspace", MOD.primary | MOD.control), win: chord("backspace", MOD.primary | MOD.alt)
  },

  // ---- 视图 ----
  {
    id: "toggleTodoPanel", section: "view", titleKey: "sc.toggleTodoPanel",
    mac: chord("t", MOD.primary | MOD.alt), win: chord("t", MOD.alt)
  },
  {
    id: "openSettings", section: "view", titleKey: "sc.openSettings",
    mac: chord(",", MOD.primary | MOD.control), win: chord(",", MOD.primary | MOD.shift)
  },
  {
    id: "keyboardShortcuts", section: "view", titleKey: "sc.keyboardShortcuts",
    mac: chord("/", MOD.primary), win: chord("/", MOD.alt)
  },

  // ---- 页面 ----
  {
    id: "toggleElementPicker", section: "page", titleKey: "sc.toggleElementPicker",
    mac: chord(".", MOD.primary), win: chord(".", MOD.primary), existing: true
  },
  {
    id: "togglePageContext", section: "page", titleKey: "sc.togglePageContext",
    mac: chord(".", MOD.primary | MOD.alt), win: chord(".", MOD.primary | MOD.shift)
  }
];

/// 当前平台标识。Linux 与 Windows 共用一套键位(Alt 档),但 Alt+字母 在部分
/// 桌面环境是 GTK 菜单加速键,所以 Linux 单独成一档便于日后分化。
export function platformOf(platform = "") {
  if (/mac/i.test(platform)) return "mac";
  if (/linux/i.test(platform)) return "linux";
  return "win";
}

/// 取某平台的和弦。linux 目前跟随 win。
export function chordFor(command, platformKind) {
  if (!command) return null;
  return platformKind === "mac" ? command.mac : command.win;
}

const KEY_GLYPHS_MAC = {
  enter: "↩", escape: "Esc", backspace: "⌫", arrowup: "↑", arrowdown: "↓",
  arrowleft: "←", arrowright: "→", " ": "space", tab: "⇥"
};
const KEY_NAMES_WIN = {
  enter: "Enter", escape: "Esc", backspace: "Backspace", arrowup: "↑", arrowdown: "↓",
  arrowleft: "←", arrowright: "→", " ": "Space", tab: "Tab"
};

/// 人读的和弦文案。mac 用字形(⌃⌥⇧⌘,Apple 的固定顺序),win 用 `+` 连接。
export function chordLabel(chordValue, platformKind) {
  if (!chordValue) return "";
  const { key, mods } = chordValue;
  if (platformKind === "mac") {
    let out = "";
    if (mods & MOD.control) out += "⌃";
    if (mods & MOD.alt) out += "⌥";
    if (mods & MOD.shift) out += "⇧";
    if (mods & MOD.primary) out += "⌘";
    return out + (KEY_GLYPHS_MAC[key] ?? key.toUpperCase());
  }
  const parts = [];
  if (mods & MOD.primary) parts.push("Ctrl");
  if (mods & MOD.alt) parts.push("Alt");
  if (mods & MOD.shift) parts.push("Shift");
  parts.push(KEY_NAMES_WIN[key] ?? key.toUpperCase());
  return parts.join("+");
}

/// 和弦拆成有序的按键 token,供参考表逐键画键帽。
/// 视图不该去解析 chordLabel 的成品字符串:mac 的 "⌃⌘L" 没有分隔符,按 "+" 拆
/// 会把整条挤进一个键帽(实测就是这么糊的),而按字符拆又会切坏 "Esc"/"Ctrl"。
export function chordKeys(chordValue, platformKind) {
  if (!chordValue) return [];
  const { key, mods } = chordValue;
  const parts = [];
  if (platformKind === "mac") {
    if (mods & MOD.control) parts.push("⌃");
    if (mods & MOD.alt) parts.push("⌥");
    if (mods & MOD.shift) parts.push("⇧");
    if (mods & MOD.primary) parts.push("⌘");
    parts.push(KEY_GLYPHS_MAC[key] ?? key.toUpperCase());
    return parts;
  }
  if (mods & MOD.primary) parts.push("Ctrl");
  if (mods & MOD.alt) parts.push("Alt");
  if (mods & MOD.shift) parts.push("Shift");
  parts.push(KEY_NAMES_WIN[key] ?? key.toUpperCase());
  return parts;
}

/// 从事件里读出平台无关的修饰键掩码。
export function modsOf(event, platformKind) {
  let mods = MOD.none;
  if (platformKind === "mac") {
    if (event.metaKey) mods |= MOD.primary;
    if (event.ctrlKey) mods |= MOD.control;
  } else if (event.ctrlKey) {
    mods |= MOD.primary;
  }
  if (event.altKey) mods |= MOD.alt;
  if (event.shiftKey) mods |= MOD.shift;
  return mods;
}

/// 事件是否命中该和弦。修饰键必须完全相等 —— 子集匹配会让 ⌥⌘↩ 被 ⌘↩ 抢走。
export function matchesChord(event, chordValue, platformKind) {
  if (!event || !chordValue) return false;
  if (event.isComposing) return false; // 输入法组字中不抢键
  const key = String(event.key ?? "").toLowerCase();
  if (key !== chordValue.key) return false;
  return modsOf(event, platformKind) === chordValue.mods;
}

/// 找出事件命中的命令 id。用于统一分派。
export function commandForEvent(event, platformKind) {
  for (const command of COMMANDS) {
    const value = chordFor(command, platformKind);
    if (value && matchesChord(event, value, platformKind)) return command.id;
  }
  return null;
}

/// 参考表用的分组视图:[{ section, items: [{ id, titleKey, label }] }]。
export function shortcutReference(platformKind) {
  return SECTIONS.map((sectionId) => ({
    section: sectionId,
    items: COMMANDS.filter((command) => command.section === sectionId).map((command) => ({
      id: command.id,
      titleKey: command.titleKey,
      literalKey: command.literalKey ?? null,
      label: chordLabel(chordFor(command, platformKind), platformKind),
      keys: chordKeys(chordFor(command, platformKind), platformKind)
    }))
  })).filter((group) => group.items.length > 0);
}