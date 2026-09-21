// 用户消息内容投影。
//
// 对齐 web ui-chat MessageItem.contentParts + ui-primitives projectUserText:
// - image/file 块抽成附件行(file 卡显示文件名 + 扩展名/大小);
// - 文本走引用 chip 投影(wire 会话引用、@label、@路径、/skill);
// - 其余块保留原文,交给渲染层当 JSON 入口。
import { t } from "../../shared/i18n.js";
import { lucideIcon } from "./file-icons.js";

/// web contentParts:文本拼接(不加分隔符),附件与其余块分开。
export function splitUserContent(content) {
  const texts = [];
  const images = [];
  const files = [];
  const rest = [];
  for (const block of content ?? []) {
    if (!block || typeof block !== "object") { rest.push(block); continue; }
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "image" && (block.data || block.attachment)) {
      const attachment = block.attachment ?? {};
      // 历史消息里的图片只有 attachmentId(content-addressed),字节要按需读回;
      // 草稿/乐观消息才内联 data。
      images.push({
        data: attachment.data ?? block.data,
        mediaType: attachment.mediaType ?? block.mediaType,
        name: attachment.name ?? block.name,
        attachmentId: attachment.attachmentId ?? block.attachmentId ?? null
      });
    } else if (block.type === "file" && (block.attachment || block.name)) {
      const attachment = block.attachment ?? {};
      files.push({
        name: attachment.name ?? block.name ?? "",
        bytes: attachment.bytes ?? block.bytes ?? null,
        attachmentId: attachment.attachmentId ?? block.receiptId ?? null
      });
    } else {
      rest.push(block);
    }
  }
  return { text: texts.join(""), images, files, rest };
}

export function fileExtension(name) {
  const base = String(name ?? "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/// web fileSizeText:KB/MB,未知返回空串。
export function fileSizeText(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SESSION_WIRE_RE = /@\[([^\]\n]+)\]\((dsh-session:[^)\s]+)\)/gu;
const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？]+$/u;
const TOKEN_RE = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu;

/// wire 引用里的会话 id:`dsh-session:` 之后是「会话 id 的 JSON 字符串」的 base64url。
function wireSessionId(uri) {
  try {
    const raw = String(uri).slice("dsh-session:".length).replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const id = JSON.parse(new TextDecoder().decode(bytes));
    return typeof id === "string" && id ? id : null;
  } catch { return null; }
}

// 语义对齐 web/mac 的引用胶囊图标(session/folder/file/skill)。
const CHIP_ICONS = { session: "link", file: "file", folder: "folder", skill: "sparkles" };

function chip(kind, display, title, onOpen) {
  const tag = onOpen ? "button" : "span";
  const node = document.createElement(tag);
  node.className = "ref-chip";
  node.dataset.refChip = kind;
  node.title = title;
  const icon = document.createElement("span");
  icon.className = "ref-chip-icon";
  icon.append(lucideIcon(CHIP_ICONS[kind] ?? "file", { size: 12 }));
  node.append(icon, document.createTextNode(display));
  if (onOpen) {
    node.type = "button";
    node.addEventListener("click", (event) => {
      // 双击、或存在非折叠选区时保留原生选择行为。
      const selection = node.ownerDocument?.getSelection?.();
      if (event.detail > 1 || (event.detail !== 0 && selection && selection.isCollapsed === false)) return;
      onOpen();
    });
  }
  return node;
}

/// web projectUserText 的 vanilla 版:返回 DocumentFragment。
/// @param {string} text 已发送正文。
/// @param {{sessionRefs?: {label: string, sessionId: string|null}[], slashNames?: string[], onOpenFile?: Function, onOpenSkill?: Function, onOpenSession?: Function}} refs
export function projectUserText(text, refs = {}) {
  const source = String(text ?? "");
  const sessionRefs = refs.sessionRefs ?? [];
  const slashNames = refs.slashNames ?? [];
  const ranges = [];

  SESSION_WIRE_RE.lastIndex = 0;
  let wire;
  while ((wire = SESSION_WIRE_RE.exec(source)) !== null) {
    ranges.push({ start: wire.index, end: wire.index + wire[0].length, label: wire[0], kind: "session", display: wire[1], sessionId: wireSessionId(wire[2]) });
  }
  // 长的先排:一个标题可能是另一个的前缀,发送者选中的是更长的那个。
  for (const ref of [...sessionRefs].sort((a, b) => b.label.length - a.label.length)) {
    const label = `@${ref.label}`;
    let start = source.indexOf(label);
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: "session", sessionId: ref.sessionId });
      start = source.indexOf(label, start + label.length);
    }
  }
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(source)) !== null) {
    const tokenStart = match.index + match[1].length;
    const rawLabel = match[2];
    const label = rawLabel.startsWith('@"') ? rawLabel : rawLabel.replace(TRAILING_PUNCTUATION_RE, "");
    if (label.length <= 1) continue;
    if (label.startsWith("/") && !slashNames.includes(label.slice(1))) continue;
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: "plain" });
  }

  const rank = (range) => (range.kind === "session" ? 0 : 1);
  ranges.sort((a, b) => a.start - b.start || rank(a) - rank(b) || b.end - a.end);

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) fragment.append(document.createTextNode(source.slice(cursor, range.start)));
    const { start, end, label, kind } = range;
    if (kind === "session") {
      const openSession = refs.onOpenSession && range.sessionId
        ? () => refs.onOpenSession(range.sessionId)
        : null;
      fragment.append(chip("session", range.display ?? label.slice(1), label, openSession));
    } else if (label.startsWith("@")) {
      const path = label.slice(1).replace(/^"|"$/gu, "");
      const isFolder = path.endsWith("/");
      const display = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
      fragment.append(chip(isFolder ? "folder" : "file", display, label,
        refs.onOpenFile ? () => refs.onOpenFile(path) : null));
    } else {
      fragment.append(chip("skill", label, label,
        refs.onOpenSkill ? () => refs.onOpenSkill(label.slice(1)) : null));
    }
    cursor = end;
  }
  if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)));
  return fragment;
}

/// 会话引用摘要(web referenceSummary)。
export function referenceSummary(labels) {
  const values = (labels ?? []).filter(Boolean);
  if (!values.length) return null;
  const node = document.createElement("div");
  node.className = "msg-reference-summary";
  node.textContent = t("message.referenceSummary", { labels: values.join(t("message.referenceSeparator")) });
  return node;
}
