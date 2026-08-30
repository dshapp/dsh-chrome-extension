// 最小 Markdown → HTML 渲染:先整体转义再套标签,输出可安全 innerHTML。
// 支持:标题、 fenced code、行内 code、粗体/斜体、链接、无序/有序列表、引用、表格、段落。
import { autoLinkUrls } from "./auto-link.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // 裸 URL 兜底:必须放在最后,此时 <code> 与显式链接都已成标签,可被安全跳过。
  out = autoLinkUrls(out);
  return out;
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
    const fenceMatch = /^\s*```(\S*)\s*$/.exec(line);
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
      html.push(`<${tag}>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
      listItems = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      html.push(`<h${level + 2}>${renderInline(heading[2])}</h${level + 2}>`); // h3-h6,避免覆盖侧栏标题
      continue;
    }
    // 表格:当前行含 |,且下一行是分隔行(|---|---|)。
    if (line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      flushParagraph(); flushList();
      const header = splitTableRow(line);
      const rows = [];
      i += 2; // 跳过表头 + 分隔行
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--; // for 循环会 i++,这里回退一格
      let table = '<table class="md-table"><thead><tr>';
      table += header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
      table += "</tr></thead><tbody>";
      for (const row of rows) {
        table += "<tr>" + header.map((_, ci) => `<td>${renderInline(row[ci] || "")}</td>`).join("") + "</tr>";
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
      listItems.push(bullet[1]);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listItems && !listOrdered) flushList();
      if (!listItems) { listItems = []; listOrdered = true; }
      listItems.push(ordered[1]);
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
