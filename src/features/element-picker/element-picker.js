// 页面元素选取:在用户当前浏览的页面上圈选元素,发送消息时把定位信息
// 以语义化 XML 拼在最前面,让模型准确知道"用户指的是哪个元素"。
//
// 移植自原 extension 的 element-picker,适配 DSH 侧栏的依赖注入风格
// (无全局 state/actions 容器,改为工厂 + 显式依赖)。
//
// 四个注入体(summary/overlay/lifecycle/highlight)保持自包含:它们经
// chrome.scripting.executeScript 序列化后在页面 JS 引擎里执行,不能引用模块作用域。
import { elementPickerSummaryScript } from "./picker-element-summary.js";
import { elementPickerPageScript } from "./picker-overlay-script.js";
import { elementPickerDrainScript, elementPickerStopScript } from "./picker-lifecycle-scripts.js";
import { elementPickerHighlightScript } from "./picker-highlight-script.js";
import { formatPickedElementsContext } from "./element-picker-context.js";

/// 与 sw/picker-presence.js 约定的连接名。
export const PICKER_PRESENCE_PORT = "element-picker-presence";

/// 单条消息最多携带的元素数。再多模型也读不过来,且 token 成本陡增。
export const MAX_PICKED = 20;

/// 浏览器内部页注入不进去,选取模式在这些页面上无意义。
const INTERNAL_PAGE = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

export function isInternalPage(url) {
  return INTERNAL_PAGE.test(String(url || ""));
}

/// 判定两个元素是否是同一个(ref 或 selector 命中即算重复)。
export function isSameElement(a, b) {
  if (!a || !b) return false;
  if (a.ref && b.ref && a.ref === b.ref) return true;
  if (a.selector && b.selector && a.selector === b.selector) return true;
  return false;
}

/**
 * @param {object} options
 * @param {typeof chrome} [options.chromeApi] 便于测试注入假实现
 * @param {(msg: string) => void} options.showToast
 * @param {(key: string, params?: object) => string} options.t
 * @param {() => void} [options.onChange] 选取集合变化时通知调用方(刷新按钮/发送态)
 */
