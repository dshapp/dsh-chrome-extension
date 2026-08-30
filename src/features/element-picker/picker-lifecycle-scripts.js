// 选取模式的取数与收尾注入体。与 picker-overlay-script.js 一样是自包含注入体:
// 不得引用模块作用域变量、不得 eval。

/**
 * 注入体:取走并清空页面上累积的选取结果。
 * side panel 轮询调用,确保即使 runtime 消息没送达也不丢选取。
 */
export function elementPickerDrainScript() {
  const queue = window.__cmPickerQueue || [];
  window.__cmPickerQueue = [];
  return { elements: queue };
}

/** 注入体:停止页面上的选取模式(供关闭时 executeScript 调用)。 */
export function elementPickerStopScript() {
  if (window.__cmElementPicker && typeof window.__cmElementPicker.stop === "function") {
    window.__cmElementPicker.stop();
    return { stopped: true };
  }
  return { stopped: false };
}