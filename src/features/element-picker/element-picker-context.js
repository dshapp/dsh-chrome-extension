// 把已选页面元素序列化成注入 prompt 的上下文块,用语义化 XML 包裹,
// 便于大模型稳定解析出「用户指代了哪些元素」以及每个元素的定位信息。
// 只发结构化摘要与定位符,不发 innerHTML,控制 token。
//
// 刻意不带说明句:标签名 selected_page_elements 与属性名 xpath/css/ref 已自解释,
// 每条消息重复教一遍定位优先级纯属浪费 token。同理不发 id/class(已被选择器编码)、
// 不发 bounding_box(无消费方,computer 工具按 ref 操作)。

const MAX_TEXT = 160;
/// 批注是用户对这个元素的原话,是本轮交互的核心诉求 —— 按 MAX_TEXT 截会把需求截没,
/// 所以单独给它一个更宽的上限。
const MAX_NOTE = 500;

/** XML 文本节点转义。属性值同样走这里,因此统一转义引号。 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(value) {
  const text = String(value == null ? "" : value).trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "…" : text;
}

/** 空值不产出属性,避免一排 foo="" 占位。 */
function attr(name, value) {
  const text = truncate(value);
  return text ? ` ${name}="${escapeXml(text)}"` : "";
}

/// url 与定位符一样不能截断:半截 URL 既无法点开也无法比对,省下的 token 毫无意义。
function rawAttr(name, value) {
  const text = String(value == null ? "" : value).trim();
  return text ? ` ${name}="${escapeXml(text)}"` : "";
}

function elementXml(element, index) {
  const attrs = element.attrs || {};
  const tag = element.tag || "element";
  const name = truncate(element.name);
  // role 与 tag 同义时(<button> 的 role=button)不带,只有显式改写过语义才有信息量。
  const role = truncate(element.role);
  // describe() 已优先把 aria-label / placeholder 当 name,这里只补它们与 name 不同的情形。
  const ariaLabel = truncate(attrs.ariaLabel);
  const placeholder = truncate(attrs.placeholder);
  const head = [
    `    <element i="${index + 1}"`,
    attr("tag", tag),
    role && role !== tag ? attr("role", role) : "",
    // 定位信息优先级:xpath / css 稳定可回放,ref 只在本次页面生命周期内有效。
    rawAttr("xpath", element.xpath),
    rawAttr("css", element.selector),
    rawAttr("ref", element.ref),
    ariaLabel && ariaLabel !== name ? attr("aria_label", ariaLabel) : "",
    placeholder && placeholder !== name ? attr("placeholder", placeholder) : "",
    attr("href", attrs.href),
  ].join("");
  // 批注走子节点而不是属性:它是用户原话,可能多行、可能很长,塞进属性行既难读也易超宽。
  const noteRaw = String(element.note == null ? "" : element.note).trim();
  const note = noteRaw.length > MAX_NOTE ? noteRaw.slice(0, MAX_NOTE) + "…" : noteRaw;
  // 可读名称当正文;可见文本与它不同时才另起子节点(长文本不挤进属性行)。
  const text = truncate(element.text);
  const children = [];
  if (text && text !== name) children.push(`      <text>${escapeXml(text)}</text>`);
  if (note) children.push(`      <note>${escapeXml(note)}</note>`);
  if (children.length) {
    const body = name ? [`      ${escapeXml(name)}`, ...children] : children;
    return `${head}>\n${body.join("\n")}\n    </element>`;
  }
  return name ? `${head}>${escapeXml(name)}</element>` : `${head} />`;
}

/**
 * @param {Array<object>} elements
 * @returns {string} 空列表回空串,调用方据此决定是否拼接。
 */
export function formatPickedElementsContext(elements) {
  if (!Array.isArray(elements) || !elements.length) return "";
  const page = elements.find(element => element.url || element.title) || {};
  const root = [
    `<selected_page_elements count="${elements.length}"`,
    rawAttr("url", page.url),
    attr("title", page.title),
  ].join("");
  return [`${root}>`, ...elements.map(elementXml), "</selected_page_elements>"].join("\n");
}
