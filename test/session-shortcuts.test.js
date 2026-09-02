import { describe, it, expect, vi } from "vitest";
import { getSessionShortcutLabels, createSessionShortcutController } from "../src/features/sessions/session-shortcuts.js";

function keyEvent(key, { meta = false, ctrl = false, shift = false, repeat = false } = {}) {
  return {
    key,
    metaKey: meta,
    ctrlKey: ctrl,
    shiftKey: shift,
    repeat,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  };
}

describe("session-shortcuts", () => {
  // 文案改由 command-table 派生,顺带修好了三处手写产生的错字形:
  // 新建会话曾拼作「⌘⇧K」(Apple 的修饰键顺序是 ⇧⌘),Windows 曾拼作「CtrlK」
  // (缺 + 号),历史第 N 项曾拼作「⌘K3」(读起来像一个和弦,实为先后两下)。
  it("mac 用 ⌘,其他平台用 Ctrl,且修饰键顺序符合各平台规范", () => {
    expect(getSessionShortcutLabels("MacIntel")).toEqual({
      history: "⌘K",
      newSession: "⇧⌘K",
      historyItem: expect.any(Function)
    });
    expect(getSessionShortcutLabels("Win32").history).toBe("Ctrl+K");
    expect(getSessionShortcutLabels("Win32").newSession).toBe("Ctrl+Shift+K");
    expect(getSessionShortcutLabels("MacIntel").historyItem(3)).toBe("⌘K 3");
  });

  it("⌘K 打开历史,⌘⇧K 新建会话,松开修饰键后隐藏提示", () => {
    const onHintsChange = vi.fn();
    const onToggleHistory = vi.fn();
    const onNewSession = vi.fn();
    const controller = createSessionShortcutController({
      platform: "MacIntel",
      onHintsChange,
      onToggleHistory,
      onNewSession
    });

    controller.handleKeyDown(keyEvent("Meta"));
    expect(onHintsChange).toHaveBeenCalledWith(true);

    controller.handleKeyDown(keyEvent("k", { meta: true }));
    expect(onToggleHistory).toHaveBeenCalledTimes(1);
    expect(onNewSession).not.toHaveBeenCalled();

    controller.handleKeyDown(keyEvent("k", { meta: true, shift: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);

    controller.handleKeyUp(keyEvent("Meta"));
    expect(onHintsChange).toHaveBeenCalledWith(false);
  });

  it("⌘K 后按数字键按序号跳转历史项,松开 K 后数字键失效", () => {
    const onToggleHistory = vi.fn();
    const onSelectHistory = vi.fn();
    const controller = createSessionShortcutController({
      platform: "MacIntel",
      onToggleHistory,
      onSelectHistory
    });

    controller.handleKeyDown(keyEvent("k", { meta: true }));
    controller.handleKeyDown(keyEvent("3", { meta: true }));
    expect(onSelectHistory).toHaveBeenCalledWith(2);

    controller.handleKeyUp(keyEvent("k"));
    controller.handleKeyDown(keyEvent("4", { meta: true }));
    expect(onSelectHistory).toHaveBeenCalledTimes(1);
  });

  it("非组合键或未按修饰键时不拦截事件", () => {
    const controller = createSessionShortcutController({ platform: "MacIntel" });
    const plainKey = keyEvent("k");
    expect(controller.handleKeyDown(plainKey)).toBe(false);
    expect(plainKey.preventDefault).not.toHaveBeenCalled();
  });
});
