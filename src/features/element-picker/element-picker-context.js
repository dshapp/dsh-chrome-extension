// 把已选页面元素序列化成注入 prompt 的上下文块,用语义化 XML 包裹,
// 便于大模型稳定解析出「用户指代了哪些元素」以及每个元素的定位信息。
// 只发结构化摘要与定位符,不发 innerHTML,控制 token。

const MAX_TEXT = 160;

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

function childTag(tag, value) {
  const text = truncate(value);
  return text ? `      <${tag}>${escapeXml(text)}</${tag}>` : "";
}

function elementXml(element, index) {
  const attrs = element.attrs || {};
  const rect = element.rect || {};
  const lines = [`    <element index="${index + 1}" tag="${escapeXml(element.tag || "element")}">`];
  // 定位信息优先级:xpath / css selector 稳定可回放,ref 只在本次页面生命周期内有效。
  lines.push("      <locators>");
  lines.push(childTag("xpath", element.xpath).replace("      <", "        <"));
  lines.push(childTag("css_selector", element.selector).replace("      <", "        <"));
  lines.push(childTag("ref", element.ref).replace("      <", "        <"));
  lines.push("      </locators>");
  lines.push(childTag("role", element.role));
  lines.push(childTag("accessible_name", element.name));
  const text = truncate(element.text);
  if (text && text !== truncate(element.name)) lines.push(childTag("text", text));
  lines.push(childTag("id", attrs.id));
  lines.push(childTag("class", attrs.class));
  lines.push(childTag("aria_label", attrs.ariaLabel));
  lines.push(childTag("placeholder", attrs.placeholder));
  lines.push(childTag("href", attrs.href));
  if (Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
    lines.push(`      <bounding_box x="${Math.round(rect.x)}" y="${Math.round(rect.y)}" width="${Math.round(rect.width)}" height="${Math.round(rect.height)}" />`);
  }
  lines.push("    </element>");
  return lines.filter(Boolean).join("\n");
}

/**
 * @param {Array<object>} elements
 * @returns {string} 空列表回空串,调用方据此决定是否拼接。
 */
export function formatPickedElementsContext(elements) {
  if (!Array.isArray(elements) || !elements.length) return "";
  const page = elements.find(element => element.url || element.title) || {};
  const lines = ["<selected_page_elements>"];
  lines.push(
    "  <description>用户在页面上手动选取了以下元素,本轮请求即针对这些元素。" +
    "定位时优先使用 xpath 或 css_selector;ref 仅在当前页面未刷新时有效,可直接传给 computer 工具。</description>",
  );
  if (page.url || page.title) {
    const attrs = [];
    if (page.url) attrs.push(`url="${escapeXml(page.url)}"`);
    if (page.title) attrs.push(`title="${escapeXml(truncate(page.title))}"`);
    lines.push(`  <page ${attrs.join(" ")} />`);
  }
  lines.push(`  <elements count="${elements.length}">`);
  lines.push(...elements.map(elementXml));
  lines.push("  </elements>");
  lines.push("</selected_page_elements>");
  return lines.join("\n");
}
