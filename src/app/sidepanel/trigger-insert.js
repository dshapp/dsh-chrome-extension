// 候选选中后对输入框做的三种改写。从 trigger-menu 拆出来:那边负责
// "检测触发 → 渲染 → 分派",这里只负责"把文本/胶囊落进 textarea"。
//
// 三者都要自己管焦点与光标 —— 菜单是用 mousedown 选中的,textarea 此刻还没失焦,
// 但插完之后光标位置必须由我们显式摆好,否则会跳到末尾。
import { insertReference } from "./composer-chips.js";
import { applyPick } from "./composer-triggers.js";

/// 把触发词那一段从草稿里抹掉(固定行没有文本要插,但 "@" 已经打出去了)。
/// ＋ 按钮的合成 hit 是空 span,这里等价于空操作。
export function dropTriggerText(input, hit) {
  if (!hit) return;
  const { text, caret } = applyPick(input.value, hit, { value: "", insertsPlainText: true });
  input.value = text;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/// 插一枚胶囊,替换掉触发词那一段。
export function insertChip(input, hit, occurrences, { label, text }, onInsertReference) {
  const next = insertReference(input.value, occurrences, hit.span, { label, text });
  input.value = next.text;
  onInsertReference?.(next);
  input.focus();
  input.setSelectionRange(next.caret, next.caret);
  // 不派发 input 事件:胶囊状态已由 onInsertReference 同步好,
  // 再走一遍 syncChips 会用旧 lastDraft 去 diff,把刚插入的胶囊判成孤儿。
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/// 插裸文本(目录下钻)。返回 keepOpen —— 为真时调用方不要关菜单,
/// 上面派发的 input 事件会重新检测触发并降一级。
export function insertPlain(input, hit, candidate) {
  const { text, caret, keepOpen } = applyPick(input.value, hit, candidate);
  input.value = text;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return keepOpen;
}
