// 元素选取模式的快捷键判定。保持纯函数:不碰 DOM、不读全局状态,便于单测。
// 独立于 session-shortcuts.js 的「修饰键 + K/数字」和弦状态机——"." 与那套语义无关,
// 合并会污染该状态机的 hints/chord 状态。

import { COMMANDS, chordFor, chordLabel } from "../shortcuts/command-table.js";

const TOGGLE_KEY = ".";

/**
 * ⌘.(mac)/ Ctrl+.(其他平台)= toggle 元素选取模式。
 * @param {KeyboardEvent | { key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, repeat?: boolean, isComposing?: boolean }} event
 * @param {{ mac?: boolean }} [options]
 */
export function isElementPickerToggleChord(event, { mac = false } = {}) {
  if (!event) return false;
  if (event.isComposing) return false; // 输入法组字中不抢键
  if (event.repeat) return false; // 长按不重复 toggle
  if (event.key !== TOGGLE_KEY) return false;
  if (event.altKey || event.shiftKey) return false;
  // 平台主修饰键必须按下,另一个不能按下(避免 Ctrl+⌘ 组合误判)。
  return mac ? Boolean(event.metaKey) && !event.ctrlKey : Boolean(event.ctrlKey) && !event.metaKey;
}

/** 入口按钮 title 用的快捷键文案。取自命令表,不在这里手写字形。 */
export function elementPickerShortcutLabel(mac = false) {
  const kind = mac ? "mac" : "win";
  const command = COMMANDS.find((entry) => entry.id === "toggleElementPicker");
  return chordLabel(chordFor(command, kind), kind);
}
