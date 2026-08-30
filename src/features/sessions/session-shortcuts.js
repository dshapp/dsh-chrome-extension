// 侧边栏 Session 快捷键的纯状态机。只处理按键判定，具体 UI/会话操作由调用方注入。
// 对齐 extension/src/features/sessions/session-shortcuts.js。

export function isMacPlatform(platform = "") {
  return /mac/i.test(platform);
}
export function getSessionShortcutLabels(platform = "") {
  const primary = isMacPlatform(platform) ? "⌘" : "Ctrl";
  return {
    history: `${primary}K`,
    newSession: `${primary}⇧K`,
    historyItem: position => `${primary}K${position}`
  };
}
export function createSessionShortcutController({
  platform = "",
  onHintsChange = () => {},
  onToggleHistory = () => {},
  onNewSession = () => {},
  onSelectHistory = () => {}
} = {}) {
  const mac = isMacPlatform(platform);
  let hintsVisible = false;
  let historyChordActive = false;
  const isPrimaryKey = event => event.key === (mac ? "Meta" : "Control");
  const hasPrimaryModifier = event => mac ? event.metaKey : event.ctrlKey;
  function setHintsVisible(visible) {
    if (hintsVisible === visible) return;
    hintsVisible = visible;
    onHintsChange(visible);
  }
  function consume(event) {
    event.preventDefault?.();
    event.stopPropagation?.();
  }
  function handleKeyDown(event) {
    if (event.isComposing) return false;
    if (isPrimaryKey(event)) {
      setHintsVisible(true);
      return false;
    }
    if (!hasPrimaryModifier(event)) return false;
    setHintsVisible(true);
    const key = String(event.key || "").toLowerCase();
    if (key === "k") {
      consume(event);
      if (event.repeat) return true;
      if (event.shiftKey) {
        historyChordActive = false;
        onNewSession();
      } else {
        historyChordActive = true;
        onToggleHistory();
      }
      return true;
    }
    if (historyChordActive && /^[1-9]$/.test(key)) {
      consume(event);
      if (!event.repeat) onSelectHistory(Number(key) - 1);
      return true;
    }
    return false;
  }
  function handleKeyUp(event) {
    const key = String(event.key || "").toLowerCase();
    if (key === "k") historyChordActive = false;
    if (isPrimaryKey(event)) reset();
  }
  function reset() {
    historyChordActive = false;
    setHintsVisible(false);
  }
  return {
    handleKeyDown,
    handleKeyUp,
    reset
  };
}
