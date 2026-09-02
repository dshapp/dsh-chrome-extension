// composer 引用胶囊层。
//
// 胶囊标签是**真实文本**,在 textarea 里占据真实宽度。
// 旧方案对齐 Mac(草稿存一个 U+FFFC 附件字符,镜像层画成胶囊)在 web 行不通:
// Mac 的 NSTextAttachment 能给单个字符任意可视宽度,textarea 做不到 ——
// 镜像画出的胶囊比那个字符宽,光标与胶囊后的所有文字全部错位、光标被胶囊盖住。
//
// 现方案:草稿里存 "\u00A0label\u00A0" 一段真实字符(NBSP 兼作视觉留白),
// 镜像层给这段字符画底色圆角 —— 不加 padding、不改字重,两层宽度分毫不差,
// 光标像走普通文字一样落在胶囊右侧;完整引用文本仍存在 occurrences 里,
// 发送前 projectDraft() 把这段字符展开回完整文本。
//
// 编辑语义:胶囊是原子的 —— 任何触碰(退格、选区删除、在中间打字)都让整个
// 胶囊失效,残余的标签字符由 reconcileDraft() 从草稿一并剔除,不留会被当成
// 正文发出去的碎片。

/// 胶囊两侧的留白字符(NBSP):真实占宽,镜像层的底色盖住它就是胶囊的内边距。
export const CHIP_PAD = "\u00A0";

/// 一枚胶囊在草稿里的完整字符段。
export function chipRun(label) {
  return `${CHIP_PAD}${label}${CHIP_PAD}`;
}

let nextOccurrenceId = 1;

/// 把草稿展开成真正要发送的文本:每段胶囊字符替换为完整引用文本。
export function projectDraft(draft, occurrences) {
  if (!occurrences.length) return draft;
  const sorted = [...occurrences].sort((a, b) => a.offset - b.offset);
  let out = "";
  let cursor = 0;
  for (const occurrence of sorted) {
    out += draft.slice(cursor, occurrence.offset) + occurrence.text;
    cursor = occurrence.offset + occurrence.length;
  }
  return out + draft.slice(cursor);
}

/// 编辑前后的最小差异区间(掐掉公共前缀/后缀)。
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

/// 按编辑区间搬移 occurrences:区间之前的不动,之后的整体位移,
/// 与区间相交的被删掉(胶囊被触碰即失效;残余字符的剔除见 reconcileDraft)。
export function shiftByEdit(occurrences, range) {
  const delta = range.insertedLength - (range.end - range.start);
  return occurrences.map((occurrence) => {
    if (occurrence.offset + occurrence.length <= range.start) return occurrence;
    if (occurrence.offset >= range.end) return { ...occurrence, offset: occurrence.offset + delta };
    return null;
  }).filter(Boolean);
}

/// 只保留字符段仍与标签完全一致的 occurrence,且区间不许重叠
/// (稳定顺序:offset 靠前的先认领)。
export function retainPlaced(draft, occurrences) {
  const sorted = [...occurrences].sort((a, b) => a.offset - b.offset);
  const kept = [];
  let prevEnd = 0;
  for (const occurrence of sorted) {
    if (occurrence.offset < prevEnd) continue;
    if (draft.slice(occurrence.offset, occurrence.offset + occurrence.length) !== chipRun(occurrence.label)) continue;
    kept.push(occurrence);
    prevEnd = occurrence.offset + occurrence.length;
  }
  return kept;
}

/// 轻量入口:只搬移与丢弃,不改草稿文本。IME 组合期间用它 ——
/// 组合中写回 textarea.value 会打断输入法;此路径下被触碰胶囊的残余字符
/// 会退化为普通文字留在草稿里(罕见且可见,用户看到什么就发送什么)。
export function reconcileEdit(oldDraft, newDraft, occurrences) {
  return retainPlaced(newDraft, shiftByEdit(occurrences, diffRange(oldDraft, newDraft)));
}

function mergeCuts(cuts) {
  cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else merged.push({ ...cut });
  }
  return merged;
}

