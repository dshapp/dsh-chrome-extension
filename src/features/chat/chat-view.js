// 聊天消息元素构建:DOM 结构对齐原 extension(msg-user-turn/msg-turn 包装、
// msg-actions 操作行、code-block 工具栏、thinking-bubble、结构化错误卡)。
import { mdToHtml, escapeHtml } from "../../shared/md-to-html.js";
import { t } from "../../shared/i18n.js";

// 图标取自 Lucide(https://github.com/lucide-icons/lucide,ISC),保留官方 24×24 网格的原始路径,
// 仅把 stroke-width 从 2 调到 1.7 以适配 1rem 的实际渲染尺寸。
const lucide = (body, className) =>
  `<svg${className ? ` class="${className}"` : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ACTION_ICONS = Object.freeze({
  // lucide: copy
  copy: lucide('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  // lucide: check
  copied: lucide('<path d="M20 6 9 17l-5-5"/>'),
  // lucide: git-fork
  fork: lucide('<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>')
});

// lucide: chevron-down
export const CHEVRON_PATH = '<path d="m6 9 6 6 6-6"/>';
const CHEVRON_SVG = lucide(CHEVRON_PATH, "thinking-chevron dropdown-chevron");

export function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function makeCopyButton(getText) {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "act-btn";
  copy.title = t("copy");
  copy.setAttribute("aria-label", t("copy"));
  copy.innerHTML = ACTION_ICONS.copy;
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(getText() || "").catch(() => {});
    copy.innerHTML = ACTION_ICONS.copied;
    setTimeout(() => { copy.innerHTML = ACTION_ICONS.copy; }, 1200);
  });
  return copy;
}

function makeTimestamp(ts) {
  const el = document.createElement("span");
  el.className = "msg-timestamp";
  el.textContent = fmtTime(ts);
  return el;
}

// 代码块包一层 .code-block:工具栏(语言标签 + 复制按钮)+ pre。
export function decorateCodeBlocks(body) {
  for (const pre of body.querySelectorAll("pre")) {
    const code = pre.querySelector(":scope > code");
    if (!code) continue;
    const block = document.createElement("div");
    block.className = "code-block";
    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";
    const language = document.createElement("span");
    language.className = "code-language";
    language.textContent = pre.dataset.language || t("code");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy-btn";
    copy.textContent = t("copyCode");
    copy.title = t("copyCode");
    copy.setAttribute("aria-label", t("copyCode"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent || "");
        copy.textContent = t("codeCopied");
        setTimeout(() => { copy.textContent = t("copyCode"); }, 1600);
      } catch {
        copy.textContent = t("copyCode");
      }
    });
    toolbar.append(language, copy);
    pre.before(block);
    block.append(toolbar, pre);
  }
}

export function renderMarkdownInto(body, text) {
  body.innerHTML = mdToHtml(text);
  decorateCodeBlocks(body);
}

// ---- user 消息:.msg-user-turn > (.msg-user + .msg-actions.msg-user-actions) ----
export function createUserMessageElement(item) {
  const blocks = item.blocks ?? [];
  const text = blocksToText(blocks);
  const turn = document.createElement("div");
  turn.className = "msg-user-turn";
  const el = document.createElement("div");
  el.className = "msg-user";
  const images = blocks.filter((block) => block.type === "image" && block.data);
  if (images.length) {
    const strip = document.createElement("div");
    strip.className = "msg-imgs";
    for (const image of images) {
      const img = document.createElement("img");
      img.src = `data:${image.mediaType || "image/png"};base64,${image.data}`;
      img.alt = image.name || "";
      strip.appendChild(img);
    }
    el.appendChild(strip);
  }
  if (text) {
    const span = document.createElement("div");
    span.textContent = text;
    el.appendChild(span);
  }
  const actions = document.createElement("div");
  actions.className = "msg-actions msg-user-actions";
  actions.append(makeTimestamp(item.time), makeCopyButton(() => text));
  turn.append(el, actions);
  return turn;
}

// ---- assistant 消息:.msg-turn > (.msg-agent + .msg-actions) ----
export function createAssistantElement(item, { onFork } = {}) {
  const turn = document.createElement("div");
  turn.className = "msg-turn";
  const body = document.createElement("div");
  body.className = "msg-agent";
  renderMarkdownInto(body, item.text);
  turn.appendChild(body);
  turn.appendChild(buildAssistantActions(turn, body, item, { onFork }));
  return turn;
}

function buildAssistantActions(turn, body, item, { onFork } = {}) {
  const row = document.createElement("div");
  row.className = "msg-actions";
  row.append(makeCopyButton(() => body.textContent));
  if (Number.isInteger(item.forkSeq) && onFork) {
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "act-btn";
    fork.title = t("fork");
    fork.setAttribute("aria-label", t("fork"));
    fork.innerHTML = ACTION_ICONS.fork;
    fork.addEventListener("click", () => onFork(item));
    row.appendChild(fork);
  }
  row.appendChild(makeTimestamp(item.time));
  return row;
}

// assistant 条目原地更新:文本重渲 + 操作行按 forkSeq 重建。
export function updateAssistantElement(turn, item, { onFork } = {}) {
  const body = turn.querySelector(".msg-agent");
  renderMarkdownInto(body, item.text);
  turn.querySelector(".msg-actions")?.replaceWith(buildAssistantActions(turn, body, item, { onFork }));
}

// ---- reasoning:.thinking-bubble(可折叠,默认收起) ----
export function createReasoningElement(item) {
  const wrap = document.createElement("div");
  wrap.className = "thinking-bubble";
  wrap.innerHTML = `
    <div class="thinking-header">
      <span class="thinking-icon">✨</span>
      <span class="thinking-title">${escapeHtml(t("thinking"))}</span>
      ${CHEVRON_SVG}
    </div>
    <div class="thinking-body"></div>`;
  wrap.querySelector(".thinking-body").textContent = item.text;
  wrap.querySelector(".thinking-header").addEventListener("click", () => wrap.classList.toggle("expanded"));
  return wrap;
}

export function updateReasoningElement(wrap, item) {
  wrap.querySelector(".thinking-body").textContent = item.text;
}

// ---- todos / error / turn-end ----
export function createTodosElement(item) {
  const element = document.createElement("div");
  element.className = "todos-card";
  const head = document.createElement("div");
  head.className = "todos-head";
  head.textContent = t("todo.title");
  const list = document.createElement("ul");
  element.append(head, list);
  updateTodosElement(element, item);
  return element;
}

export function updateTodosElement(element, item) {
  const list = element.querySelector("ul");
  list.innerHTML = "";
  for (const todo of item.todos ?? []) {
    const li = document.createElement("li");
    li.className = `todo-${todo.status}`;
    const mark = todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "◐" : "☐";
    li.textContent = `${mark} ${todo.content}`;
    list.appendChild(li);
  }
}

export function createErrorElement(item) {
  const el = document.createElement("div");
  el.className = "msg-error";
  el.setAttribute("role", "alert");
  const title = document.createElement("div");
  title.className = "msg-error-title";
  title.textContent = item.message;
  el.appendChild(title);
  if (item.details) {
    const detail = document.createElement("pre");
    detail.className = "msg-error-details";
    detail.textContent = item.details;
    el.appendChild(detail);
  }
  return el;
}

export function createTurnEndElement(item) {
  if (!item.label) return document.createComment("turn-end");
  const element = document.createElement("div");
  element.className = "turn-end-chip";
  element.textContent = item.label;
  return element;
}

export function blocksToText(blocks) {
  return (blocks ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}
