// 最小 Markdown → HTML 渲染:先整体转义再套标签,输出可安全 innerHTML。
// 支持:标题(h1–h4)、fenced code、行内 code、粗体/斜体/删除线、链接、图片、
// 数学公式、无序/有序列表、任务列表、分隔线、引用、表格(含对齐)、段落。
import { autoLinkUrls } from "./auto-link.js";
import { isSafeImageSrc } from "./image-src.js";
import { splitMathSegments, renderMath } from "./math-render.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

// 行内规则(数学之外的部分)。抽出来是因为数学段要跳过这一整套:
// KaTeX 产出的 HTML 里带 _ ^ * 之类字符,再过一遍 markdown 行内规则会被
// 当成斜体/粗体切碎。
function renderInlineMarkup(escaped) {
  let out = escaped;
  // 行内 code 通常已被 renderInline 挖成占位符,这条规则因此多数时候不命中。
  // 保留它是为了让本函数**自身成立**:它不假设调用方一定做过挖取。
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // 删除线(GFM)。放在粗体之前:~~a~~ 里若含 **b**,先切删除线再处理内部强调。
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // 图片必须排在链接之前:两者只差一个前导 "!",链接规则先跑会把
  // ![alt](src) 的 [alt](src) 部分吃掉,只剩一个孤零零的 "!"。
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, src) =>
    (isSafeImageSrc(src)
      // src 已是转义态(escapeHtml 先行),直接进属性,不可二次转义。
      // alt 已是转义态(escapeHtml 先行),这里只补单引号 —— 再跑一次
      // escapeAttribute 会把 &quot; 二次转义成 &amp;quot;,把正文写坏。
      ? `<img src="${src}" alt="${alt.replace(/'/g, "&#39;")}" loading="lazy" referrerpolicy="no-referrer">`
      // 白名单外的地址按字面文本留在正文:用户能看见模型到底写了什么,
      // 而一个空 src 的 <img> 只会留下碎图标,把问题藏起来。
      : match));
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // 裸 URL 兜底:必须放在最后,此时 <code> 与显式链接都已成标签,可被安全跳过。
  out = autoLinkUrls(out);
  return out;
}

// 数学段的占位符。用 \u0000 包裹:escapeHtml 之后的正文不可能含控制字符
//(真有的话也已被 image-src 那类判定拒了),所以不会和用户内容撞车。
//
// 为什么用占位符而不是把 "katex" 加进 autoLinkUrls 的跳过名单:那样会让
// auto-link 这个纯粹的"文本→链接"模块记住第三方库的类名,耦合面只增不减。
// 占位符让数学段在整条行内管线里完全不可见,规则再多也影响不到它。
const MATH_SLOT = "\u0000math:";
const MATH_SLOT_END = "\u0000";

// 行内 code 的占位槽。理由与 MATH_SLOT 同类,但顺序上必须**先于**数学切分:
// `$PATH` 与 `$HOME` 里的两个 $ 分处两段代码中,数学切分若先跑,会把它们
// 配成一对,把中间的反引号连同 "与" 一起吞进公式。先把代码段挖走再切数学,
// 这类跨代码块的错误配对就不可能发生。
const CODE_SLOT = "\u0000code:";
const CODE_SLOT_END = "\u0000";

function renderInline(text) {
  const escaped = escapeHtml(text);

  // 1) 先把行内 code 挖成占位符,内容原样留存。
  const codes = [];
  const withoutCode = escaped.replace(/`([^`]+)`/g, (_, body) => {
    codes.push(body);
    return CODE_SLOT + (codes.length - 1) + CODE_SLOT_END;
  });

  const restoreCode = (html) => (codes.length
    ? html.replace(/\u0000code:(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)] ?? ""}</code>`)
    : html);

  const segments = splitMathSegments(withoutCode);
  // 常见情况:没有公式,直接走原有管线,不付切分与回填的代价。
  if (segments.length === 1 && segments[0].kind === "text") {
    return restoreCode(renderInlineMarkup(withoutCode));
  }

  const rendered = [];
  let masked = "";
  for (const segment of segments) {
    if (segment.kind === "text") { masked += segment.value; continue; }
    const html = renderMath(segment.value, { display: segment.display });
    // KaTeX 缺席或渲染失败:把原样的 $…$ 放回正文当普通文本 ——
    // 公式读不了也好过整段消息消失。
    if (html === null) {
      const fence = segment.display ? "$$" : "$";
      masked += fence + segment.value + fence;
      continue;
    }
    masked += MATH_SLOT + rendered.length + MATH_SLOT_END;
    rendered.push(html);
  }
  const out = renderInlineMarkup(masked);
  const withMath = rendered.length
    ? out.replace(/\u0000math:(\d+)\u0000/g, (_, index) => rendered[Number(index)] ?? "")
    : out;
  return restoreCode(withMath);
}

