// 全局快捷键分派。命令表(command-table.js)是唯一真源,这里只做
// "事件 → 命令 id → 处理器"这一段,不重复声明任何键位。
//
// 已由各自模块就地处理的命令不在这里注册:它们要么在 capture 阶段
// stopPropagation,要么已经 preventDefault,本分派器会直接跳过 ——
// toggleHistory / newSession / historyItem(session-shortcuts)、
// sendMessage / steerDraft(composer 输入框)、
// toggleElementPicker(element-picker)、findInChat(⌘F 查找条)。
import { commandForEvent, platformOf } from "../../features/shortcuts/command-table.js";

/// 允许长按连发(逐步推进)的命令;其余命令长按只算一次,避免开关类命令抖动。
const REPEATABLE = new Set([
  "previousSession", "nextSession", "previousModel", "nextModel",
  "increaseEffort", "decreaseEffort"
]);

/// @param {object} options
/// @param {string} options.platform navigator.platform 串
/// @param {Record<string, (event: KeyboardEvent) => boolean|void>} options.handlers
///        命令 id → 处理器。返回 false 表示"这次不可用,别消费这个键"。
/// @param {() => boolean} [options.isSettingsOpen] 设置页(全屏覆盖)是否开着
export function createShortcutDispatcher({ platform = "", handlers = {}, isSettingsOpen = () => false } = {}) {
  const kind = platformOf(platform);
  return {
    /// 返回 true 表示这次按键已被消费(调用方可据此 stopPropagation)。
    handleKeyDown(event) {
      // 组字确认的 Enter 不是命令;已被别处处理的键也不再抢。
      if (event.defaultPrevented || event.isComposing) return false;
      const id = commandForEvent(event, kind);
      if (!id) return false;
      const handler = handlers[id];
      if (!handler) return false;
      if (event.repeat && !REPEATABLE.has(id)) return false;
      // 设置页是全屏覆盖,除"打开设置/快捷键参考"外不抢它的键。
      if (isSettingsOpen() && id !== "openSettings" && id !== "keyboardShortcuts") return false;
      let handled = false;
      try { handled = handler(event) !== false; } catch { handled = false; }
      if (!handled) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
  };
}
