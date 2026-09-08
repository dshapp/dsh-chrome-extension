// 选取模式的取数与收尾注入体。与 picker-overlay-script.js 一样是自包含注入体:
// 不得引用模块作用域变量、不得 eval。

/**
 * 注入体:取走并清空页面上累积的选取结果。
 * side panel 轮询调用,确保即使 runtime 消息没送达也不丢选取。
 *
 * 同时取走批注弹窗置下的两个一次性标志位:
 *   submit —— 用户点了「提交」,侧栏应把整轮元素发出去并退出圈选模式
 *   cancel —— 用户点了右上角关闭,侧栏只退出圈选模式(已收下的元素保留)
 * 走同一条队列而不是新开 port:页面里的按钮要让侧栏动起来,而注入体发出的
 * runtime 消息未必送达,drain 是这条链路上唯一可靠的真相来源。
 */
export function elementPickerDrainScript() {
  const queue = window.__cmPickerQueue || [];
  window.__cmPickerQueue = [];
  const submit = Boolean(window.__cmPickerSubmit);
  const cancel = Boolean(window.__cmPickerCancel);
  window.__cmPickerSubmit = false;
  window.__cmPickerCancel = false;
  return { elements: queue, submit, cancel };
}

/** 注入体:停止页面上的选取模式(供关闭时 executeScript 调用)。 */
export function elementPickerStopScript() {
  if (window.__cmElementPicker && typeof window.__cmElementPicker.stop === "function") {
    window.__cmElementPicker.stop();
    return { stopped: true };
  }
  return { stopped: false };
}