// 表格分隔行:|---|:--:|---| 这种(表头下一行)。
function isTableSeparatorRow(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

// 拆表格行的单元格:去掉首尾 | 再按 | 分。
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

function splitFencedBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  let buffer = [];
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  for (const line of lines) {
    // CommonMark 允许开栅栏与信息串之间有空白("``` js"):反引号后先吃掉
    // 空白,信息串再取到行尾并去掉首尾空白。原来的 (\S*) 要求反引号后立刻是
    // 非空白,于是带前导空格的围栏既不算开也不算关 —— 代码块退化成段落,
    // 后面真正的关栅栏反倒开了个吞掉余下正文的 <pre>。
    // 栅栏判定必须与 incremental-markdown 的 stableCut(/^\s*```/)一致,
    // 否则切点会落进代码块。
    const fenceMatch = /^\s*```\s*(\S*)\s*$/.exec(line);
    if (fenceMatch && !inCode) {
      if (buffer.length) { blocks.push({ kind: "text", lines: buffer }); buffer = []; }
      inCode = true;
      codeLang = fenceMatch[1];
      codeLines = [];
    } else if (fenceMatch && inCode) {
      blocks.push({ kind: "code", lang: codeLang, lines: codeLines });
      inCode = false;
    } else if (inCode) {
      codeLines.push(line);
    } else {
      buffer.push(line);
    }
  }
  if (inCode && codeLines.length) blocks.push({ kind: "code", lang: codeLang, lines: codeLines });
  if (buffer.length) blocks.push({ kind: "text", lines: buffer });
  return blocks;
}

function renderTextBlock(lines) {
  const html = [];
  let listItems = null;
  let listOrdered = false;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems) {
      const tag = listOrdered ? "ol" : "ul";
      const items = listItems.map((item) => {
        // task 为布尔值即 GFM 任务项;null 是普通项。
        if (item.task == null) return `<li>${renderInline(item.text)}</li>`;
        const checked = item.task ? " checked" : "";
        return `<li class="task-list-item"><input type="checkbox" disabled${checked}> ${renderInline(item.text)}</li>`;
      }).join("");
      html.push(`<${tag}>${items}</${tag}>`);
      listItems = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      // 保留语义层级;尺寸由 .msg-agent h1…h6 限定,不会溢到侧栏标题。
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    // 分隔线:---/***/___ 独占一行(至少 3 个)。
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(); flushList();
      html.push("<hr>");
      continue;
    }
    // 表格:当前行含 |,且下一行是分隔行(|---|---|)。
    if (line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      flushParagraph(); flushList();
      const header = splitTableRow(line);
      const separator = splitTableRow(lines[i + 1]);
      // GFM 对齐::---: 居中、:--- 左、---: 右。
      const aligns = header.map((_, ci) => {
        const cell = separator[ci] ?? "";
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      });
      const alignClass = (ci) => (aligns[ci] ? ` class="align-${aligns[ci]}"` : "");
      const rows = [];
      i += 2; // 跳过表头 + 分隔行
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--; // for 循环会 i++,这里回退一格
      let table = '<table class="md-table"><thead><tr>';
      table += header.map((cell, ci) => `<th${alignClass(ci)}>${renderInline(cell)}</th>`).join("");
      table += "</tr></thead><tbody>";
      for (const row of rows) {
        table += "<tr>" + header.map((_, ci) => `<td${alignClass(ci)}>${renderInline(row[ci] || "")}</td>`).join("") + "</tr>";
      }
      table += "</tbody></table>";
      html.push(table);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listItems && listOrdered) flushList();
      if (!listItems) { listItems = []; listOrdered = false; }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[1]);
      if (task) listItems.push({ text: task[2], task: task[1].toLowerCase() === "x" });
      else listItems.push({ text: bullet[1], task: null });
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listItems && !listOrdered) flushList();
      if (!listItems) { listItems = []; listOrdered = true; }
      listItems.push({ text: ordered[1], task: null });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(); flushList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return html.join("");
}

export function mdToHtml(markdown) {
  return splitFencedBlocks(String(markdown ?? ""))
    .map((block) => block.kind === "code"
      ? `<pre data-language="${escapeAttribute(block.lang || "text")}"><code>${escapeHtml(block.lines.join("\n"))}</code></pre>`
      : renderTextBlock(block.lines))
    .join("");
}
