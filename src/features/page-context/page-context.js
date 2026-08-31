// 「携带当前页面上下文」开关。开启后**只在下一条消息**里把用户当前正在看的
// 标签页 tabId 拼进 prompt,发过一次就不再重复。
//
// 为什么只发一次:tabId 在整个会话里是稳定的,模型读过一次就记住了;
// 每条都带既浪费 token,又会让模型误以为"用户又切了一次页面"。
// 想再带一次(比如真的换了标签页),关掉开关再打开即可。
//
// 与 element-picker 的分工:picker 是用户显式圈选的少数元素("我指的是这个"),
// 这里只回答"我现在在哪个标签页上" —— 页面内容由模型拿着 tabId 自己按需去取,
// 不预先塞快照,省 token 也不必往用户页面注入任何脚本。
import { formatPageContext } from "./page-context-format.js";

/// 开关状态的持久化位置。与 workspace-menu.js 一样直接落 chrome.storage.local。
export const PAGE_CONTEXT_STORAGE_KEY = "dsh_page_context_enabled";

/**
 * @param {object} options
 * @param {typeof chrome} [options.chromeApi] 便于测试注入假实现
 * @param {(msg: string) => void} [options.showToast]
 * @param {(key: string, params?: object) => string} options.t
 * @param {() => void} [options.onChange] 开关变化时通知调用方(刷新按钮)
 */
export function createPageContext({ chromeApi, showToast = () => {}, t, onChange = () => {} } = {}) {
  const api = chromeApi ?? (typeof chrome !== "undefined" ? chrome : null);
  let enabled = false;

  const log = (tag, error) => console.warn(`[page-context] ${tag}`, error?.message ?? error);

  const storage = () => (api?.storage?.local ?? null);

  /// 用户是否已经亲手切过开关。storage 是异步读的,而按钮从挂上那一刻就能点:
  /// 若用户在读盘返回之前就点了,那次点击才是最新意图,读回来的旧值不能盖掉它。
  let touched = false;

  /// 还欠着一次注入吗?开关每次打开装填一次,发出去一次就消耗掉。
  /// 侧栏重开时它是 true —— 从 storage 读回开态,等同于"这一程还没发过"。
  let pending = false;

  /// 启动时读回上次的开关状态。读不到(首次使用/非扩展环境)就留默认关闭。
  async function load() {
    const store = storage();
    if (!store) return enabled;
    try {
      const value = await store.get([PAGE_CONTEXT_STORAGE_KEY]);
      // 读盘期间用户已经表过态,就丢掉这次读回的结果。
      if (touched) return enabled;
      enabled = Boolean(value?.[PAGE_CONTEXT_STORAGE_KEY]);
      // 侧栏刚开:读回开态就意味着这一程还欠一次注入。
      if (enabled) pending = true;
    } catch (error) {
      log("LOAD_ERR", error);
    }
    onChange();
    return enabled;
  }

  async function persist() {
    const store = storage();
    if (!store) return;
    try {
      if (enabled) await store.set({ [PAGE_CONTEXT_STORAGE_KEY]: true });
      else await store.remove([PAGE_CONTEXT_STORAGE_KEY]);
    } catch (error) {
      log("PERSIST_ERR", error);
    }
  }

  /// 开关切换时给一次明确反馈 —— 它影响的是"下一条消息",不点开关看不出来。
  function setEnabled(next) {
    const value = Boolean(next);
    touched = true;
    if (enabled === value) return enabled;
    enabled = value;
    // 每次**打开**都重新装填一次额度:用户重新点开,意图就是"再带一次"。
    if (enabled) pending = true;
    void persist();
    showToast(t(enabled ? "pageCtx.on" : "pageCtx.off"));
    onChange();
    return enabled;
  }

  /**
   * 取当前标签页。
   *
   * 始终取**用户当前正在看的**那一个,与 element-picker 的 targetTab 同义:
   * 侧栏开着、用户又切了标签页时,会话绑定页会指向错误的页面。
   *
   * 关键约定:**这个函数不抛异常**。它挂在发送路径上,取不到 tab 绝不能
   * 连累消息发不出去 —— 失败就当作没有上下文可带。
   */
  async function capture() {
    if (!enabled) return null;
    if (!api?.tabs?.query) return null;
    try {
      const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id != null ? { tabId: tab.id } : null;
    } catch (error) {
      log("TAB_ERR", error);
      return null;
    }
  }

  return {
    get enabled() { return enabled; },
    /// 下一条消息还会不会带 tabId。供测试与调用方观察,生产代码不依赖它。
    get pending() { return pending; },
    setEnabled,
    toggle: () => setEnabled(!enabled),
    load,
    capture,
    /**
     * 发送路径的便捷入口:回这一条要拼的文本,没有就回空串。
     *
     * **一次性**:开关打开后只有下一条消息带 tabId,发过就把额度消耗掉。
     * 额度在这里(而不是发送成功之后)扣除 —— 用户选的是"算用掉":
     * 只要这条消息尝试发过,就不再重复注入,免得失败重试时反复堆同一行。
     *
     * 关态或额度已用完时**同步**返回空串而不是 Promise:这个调用挂在
     * sendMessage 上,一个 await 就会把 sessions.prompt 推迟一个微任务。
     * 不注入的那些轮没有理由改动既有发送路径的时序,一次 tick 都不欠。
     */
    context: () => {
      if (!enabled || !pending) return "";
      pending = false;
      return capture().then(formatPageContext);
    }
  };
}
