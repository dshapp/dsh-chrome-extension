// composer 引用胶囊层。对齐 macos/.../State/ComposerReferenceMachine.swift +
// Components/Composer/ComposerTextView.swift 的 drawReferenceChips()。
//
// textarea 画不了行内元素,所以走 Mac 的同一套模型:
//   draft 里存一个 U+FFFC 占位符(**一个字符**),真正的引用文本存在 occurrences 里;
//   一层与 textarea 像素对齐的镜像 div 负责把占位符画成胶囊;
//   发送前 project() 把占位符展开回完整文本。
// 这样光标移动/退格/选区都按"一个字符"走,与 Mac 的手感一致。

export const PLACEHOLDER = "\uFFFC";

let nextOccurrenceId = 1;

/// 把带占位符的草稿展开成真正要发送的文本。
/// 没有 occurrence 认领的占位符是孤儿(粘贴进来的裸 U+FFFC),直接抹掉。
export function projectDraft(draft, occurrences) {
  if (!occurrences.length) return draft.split(PLACEHOLDER).join("");
  const byOffset = new Map(occurrences.map((o) => [o.offset, o]));
  let out = "";
  for (let i = 0; i < draft.length; i += 1) {
    const ch = draft[i];
    if (ch !== PLACEHOLDER) { out += ch; continue; }
    const occurrence = byOffset.get(i);
    if (occurrence) out += occurrence.text;
  }
  return out;
}

/// 编辑前后的最小差异区间(Mac diff():掐掉公共前缀/后缀)。
export function diffRange(oldText, newText) {
  let prefix = 0;
  const min = Math.min(oldText.length, newText.length);
  while (prefix < min && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < min - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix += 1;
  }
  return { start: prefix, end: oldText.length - suffix, insertedLength: newText.length - prefix - suffix };
}

/// 按编辑区间搬移 occurrences(Mac reconcile()):
/// 区间之前的不动,之后的整体位移,**落在区间内的被删掉**(它的占位符没了)。
export function shiftByEdit(occurrences, range) {
  const delta = range.insertedLength - (range.end - range.start);
  return occurrences.map((occurrence) => {
    if (occurrence.offset < range.start) return occurrence;
    if (occurrence.offset >= range.end) return { ...occurrence, offset: occurrence.offset + delta };
    return null;
  }).filter(Boolean);
}

/// 只保留仍然压在真占位符上的 occurrence,且一个位置只许一个认领
/// (Mac retainPlacedOccurrences():稳定顺序 → 先铸造的先认领)。
export function retainPlaced(draft, occurrences) {
  const claimed = new Set();
  return occurrences.filter((occurrence) => {
    const offset = occurrence.offset;
    if (!(offset >= 0 && offset < draft.length && draft[offset] === PLACEHOLDER)) return false;
    if (claimed.has(offset)) return false;
    claimed.add(offset);
    return true;
  });
}

/// 草稿变化时的总入口:diff → 位移 → 校验。
export function reconcileEdit(oldDraft, newDraft, occurrences) {
  const shifted = shiftByEdit(occurrences, diffRange(oldDraft, newDraft));
  return retainPlaced(newDraft, shifted);
}

/// 在光标处插入一个引用胶囊,返回新的 { text, caret, occurrences }。
export function insertReference(draft, occurrences, span, reference) {
  const before = draft.slice(0, span.start);
  const after = draft.slice(span.end);
  // 胶囊后补一个空格,和 Mac 一样让用户可以直接接着打字。
  const text = `${before}${PLACEHOLDER} ${after}`;
  const minted = {
    occurrenceId: nextOccurrenceId++,
    label: reference.label,
    text: reference.text,
    invalid: false,
    offset: before.length
  };
  // 这次插入本身就是一次编辑:用同一套 diff/位移规则把旧胶囊搬到新位置,
  // 再把新铸造的这枚放进去,最后统一校验(孤儿/错位一律丢弃)。
  const shifted = shiftByEdit(occurrences, {
    start: span.start, end: span.end, insertedLength: 2
  });
  const merged = [...shifted, minted].sort((a, b) => a.offset - b.offset);
  return { text, caret: before.length + 2, occurrences: retainPlaced(text, merged) };
}

/// 镜像层:把草稿逐段渲染,占位符渲染成胶囊 <span>。
/// 只负责画,不接收事件(pointer-events 交给上层 textarea)。
export function renderChipMirror(mirror, draft, occurrences) {
  // 无占位符快速路径:没有胶囊要画,只保留一个零宽字符占住行高,
  // 跳过全文遍历与逐字符切分(长草稿打字的主要热点之一)。
  if (occurrences.length === 0 && draft.indexOf(PLACEHOLDER) === -1) {
    mirror.replaceChildren(document.createTextNode("\u200b"));
    return;
  }
  mirror.replaceChildren();
  const byOffset = new Map(occurrences.map((o) => [o.offset, o]));
  let cursor = 0;
  for (let i = 0; i < draft.length; i += 1) {
    if (draft[i] !== PLACEHOLDER) continue;
    if (i > cursor) mirror.append(document.createTextNode(draft.slice(cursor, i)));
    const occurrence = byOffset.get(i);
    const chip = document.createElement("span");
    chip.className = occurrence?.invalid ? "composer-chip invalid" : "composer-chip";
    // 孤儿占位符没有标签,渲染成空胶囊会是个怪盒子 —— 干脆不画。
    if (!occurrence) { cursor = i + 1; continue; }
    chip.textContent = occurrence.label;
    mirror.append(chip);
    cursor = i + 1;
  }
  if (cursor < draft.length) mirror.append(document.createTextNode(draft.slice(cursor)));
  // 末尾换行不产生行盒,补一个零宽字符让镜像高度跟 textarea 一致。
  mirror.append(document.createTextNode("\u200b"));
}