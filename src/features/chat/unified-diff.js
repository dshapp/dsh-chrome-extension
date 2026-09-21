// 宿主给出的统一 diff(workspace-changes 的 hunks)的渲染,对齐 mac UnifiedDiffView。
//
// 与"两份全文自己重新 diff"不同:这里宿主已经算好了上下文行与 hunk 边界,
// 每一行都带着自己的 `+` / `-` / 空格前缀,原样画出来即可。
import { t } from "../../shared/i18n.js";

/// 单次展开最多画的行数。宿主的单文件上限是 MB 级,整文件替换(coarse)时
/// 行数可以是几万 —— 侧栏是个窄面板,真把几万个 div 建出来会直接卡死滚动。
/// 超出部分给一行说明,而不是悄悄截断。
export const MAX_DIFF_LINES = 2000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function hunkHeading(hunk) {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/// 一行的种类。宿主保证每行带前缀,空行(`""`)按上下文处理。
function lineKind(line) {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/// hunks → DOM。行号沿用宿主给的 hunk 起点自行递推,让读者知道改在文件的哪儿。
export function buildUnifiedDiff(hunks) {
  const wrap = el("div", "diff-view");
  let drawn = 0;
  let truncated = false;
  for (const hunk of hunks ?? []) {
    if (truncated) break;
    wrap.append(el("div", "diff-hunk", hunkHeading(hunk)));
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines ?? []) {
      if (drawn >= MAX_DIFF_LINES) { truncated = true; break; }
      drawn += 1;
      const kind = lineKind(line);
      const row = el("div", `diff-line diff-${kind}`);
      row.append(el("span", "diff-gutter", kind === "add" ? "" : String(oldLine)));
      row.append(el("span", "diff-gutter", kind === "del" ? "" : String(newLine)));
      row.append(el("span", "diff-sign", kind === "add" ? "+" : kind === "del" ? "-" : " "));
      row.append(el("span", "diff-text", line.slice(1)));
      if (kind !== "add") oldLine += 1;
      if (kind !== "del") newLine += 1;
      wrap.append(row);
    }
  }
  if (truncated) wrap.append(el("div", "diff-note", t("changes.truncated", { n: String(MAX_DIFF_LINES) })));
  return wrap;
}

/// 复制用的纯文本形态(与屏幕上看到的一致:hunk 头 + 带前缀的行)。
export function unifiedDiffText(hunks) {
  const out = [];
  for (const hunk of hunks ?? []) {
    out.push(hunkHeading(hunk));
    for (const line of hunk.lines ?? []) out.push(line);
  }
  return out.join("\n");
}
