// 用户消息里的「圈选元素 XML」投影。
//
// Chrome 插件把圈选的元素序列化成一段纯属性的 XML(见
// element-picker-context.js),发送时拼成:
//
//   <selected_page_elements url="…" title="…">
//   <element i="1" tag="button" css="#submit" text="提交" />
//   </selected_page_elements>
//
//   [指令] 用户原话
//
// 把这段标记直接铺在气泡里既难读又占地方,所以这里把它投影成键值卡片:
// 每个元素一张小卡,属性名/值一行一条,根元素的属性单独一张领头的卡。
// [指令] 之后的原话仍然按普通气泡渲染(见 node-views.js)。
//
// 与 Mac 的 XMLMessageCards.swift 是同一套判定与同一套投影,两边保持同形:
// 手写扫描而不是用 DOMParser —— 属性顺序必须保住(圈选顺序有含义),
// 且 picker 只转义 & < ",双引号里的 > 与 ' 都是合法 XML,DOMParser 会把
// 它们按规范解回来但拿不到有序属性表。
//
// 只有呈现:复制按钮与站内查找仍用原始消息文本。

/// 超过上限一律当普通文本,不解析。圈选一批最多 20 个元素、十来个属性,
/// 这几个上限只会被「本来就不可能是卡片」的大段粘贴触发。
export const XML_CARD_MAX_CHARS = 20000;
export const XML_CARD_MAX_ELEMENTS = 200;
export const XML_CARD_MAX_ATTRS = 64;
export const XML_CARD_MAX_DEPTH = 32;

/// 内联展示的元素卡数量上限,多出来的进「查看全部」弹窗。
export const XML_CARD_INLINE_LIMIT = 5;

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(raw) {
  if (!raw.includes("&")) return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== "&") { out += raw[i]; i += 1; continue; }
    const semi = raw.indexOf(";", i + 1);
    // 引用体太长或没有分号:按字面量留下,不因此判定解析失败。
    if (semi < 0 || semi - i > 12) { out += raw[i]; i += 1; continue; }
    const body = raw.slice(i + 1, semi);
    const decoded = decodeEntity(body);
    if (decoded == null) { out += raw[i]; i += 1; continue; }
    out += decoded;
    i = semi + 1;
  }
  return out;
}

function decodeEntity(body) {
  if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
  if (!body.startsWith("#")) return null;
  const hex = body.startsWith("#x") || body.startsWith("#X");
  const digits = body.slice(hex ? 2 : 1);
  if (!digits) return null;
  const value = Number.parseInt(digits, hex ? 16 : 10);
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return null;
  // 代理区码点不是合法标量,构造会抛异常。
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return String.fromCodePoint(value);
}

/// 一个最小但宽容的 XML 读取器。读不下去就返回 null —— 宁可退回原文气泡,
/// 也不猜着画一张读者看不懂的卡。
class Scanner {
  constructor(text) {
    this.chars = Array.from(text);
    this.index = 0;
    this.elements = 0;
  }

  peek(offset = 0) {
    return this.chars[this.index + offset];
  }

  skipWhitespace() {
    while (this.index < this.chars.length && /\s/.test(this.chars[this.index])) this.index += 1;
  }

  consume(char) {
    if (this.chars[this.index] !== char) return false;
    this.index += 1;
    return true;
  }

  hasPrefix(marker) {
    for (let i = 0; i < marker.length; i += 1) {
      if (this.chars[this.index + i] !== marker[i]) return false;
    }
    return true;
  }

  advance(count) {
    this.index = Math.min(this.chars.length, this.index + count);
  }

  skipUntil(marker) {
    while (this.index + marker.length <= this.chars.length) {
      if (this.hasPrefix(marker)) { this.advance(marker.length); return true; }
      this.index += 1;
    }
    return false;
  }

  parseName() {
    const first = this.peek();
    if (!first || !/[\p{L}_:]/u.test(first)) return null;
    const start = this.index;
    this.index += 1;
    while (this.index < this.chars.length) {
      const ch = this.chars[this.index];
      if (!/[\p{L}\p{N}_.:-]/u.test(ch)) break;
      this.index += 1;
    }
    return this.chars.slice(start, this.index).join("");
  }

  /// 引号内的值一路读到闭合引号:里面的 > 与 ' 都属于值本身。
  parseQuotedValue() {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") return null;
    this.index += 1;
    const start = this.index;
    while (this.index < this.chars.length && this.chars[this.index] !== quote) this.index += 1;
    if (this.index >= this.chars.length) return null;
    const raw = this.chars.slice(start, this.index).join("");
    this.index += 1;
    return decodeEntities(raw);
  }

