// 圈选元素 XML 的卡片视图(见 user-xml-cards.js 的解析)。
//
// 结构对齐 Mac 的 XMLMessageCardsView:每张卡一行等宽标签头 + 若干「标签 / 值」
// 键值行;超过内联上限的部分挂一个「查看全部」入口,点开走全局唯一的卡片详情
// 弹窗(card-detail.js)。DOM 一次性建好,没有状态,也不需要增量更新。
import { t } from "../../shared/i18n.js";
import { openCardDetail } from "./card-detail.js";
import { XML_CARD_INLINE_LIMIT, xmlCardsPlainText } from "./user-xml-cards.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/// 一张卡的键值行。text 属性与普通属性走同一套排版,只是标签用文案「文本」。
function cardRow(label, value) {
  const row = el("div", "xml-card-row");
  row.append(el("span", "xml-card-key", label));
  row.append(el("span", "xml-card-value", value));
  return row;
}

function cardNode(card) {
  const node = el("div", "xml-card");
  node.append(el("div", "xml-card-tag", card.tag));
  const body = el("div", "xml-card-body");
  for (const attribute of card.attributes) body.append(cardRow(attribute.name, attribute.value));
  // 元素的可见文本按「文本」键落成一行,与 Mac 一致。
  if (card.text != null) body.append(cardRow(t("xmlCard.text"), card.text));
  node.append(body);
  return node;
}

/**
 * 卡片列表。传入的 cards 全量渲染 —— 内联截断由调用方决定,详情弹窗直接复用。
 * @param {Array<object>} cards parseXMLMessageCards 产出的卡片
 */
export function createXmlCards(cards) {
  const wrap = el("div", "xml-cards");
  for (const card of cards) wrap.append(cardNode(card));
  return wrap;
}

/**
 * 用户气泡里的内联卡片:最多 XML_CARD_INLINE_LIMIT 张,余下的进「查看全部」。
 * @param {Array<object>} cards
 * @param {{rootTag: string}} parsed 供详情弹窗取标题与复制文本
 */
export function createUserXmlCards(cards, parsed) {
  const wrap = el("div", "xml-cards");
  const shown = cards.slice(0, XML_CARD_INLINE_LIMIT);
  for (const card of shown) wrap.append(cardNode(card));
  if (cards.length <= shown.length) return wrap;

  const more = el("button", "msg-user-more msg-xml-more");
  more.type = "button";
  more.textContent = t("xmlCards.viewAll", { n: String(cards.length) });
  more.addEventListener("click", () => {
    openCardDetail({
      title: parsed.rootTag,
      build: () => createXmlCards(cards),
      copyText: () => xmlCardsPlainText(cards, t("xmlCard.text"))
    });
  });
  wrap.append(more);
  return wrap;
}
