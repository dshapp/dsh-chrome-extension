// 「当前网页」上下文的取数层:回答"用户现在在哪个标签页上"。
//
// 只取 tabId,不取页面内容 —— 模型拿着 tabId 就能自己调浏览器工具
// (snapshot / get_text / click …)按需读页面,不必预先塞快照,
// 省 token 也不必往用户页面注入任何脚本。
//
// 这里**没有开关状态**:带不带这一行由输入框里的「当前网页」胶囊决定
// (见 trigger-menu.js 的 page 候选)。胶囊在草稿里可见、可删、可重复插,
// 天然就是"这一条带不带"的答案,不需要再额外维护 enabled/pending/storage。
//
// 与 element-picker 的分工:picker 是用户显式圈选的少数元素("我指的是这个"),
// 这里只回答"我现在在哪个标签页上"。

/**
 * @param {object} options
 * @param {typeof chrome} [options.chromeApi] 便于测试注入假实现
 */
export function createPageContext({ chromeApi } = {}) {
  const api = chromeApi ?? (typeof chrome !== "undefined" ? chrome : null);

  /**
   * 取当前标签页。
   *
   * 始终取**用户当前正在看的**那一个,与 element-picker 的 targetTab 同义:
   * 侧栏开着、用户又切了标签页时,会话绑定页会指向错误的页面。
   *
   * 关键约定:**这个函数不抛异常**。取不到 tab 只意味着"没有网页可引用",
   * 调用方据此提示用户,绝不能连累其他流程。
   *
   * @returns {Promise<{ tabId: number }|null>}
   */
  async function captureCurrentTab() {
    if (!api?.tabs?.query) return null;
    try {
      const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id != null ? { tabId: tab.id } : null;
    } catch (error) {
      console.warn("[page-context] TAB_ERR", error?.message ?? error);
      return null;
    }
  }

  return { captureCurrentTab };
}
