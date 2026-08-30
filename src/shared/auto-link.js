// 裸 URL 自动探测:把行内文本里未被 markdown 链接语法包裹的 http(s) URL 转成 <a>。
// 参考 dshmac 的 DSWLinkDetection.swift。
//
// 时序:本模块跑在 renderInline 的最后一步,输入是"已转义并已套好 <code>/<strong>/
// <em>/<a> 标签"的 HTML 片段,而不是原始文本。所以必须做两件事:
//
// 1. 只在标签之外的文本节点里探测 —— 否则会命中 <a href="URL"> 里的 URL,
//    把已有链接重写成嵌套的坏 HTML;<code> 里的 URL 也应保持代码样态不变。
//    这对应 Swift 版的 proseMask(遮蔽 inline code 与已有 [text](dest) 链接)。
// 2. URL 在字符串里已是转义态(& → &amp;),入 href 时直接沿用,不能二次转义。

// 一个裸 http(s) URL。停在空白与各类括号处,这样 (https://x) 或已有链接的
// 尾部定界符不会被吞进来;尾部标点在匹配后再修剪。同时排除 CJK 全角标点
// (（）【】、。 等):它们不会合法出现在 URL 里,而放任匹配越过全角定界符会把
// URL 拖长成错误的地址。& 在转义后写作 &amp;,故 ; 不能整体排除(否则查询串
// a=1&b=2 会被截断),交给尾部标点修剪处理。
const BARE_URL = /https?:\/\/[^\s<>[\]{}()|^\\"'（）〈〉《》「」『』【】〔〕、，。；：！？''""…]+/g;

// 紧贴 URL 末尾但不属于地址的散文标点。
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'*~\\]+$/;

// HTML 标签,或一个字符实体。按标签切分时用它跳过标签本身。
const TAG_OR_ENTITY = /<[^>]*>/g;

// 把 URL 尾部的散文标点还给正文。&amp; / &quot; 这类实体以 ; 结尾,若整体被
// 当成标点剪掉会破坏 URL,因此先保护实体尾巴再修剪。
function trimTrailingPunctuation(url) {
  const entitySafe = url.replace(/&[a-z]+;$/i, "");
  const suffixStart = entitySafe.length;
  const trimmed = entitySafe.replace(TRAILING_PUNCTUATION, "");
  return trimmed + url.slice(suffixStart);
}

function linkifySegment(segment) {
  return segment.replace(BARE_URL, (match) => {
    const url = trimTrailingPunctuation(match);
    if (!url) return match;
    const tail = match.slice(url.length);
    // url 已处于转义态(escapeHtml 先行),直接进 href 与文本,不可二次转义。
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>` + tail;
  });
}

/**
 * 在已渲染的行内 HTML 中把裸 URL 转成链接。
 * 只处理标签之外的文本片段:<a>、<code> 等标签内部与其属性一律不动。
 */
export function autoLinkUrls(html) {
  const input = String(html ?? "");
  let out = "";
  let last = 0;
  // depth > 0 表示当前正处在 <a> 或 <code> 内部 —— 这些区域不探测。
  let skipDepth = 0;
  TAG_OR_ENTITY.lastIndex = 0;
  let tag;
  while ((tag = TAG_OR_ENTITY.exec(input)) !== null) {
    const text = input.slice(last, tag.index);
    out += skipDepth > 0 ? text : linkifySegment(text);
    out += tag[0];
    last = tag.index + tag[0].length;
    const name = /^<\s*(\/?)\s*(a|code)\b/i.exec(tag[0]);
    if (name) {
      if (name[1]) skipDepth = Math.max(0, skipDepth - 1);
      else skipDepth += 1;
    }
  }
  const rest = input.slice(last);
  out += skipDepth > 0 ? rest : linkifySegment(rest);
  return out;
}