export function createElementPicker({ chromeApi, showToast, t, onChange = () => {} } = {}) {
  const api = chromeApi ?? (typeof chrome !== "undefined" ? chrome : null);
  let picked = [];
  let active = false;
  let tabId = null;
  // 关闭选取后 hover 高亮仍要能用,所以单独记住最后作用过的页。
  let highlightTabId = null;
  let drainTimer = null;
  // 与 Service Worker 的长连接:侧栏一关它就断,SW 据此拆掉页面覆盖层。
  let presencePort = null;

  const log = (tag, error) => console.warn(`[element-picker] ${tag}`, error?.message ?? error);

  function notify() { onChange(); }

  // ---- 存活哨兵 ----
  //
  // 侧栏被关闭时 document 立即销毁,自身来不及跑异步的 executeScript 收尾
  // (pagehide 里发出的异步调用不保证送达)。结果是注入脚本继续留在页面上:
  // 十字光标不消失、蒙层还在、页面点击继续被吞掉,用户只能刷新页面才能恢复。
  // 所以把"选取落在哪个标签页"同步给 SW,由它在 port 断开时替我们收尾。

  function connectPresence() {
    if (!api?.runtime?.connect) return;
    try {
      presencePort = api.runtime.connect({ name: PICKER_PRESENCE_PORT });
      presencePort.onDisconnect?.addListener?.(() => { presencePort = null; });
      syncPresence();
    } catch {
      presencePort = null;   // SW 未就绪:下次 sync 时再试
    }
  }

  function syncPresence() {
    if (!presencePort) {
      // 开启选取时若还没连上,补连一次,别让哨兵缺席。
      if (active && api?.runtime?.connect) connectPresence();
      return;
    }
    try {
      presencePort.postMessage(active
        ? { type: "ELEMENT_PICKER_ACTIVE", tabId }
        : { type: "ELEMENT_PICKER_INACTIVE" });
    } catch {
      // port 已断开:SW 那侧会在 onDisconnect 里兜底清理。
      presencePort = null;
    }
  }

  // ---- 目标标签页 ----

  /// 选取始终作用于**用户当前正在看的**标签页。
  /// 不能用会话绑定的工作页:侧栏开着、用户又切到别的标签页时会注入错页,
  /// 表现就是"怎么点都选不中"。
  async function targetTab() {
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || isInternalPage(tab.url)) {
      const error = new Error(t("picker.needsPage"));
      error.i18nKey = "picker.needsPage";
      throw error;
    }
    return tab;
  }

  // ---- 注入 / 收尾 ----

  async function inject(id) {
    // 顺序有意义:overlay 的点击处理依赖页面上已存在的摘要构建器。
    await api.scripting.executeScript({
      target: { tabId: id }, args: [{ maxTextLength: 120 }], func: elementPickerSummaryScript
    });
    await api.scripting.executeScript({
      target: { tabId: id }, args: [{ maxTextLength: 120 }], func: elementPickerPageScript
    });
  }

  async function stopOnTab(id) {
    if (!Number.isInteger(id)) return;
    try {
      await api.scripting.executeScript({ target: { tabId: id }, func: elementPickerStopScript });
    } catch (error) { log("STOP_ERR", error); }
  }

  /// 主动取走页面累积的选取结果。
  /// executeScript 注入体不是声明式 content script,它发出的 runtime 消息未必能到达
  /// 侧栏,所以以 drain 为准、消息只作快通道。
  async function drain() {
    if (!Number.isInteger(tabId)) return;
    let elements = [];
    try {
      const [{ result } = {}] = await api.scripting.executeScript({
        target: { tabId }, func: elementPickerDrainScript
      });
      elements = result?.elements ?? [];
    } catch (error) { log("DRAIN_ERR", error); return; }
    for (const element of elements) add(element);
  }

  function startDrain() {
    if (drainTimer) return;
    drainTimer = setInterval(() => void drain(), 400);
  }
  function stopDrain() {
    if (!drainTimer) return;
    clearInterval(drainTimer);
    drainTimer = null;
  }

  // ---- 开关 ----

  async function setActive(next) {
    if (active === Boolean(next)) return active;
    if (next) {
      let tab;
      try { tab = await targetTab(); }
      catch (error) { showToast(error.message); return active; }
      try { await inject(tab.id); }
      catch (error) { log("INJECT_ERR", error); showToast(t("picker.needsPage")); return active; }
      tabId = tab.id;
      highlightTabId = tab.id;
      active = true;
      startDrain();
      syncPresence();
    } else {
      const previous = tabId;
      stopDrain();
      // 关闭前收尾一次,避免最后一次点击还在队列里就被丢掉。
      await drain();
      active = false;
      tabId = null;
      // 先告诉 SW 已经关了,免得它在 port 断开时对一个已收尾的页面重复注入。
      syncPresence();
      await highlight(null);
      await stopOnTab(previous);
    }
    notify();
    return active;
  }

  /// 选取模式跟随用户切换后的标签页:先收尾旧页,再注入新页。
  async function followTab(nextTabId) {
    const previous = tabId;
    await drain();
    let tab;
    try { tab = await api.tabs.get(nextTabId); } catch { return; }
    // 浏览器内部页注不进去:保持在旧页,不静默失活。
    if (isInternalPage(tab.url)) return;
    try { await inject(nextTabId); }
    catch (error) { log("FOLLOW_ERR", error); return; }
    tabId = nextTabId;
    highlightTabId = nextTabId;
    // 跟页之后哨兵要指向新页,否则侧栏关闭时 SW 会去清理一个早已收尾的旧页。
    syncPresence();
    if (Number.isInteger(previous) && previous !== nextTabId) await stopOnTab(previous);
  }

  // ---- 选取集合 ----

  function add(element) {
    if (!element) return;
    if (picked.some((item) => isSameElement(item, element))) return;
    if (picked.length >= MAX_PICKED) {
      showToast(t("picker.limitReached", { n: String(MAX_PICKED) }));
      return;
    }
    picked = [...picked, element];
    notify();
  }

  function remove(index) {
    if (index < 0 || index >= picked.length) return;
    picked = picked.filter((_, i) => i !== index);
    notify();
  }

  function clear() {
    if (!picked.length) return;
    picked = [];
    notify();
  }

  /// 侧栏列表 hover 联动页面高亮。目标页可能已关闭或换页,失败只记日志——
  /// 这是纯辅助反馈,不该打断用户操作,也不弹 toast 干扰。
  async function highlight(element) {
    const id = Number.isInteger(tabId) ? tabId : highlightTabId;
    if (!Number.isInteger(id)) return;
    try {
      await api.scripting.executeScript({
        target: { tabId: id },
        args: [element ? { ref: element.ref, selector: element.selector } : null],
        func: elementPickerHighlightScript
      });
    } catch (error) { log("HIGHLIGHT_ERR", error); }
  }

  // ---- 生命周期接线 ----

  function attach() {
    if (!api?.runtime?.onMessage) return () => {};
    const onMessage = (msg) => {
      if (msg?.type === "ELEMENT_PICKED" && msg.element) add(msg.element);
    };
    api.runtime.onMessage.addListener(onMessage);

    // 页面刷新/导航后注入脚本随页面销毁,模式仍开启则重新注入。
    const onUpdated = (id, changeInfo) => {
      if (!active || id !== tabId || changeInfo.status !== "complete") return;
      inject(id).catch((error) => log("REINJECT_ERR", error));
    };
    api.tabs?.onUpdated?.addListener(onUpdated);

    // 选取模式开启期间用户切到别的标签页:把选取跟到新页面,
    // 否则脚本还留在旧页上,用户在新页面怎么点都没反应。
    const onActivated = ({ tabId: id }) => {
      if (!active || id === tabId) return;
      void followTab(id);
    };
    api.tabs?.onActivated?.addListener(onActivated);

    // 目标页被关掉:必须就地收尾。留着 active + 一个已死的 tabId,drain 会每 400ms
    // 空转一次;更要紧的是 Chrome 会复用 tabId —— 等这个 id 被新标签页复用,
    // drain 与 SW 的 stopPickerOnTab 就打到一个用户毫不相干的页面上去了。
    // presence 哨兵只覆盖侧栏关闭,覆盖不了标签页关闭。
    const onRemoved = (id) => {
      if (id !== tabId && id !== highlightTabId) return;
      if (id === tabId) {
        stopDrain();
        active = false;
        tabId = null;
        syncPresence();
        notify();
      }
      if (id === highlightTabId) highlightTabId = null;
    };
    api.tabs?.onRemoved?.addListener(onRemoved);

    // 主路径:侧栏关闭 → port 断开 → SW 拆掉页面覆盖层。
    connectPresence();

    // 尽力而为的本地收尾:先停轮询,再同步取一次剩余选取,
    // 免得最后一次点击还在页面队列里就随侧栏一起没了。
    // 真正的页面清理由 SW 负责 —— pagehide 里发不出异步的 executeScript。
    const onPageHide = () => {
      if (!active) return;
      stopDrain();
      void drain();
    };
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

    return () => {
      api.runtime.onMessage.removeListener(onMessage);
      api.tabs?.onUpdated?.removeListener(onUpdated);
      api.tabs?.onActivated?.removeListener(onActivated);
      api.tabs?.onRemoved?.removeListener(onRemoved);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      try { presencePort?.disconnect?.(); } catch { /* 已断开 */ }
      presencePort = null;
      stopDrain();
    };
  }

  return {
    get picked() { return [...picked]; },
    get active() { return active; },
    get tabId() { return tabId; },
    setActive,
    toggle: () => setActive(!active),
    add, remove, clear, highlight, drain, followTab, attach,
    /// 供测试断言哨兵状态;生产代码不应依赖它。
    get presenceConnected() { return presencePort !== null; },
    clearHighlight: () => highlight(null),
    /// 序列化为注入 prompt 的 XML 块;空集合返回空串。
    context: (elements = picked) => formatPickedElementsContext(elements)
  };
}
