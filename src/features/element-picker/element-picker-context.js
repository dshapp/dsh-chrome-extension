// 把已选页面元素序列化成注入 prompt 的上下文块。
//
// 格式刻意做成「纯属性、一行一元素、不缩进」,只发结构化摘要与定位符,不发 innerHTML:
//
//   - 所有字段都进属性,name/text/note 不再占子节点 —— 20 元素同批实测比旧格式小 ~31%
//     (旧的 name 正文 + <text>/<note> 子节点 + 4 空格缩进都要乘以元素个数);
//   - 定位符只发 css:bridge 的 elementExpression() 只认 @eN 与 @option:<id>,其余一律
//     走 document.querySelector,XPath 没有任何工具消费;picker 自己的 ref_N 也不在
//     任何工具的可解析范围内 —— 发出去只会诱导模型拿它去 click 然后失败。所以
//     xpath / ref 都不进 prompt。
//   - 空值不产出属性:一排 foo="" 纯属占位。
//   - 属性值里 > 与 ' 合法,不转义(css 里每个 > 因此省 3 字节)。
//
// 页面侧摘要(picker-element-summary.js)仍照常产出 xpath/ref:药丸 tooltip 与 hover
// 高亮还在用,这里只是不把它们写进 prompt。

const MAX_TEXT = 160;
/// 批注是用户对这个元素的原话,是本轮交互的核心诉求 —— 按 MAX_TEXT 截会把需求截没,
/// 所以单独给它一个更宽的上限。
const MAX_NOTE = 500;

/** 属性值转义。& 必须最先替换;'>' 与 "'" 在双引号属性里合法,不转义。 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/** 折叠空白:批注允许换行(Shift+Enter),不折叠会把属性行劈成多行,破坏「一行一元素」。 */
function normalize(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function truncate(value, max = MAX_TEXT) {
  const text = normalize(value);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** 空值不产出属性,避免一排 foo="" 占位。 */
function attr(name, value, max = MAX_TEXT) {
  const text = truncate(value, max);
  return text ? ` ${name}="${escapeAttr(text)}"` : "";
}

/// url 与定位符一样不能截断:半截 URL 既无法点开也无法比对,省下的 token 毫无意义。
function rawAttr(name, value) {
  const text = normalize(value);
  return text ? ` ${name}="${escapeAttr(text)}"` : "";
}

function elementXml(element, index) {
  const attrs = element.attrs || {};
  const tag = truncate(element.tag || "element");
  const name = truncate(element.name);
  // role 与 tag 同义时(<button> 的 role=button)不带,只有显式改写过语义才有信息量。
  const role = truncate(element.role);
  // describe() 已优先把 aria-label / placeholder 当 name,这里只补它们与 name 不同的情形。
  const ariaLabel = truncate(attrs.ariaLabel);
  const placeholder = truncate(attrs.placeholder);
  // 可读名称当属性;可见文本与它不同时才另出一个 text。
  const text = truncate(element.text);
  return [
    `<element i="${index + 1}"`,
    attr("tag", tag),
    role && role !== tag ? attr("role", role) : "",
    // 定位符优先级:css 是本栈唯一能被工具直接执行的定位方式。
    rawAttr("css", element.selector),
    ariaLabel && ariaLabel !== name ? attr("aria_label", ariaLabel) : "",
    placeholder && placeholder !== name ? attr("placeholder", placeholder) : "",
    attr("href", attrs.href),
    text && text !== name ? attr("text", text) : "",
    attr("name", name),
    attr("note", element.note, MAX_NOTE),
    " />",
  ].join("");
}

/**
 * @param {Array<object>} elements
 * @returns {string} 空列表回空串,调用方据此决定是否拼接。
 */
export function formatPickedElementsContext(elements) {
  if (!Array.isArray(elements) || !elements.length) return "";
  const page = elements.find(element => element.url || element.title) || {};
  // count 不再产出:一行一元素之后模型直接数行即可。
  const root = [
    "<selected_page_elements",
    rawAttr("url", page.url),
    attr("title", page.title),
  ].join("");
  return [`${root}>`, ...elements.map(elementXml), "</selected_page_elements>"].join("\n");
}