/// 草稿变化的总入口:搬移、丢弃,并把被触碰胶囊的**残余字符**从草稿里剔除。
/// 返回 { text, caret, occurrences } —— text 与传入的 newDraft 不同时,
/// 调用方必须把 text 写回 textarea 并把光标摆到 caret。
export function reconcileDraft(oldDraft, newDraft, occurrences, caret) {
  if (!occurrences.length) return { text: newDraft, caret, occurrences: [] };
  const range = diffRange(oldDraft, newDraft);
  const delta = range.insertedLength - (range.end - range.start);
  const insertEnd = range.start + range.insertedLength;
  const kept = [];
  const cuts = [];
  for (const occurrence of occurrences) {
    if (occurrence.offset + occurrence.length <= range.start) { kept.push(occurrence); continue; }
    if (occurrence.offset >= range.end) { kept.push({ ...occurrence, offset: occurrence.offset + delta }); continue; }
    // 被编辑触碰:整枚失效。残余字符在新文本里最多两段 ——
    // 编辑区间之前的头部,和编辑区间(含新插入文本)之后的尾部。
    if (occurrence.offset < range.start) cuts.push({ start: occurrence.offset, end: range.start });
    const tailEnd = occurrence.offset + occurrence.length + delta;
    if (tailEnd > insertEnd) cuts.push({ start: insertEnd, end: tailEnd });
  }
  if (!cuts.length) return { text: newDraft, caret, occurrences: retainPlaced(newDraft, kept) };
  const merged = mergeCuts(cuts);
  let text = "";
  let cursor = 0;
  let caretShift = 0;
  for (const cut of merged) {
    text += newDraft.slice(cursor, cut.start);
    if (caret > cut.start) caretShift += Math.min(cut.end, caret) - cut.start;
    cursor = cut.end;
  }
  text += newDraft.slice(cursor);
  const adjusted = kept.map((occurrence) => {
    let removed = 0;
    for (const cut of merged) if (cut.end <= occurrence.offset) removed += cut.end - cut.start;
    return { ...occurrence, offset: occurrence.offset - removed };
  });
  const nextCaret = Math.max(0, Math.min(caret - caretShift, text.length));
  return { text, caret: nextCaret, occurrences: retainPlaced(text, adjusted) };
}

/// 在光标处插入一枚引用胶囊,返回新的 { text, caret, occurrences }。
export function insertReference(draft, occurrences, span, reference) {
  const run = chipRun(reference.label);
  const before = draft.slice(0, span.start);
  const after = draft.slice(span.end);
  // 胶囊后补一个空格,和 Mac 一样让用户可以直接接着打字。
  const text = `${before}${run} ${after}`;
  const minted = {
    occurrenceId: nextOccurrenceId++,
    label: reference.label,
    text: reference.text,
    invalid: false,
    offset: span.start,
    length: run.length
  };
  const shifted = shiftByEdit(occurrences, {
    start: span.start, end: span.end, insertedLength: run.length + 1
  });
  const merged = [...shifted, minted].sort((a, b) => a.offset - b.offset);
  return { text, caret: span.start + run.length + 1, occurrences: retainPlaced(text, merged) };
}

/// 镜像层:正文逐段渲染,胶囊字符段包进带底色的 <span>。
/// 关键:span 的内容就是草稿里那段字符(含两侧 NBSP),不加任何会改宽度的样式。
export function renderChipMirror(mirror, draft, occurrences) {
  // 无胶囊快速路径:正文整段塞进一个文本节点(长草稿打字的主要热点之一)。
  // 末尾补零宽字符,避免尾部换行不产生行盒导致镜像比 textarea 矮。
  if (occurrences.length === 0) {
    mirror.replaceChildren(document.createTextNode(draft + "\u200b"));
    return;
  }
  mirror.replaceChildren();
  const sorted = [...occurrences].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const occurrence of sorted) {
    if (occurrence.offset > cursor) mirror.append(document.createTextNode(draft.slice(cursor, occurrence.offset)));
    const chip = document.createElement("span");
    chip.className = occurrence.invalid ? "composer-chip invalid" : "composer-chip";
    chip.textContent = draft.slice(occurrence.offset, occurrence.offset + occurrence.length);
    mirror.append(chip);
    cursor = occurrence.offset + occurrence.length;
  }
  if (cursor < draft.length) mirror.append(document.createTextNode(draft.slice(cursor)));
  mirror.append(document.createTextNode("\u200b"));
}
