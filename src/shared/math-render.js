// KaTeX 数学公式:文本切分 + 渲染封装。
//
// 切分与渲染分开:切分是纯字符串判定(可单测、不依赖 KaTeX 是否加载),渲染是
// 对第三方库的一层薄封装(库缺席时返回 null,由调用方降级)。合成一个函数会让
// "货币金额不该被当公式"这类规则只能在装好 KaTeX 的环境里测。
//
// 时序:本模块跑在 renderInline 里,输入是**已 escapeHtml 转义**的片段。这带来
// 一个必须处理的事实 —— TeX 源码里的 <、>、& 此刻是 &lt; &gt; &amp;,而 KaTeX
// 要的是原始字符(\lt 与 &lt; 不是一回事)。所以喂给 KaTeX 之前要**反转义**,
// 见 unescapeForTex。这不会引入注入:KaTeX 自己产出的是结构化 HTML,
// 它不会把输入当标签解析。

/// 转义态还原成 TeX 源码。只还原 escapeHtml 造出的那四个实体,不做通用实体解码 ——
/// 通用解码会把正文里本来就写着的 "&amp;" 也吃掉一层。
function unescapeForTex(text) {
  return String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/// 单个 $ 定界的行内公式,是否**看起来**真的是公式而不是货币。
///
/// 三条规则,针对的都是真实误伤:
/// 1. 内容非空且首字符不是空白 —— "$ 100" 这种明显是金额。
/// 2. 内容不含换行 —— 行内公式不跨行;跨行的 $ 几乎必然是两处独立的金额。
/// 3. 尾字符不是空白 —— 对称地挡住 "100 $"。
/// 还有一条在 splitMathSegments 里做:开定界符左边紧邻数字时不认(如 "5$")。
function looksLikeInlineMath(body) {
  if (!body) return false;
  if (/^\s/.test(body) || /\s$/.test(body)) return false;
  if (body.includes("\n")) return false;
  return true;
}

/**
 * 把一段(已转义的)行内文本切成数学段与普通段。
 *
 * 识别 $$…$$(块级)与 $…$(行内)。\$ 视为字面美元符,不参与配对。
 *
 * @param {string} text 已转义的文本。
 * @returns {{kind:"text"|"math", value:string, display:boolean}[]} 顺序片段。
 */
export function splitMathSegments(text) {
  const input = String(text ?? "");
  const segments = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) { segments.push({ kind: "text", value: buffer, display: false }); buffer = ""; }
  };
  while (i < input.length) {
    const ch = input[i];
    // 转义的美元符:原样留在正文,且不参与后续配对。
    if (ch === "\\" && input[i + 1] === "$") { buffer += "\\$"; i += 2; continue; }
    if (ch !== "$") { buffer += ch; i += 1; continue; }

    const isBlock = input[i + 1] === "$";
    const fence = isBlock ? "$$" : "$";
    // 从定界符之后找配对的闭合符。块级不受"像不像公式"的规则约束:
    // 写了 $$ 的人是明确在写公式,没有货币歧义。
    const close = input.indexOf(fence, i + fence.length);
    if (close === -1) { buffer += ch; i += 1; continue; }
    const body = input.slice(i + fence.length, close);
    if (!isBlock) {
      // "5$x$" 里左边那个 $ 更可能是金额的一部分,不开公式。
      const prev = input[i - 1];
      if (prev !== undefined && /[0-9]/.test(prev)) { buffer += ch; i += 1; continue; }
      if (!looksLikeInlineMath(body)) { buffer += ch; i += 1; continue; }
    }
    if (!body.trim()) { buffer += ch; i += 1; continue; }
    flush();
    segments.push({ kind: "math", value: body, display: isBlock });
    i = close + fence.length;
  }
  flush();
  return segments;
}

/// 当前环境里的 KaTeX(UMD 挂在 window 上)。未加载返回 null。
function katexGlobal() {
  return (typeof globalThis !== "undefined" && globalThis.katex) || null;
}

/**
 * 渲染一段 TeX 为 HTML。
 *
 * @param {string} tex 转义态的 TeX 源码(内部会还原)。
 * @param {{display?: boolean}} options display 为 true 时按块级公式排版。
 * @returns {string|null} HTML;KaTeX 未加载或渲染失败时为 null(调用方降级为原文)。
 */
export function renderMath(tex, { display = false } = {}) {
  const katex = katexGlobal();
  if (!katex?.renderToString) return null;
  try {
    return katex.renderToString(unescapeForTex(tex), {
      displayMode: Boolean(display),
      // 语法错误不抛异常,渲染成红色的错误提示 —— 一条写错的公式不该让
      // 整条消息的 Markdown 渲染中断。
      throwOnError: false,
      output: "html"
    });
  } catch {
    return null;
  }
}
