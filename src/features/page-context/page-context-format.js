// 把当前标签页的 tabId 拼成一行提示词。
//
// 刻意只有一行:模型拿到 tabId 就能自己调浏览器工具(snapshot / get_text / click …)
// 按需读页面,不必每条消息都预先塞页面快照,也不必用 XML 包一层 ——
// 与 element-picker 的 <selected_page_elements> 不同,这里没有多字段要分隔。

/**
 * @param {{ tabId?: number }|null} capture createPageContext().capture() 的产物
 * @returns {string} 没有 tabId 时回空串,调用方据此决定是否拼接。
 */
export function formatPageContext(capture) {
  if (!capture || !Number.isInteger(capture.tabId)) return "";
  return `当前页面tabId=${capture.tabId}`;
}