  parseNode(depth) {
    if (depth >= XML_CARD_MAX_DEPTH || !this.consume("<")) return null;
    const tag = this.parseName();
    if (!tag) return null;

    const attributes = [];
    let selfClosing = false;
    for (;;) {
      this.skipWhitespace();
      if (this.hasPrefix("/>")) { this.advance(2); selfClosing = true; break; }
      if (this.consume(">")) break;
      const name = this.parseName();
      if (!name) return null;
      this.skipWhitespace();
      if (!this.consume("=")) return null;
      this.skipWhitespace();
      const value = this.parseQuotedValue();
      if (value == null) return null;
      if (attributes.length >= XML_CARD_MAX_ATTRS) return null;
      attributes.push({ name, value });
    }

    this.elements += 1;
    if (this.elements > XML_CARD_MAX_ELEMENTS) return null;

    const node = { tag, attributes, children: [], text: null };
    if (selfClosing) return node;

    const textParts = [];
    for (;;) {
      if (this.index >= this.chars.length) return null;
      if (this.peek() === "<") {
        if (this.hasPrefix("<!--")) { if (!this.skipUntil("-->")) return null; continue; }
        if (this.hasPrefix("<?")) { if (!this.skipUntil("?>")) return null; continue; }
        // DOCTYPE 与 CDATA 承载的标记没法忠实地画成键值行,整段放弃解析。
        if (this.hasPrefix("<!")) return null;
        if (this.hasPrefix("</")) {
          this.advance(2);
          this.skipWhitespace();
          const close = this.parseName();
          if (!close || close !== tag) return null;
          this.skipWhitespace();
          if (!this.consume(">")) return null;
          break;
        }
        const child = this.parseNode(depth + 1);
        if (!child) return null;
        node.children.push(child);
        continue;
      }
      const start = this.index;
      while (this.index < this.chars.length && this.chars[this.index] !== "<") this.index += 1;
      const chunk = this.chars.slice(start, this.index).join("").trim();
      if (chunk) textParts.push(decodeEntities(chunk));
    }
    if (textParts.length) node.text = textParts.join(" ");
    return node;
  }
}

function flatten(node, out) {
  out.push(node);
  for (const child of node.children) flatten(child, out);
}

/**
 * 把一段消息文本读成卡片投影;不是 XML(或读不动)时返回 null。
 *
 * @param {string} text 消息正文
 * @returns {{rootTag: string, cards: Array<{position: number, tag: string,
 *   attributes: Array<{name: string, value: string}>, text: string|null}>,
 *   remainder: string} | null}
 */
export function parseXMLMessageCards(text) {
  const source = typeof text === "string" ? text : "";
  if (!source || Array.from(source).length > XML_CARD_MAX_CHARS) return null;
  // 便宜的先决判断:绝大多数消息是散文,不该为一次注定失败的扫描付代价。
  const first = source.match(/\S/);
  if (!first || first[0] !== "<") return null;

  const scanner = new Scanner(source);
  scanner.skipWhitespace();
  const root = scanner.parseNode(0);
  if (!root) return null;
  scanner.skipWhitespace();
  const remainder = scanner.chars.slice(scanner.index).join("").trim();

  const nodes = [];
  flatten(root, nodes);
  // 一个属性都没有就只是散文(或一个光秃秃的标签),气泡读起来更好。
  const shown = nodes.filter(node => node.attributes.length || node.text != null);
  if (!shown.length || !shown.some(node => node.attributes.length)) return null;

  return {
    rootTag: root.tag,
    cards: shown.map((node, offset) => ({
      position: offset + 1,
      tag: node.tag,
      attributes: node.attributes.slice(),
      text: node.text
    })),
    remainder
  };
}

/// 卡片的纯文本形态,给详情弹窗的复制键用:与读者看到的是同一批行、同一顺序。
export function xmlCardsPlainText(cards, textLabel) {
  const lines = [];
  for (const card of cards) {
    lines.push("#" + card.position + " " + card.tag);
    for (const attribute of card.attributes) {
      lines.push(attribute.name + ": " + attribute.value);
    }
    if (card.text != null) lines.push(textLabel + ": " + card.text);
    lines.push("");
  }
  return lines.join("\n").trim();
}
