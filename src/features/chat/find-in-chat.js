// 会话内查找(⌘F / Ctrl+F)。
//
// 对齐 Mac 的 transcript 查找:输入即时高亮,Enter/Shift+Enter 在命中间移动,
// Esc 关闭并清除标记。命中用 <mark class="find-hit"> 包住真实文本节点,
// 不复制内容、不改动原始 DOM 结构,关闭时全部还原。
import { t } from "../../shared/i18n.js";

const MAX_HITS = 500;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "MARK"]);

/// 收集 root 下可搜索的文本节点,跳过查找条自身与不可见子树。
function textNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-find-skip]")) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let node = walker.nextNode();
  while (node) { nodes.push(node); node = walker.nextNode(); }
  return nodes;
}

/// 在单个文本节点里把所有命中换成 mark,返回新建的 mark(按文档顺序)。
function markNode(textNode, query) {
  const value = textNode.nodeValue ?? "";
  const haystack = value.toLowerCase();
  const needle = query.toLowerCase();
  const marks = [];
  let cursor = 0;
  let at = haystack.indexOf(needle, cursor);
  if (at < 0) return marks;
  const before = value.slice(0, at);
  const fragment = textNode.ownerDocument.createDocumentFragment();
  if (before) fragment.append(textNode.ownerDocument.createTextNode(before));
  while (at >= 0 && marks.length < MAX_HITS) {
    const mark = textNode.ownerDocument.createElement("mark");
    mark.className = "find-hit";
    mark.textContent = value.slice(at, at + query.length);
    fragment.append(mark);
    marks.push(mark);
    cursor = at + query.length;
    at = haystack.indexOf(needle, cursor);
  }
  const rest = value.slice(cursor);
  if (rest) fragment.append(textNode.ownerDocument.createTextNode(rest));
  textNode.replaceWith(fragment);
  return marks;
}

export function mountFindBar(refs, { getRoot } = {}) {
  let hits = [];
  let current = -1;
  let visible = false;

  function paintCount() {
    if (!refs.count) return;
    if (!refs.input.value) refs.count.textContent = "";
    else if (!hits.length) refs.count.textContent = t("find.noResults");
    else refs.count.textContent = t("find.count", { current: String(current + 1), total: String(hits.length) });
  }

  function focusCurrent() {
    hits.forEach((mark, i) => mark.classList.toggle("current", i === current));
    hits[current]?.scrollIntoView?.({ block: "center" });
    paintCount();
  }

  /// 清掉所有标记并把文本节点还原。
  function detach() {
    for (const mark of hits) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    }
    hits = [];
    current = -1;
  }

  function collect() {
    const root = getRoot?.();
    const query = refs.input.value;
    if (!root || !query) { paintCount(); return; }
    const marks = [];
    for (const node of textNodes(root)) {
      for (const mark of markNode(node, query)) {
        marks.push(mark);
        if (marks.length >= MAX_HITS) break;
      }
      if (marks.length >= MAX_HITS) break;
    }
    hits = marks;
    current = hits.length ? 0 : -1;
    if (current >= 0) focusCurrent(); else paintCount();
  }

  function refresh() { detach(); collect(); }

  function move(step) {
    if (!hits.length) return;
    current = (current + step + hits.length) % hits.length;
    focusCurrent();
  }

  function open() {
    visible = true;
    if (refs.bar) refs.bar.hidden = false;
    refs.input.focus();
    refs.input.select();
    refresh();
  }

  function close() {
    visible = false;
    if (refs.bar) refs.bar.hidden = true;
    detach();
    refs.input.value = "";
    paintCount();
  }

  refs.input?.addEventListener("input", refresh);
  refs.input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  refs.next?.addEventListener("click", () => move(1));
  refs.prev?.addEventListener("click", () => move(-1));
  refs.close?.addEventListener("click", close);

  return Object.freeze({
    open,
    close,
    toggle() { if (visible) close(); else open(); },
    isOpen: () => visible,
    refresh,
    detach
  });
}
