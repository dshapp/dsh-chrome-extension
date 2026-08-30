/**
 * 元素选取模式的存活哨兵(Service Worker 侧)。
 *
 * 侧栏被关闭时 document 立即销毁,自身来不及跑异步的 chrome.scripting.executeScript
 * 收尾 —— pagehide 里发出的异步调用不保证送达。结果是注入脚本继续留在页面上:
 * 十字光标不消失、蒙层还在、页面点击继续被吞掉,用户只能刷新页面才能恢复。
 *
 * 因此侧栏在开启选取时连一条长连接,把"选取落在哪个标签页"同步过来;
 * 侧栏一关,port 断开,由这里替它把页面覆盖层拆掉。
 */

import { elementPickerStopScript } from "../src/features/element-picker/picker-lifecycle-scripts.js";

export const PICKER_PRESENCE_PORT = "element-picker-presence";

/** 拆掉某个标签页上的选取覆盖层。页面可能已关闭/换页,失败只记日志。 */
export async function stopPickerOnTab(tabId) {
  if (!Number.isInteger(tabId)) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: elementPickerStopScript });
    return true;
  } catch (error) {
    console.warn("[picker-presence] stop failed", error?.message ?? error);
    return false;
  }
}

/**
 * 绑定一条 presence 连接。导出以便测试直接驱动,不必伪造整个 chrome.runtime。
 * @param {chrome.runtime.Port} port
 */
export function bindPickerPresence(port) {
  let tabId = null;
  port.onMessage.addListener((message) => {
    if (message?.type === "ELEMENT_PICKER_ACTIVE") {
      tabId = Number.isInteger(message.tabId) ? message.tabId : null;
    } else if (message?.type === "ELEMENT_PICKER_INACTIVE") {
      tabId = null;
    }
  });
  port.onDisconnect.addListener(() => {
    // 只有仍处于开启态(tabId 非空)才需要收尾;
    // 正常关闭选取时侧栏已经发过 INACTIVE,这里就什么都不做。
    if (!Number.isInteger(tabId)) return;
    void stopPickerOnTab(tabId);
    tabId = null;
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PICKER_PRESENCE_PORT) return;
  bindPickerPresence(port);
});
