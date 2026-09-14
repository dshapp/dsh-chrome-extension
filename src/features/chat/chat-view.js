// 聊天消息元素构建:DOM 结构对齐原 extension(msg-user-turn/msg-turn 包装、
// msg-actions 操作行、code-block 工具栏、thinking-bubble、结构化错误卡)。
import { mdToHtml, escapeHtml } from "../../shared/md-to-html.js";
import { t } from "../../shared/i18n.js";
import { highlightCodeBlocks } from "./code-highlight.js";
import { attachCopyFeedback } from "./copy-feedback.js";
import { ensureKatex, isKatexReady } from "./katex-loader.js";
import { lucideIcon, lucideIconSvg } from "./file-icons.js";

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
  copy.innerHTML = lucideIconSvg("copy", { size: 14 });
  attachCopyFeedback(copy, getText, {
    render: (done) => { copy.innerHTML = lucideIconSvg(done ? "check" : "copy", { size: 14 }); }
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
    // 已包过工具栏的跳过:增量渲染里冻结前缀会被反复走这一趟。
    if (pre.parentElement?.classList.contains("code-block")) continue;
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
    copy.innerHTML = lucideIconSvg("copy", { size: 12 });
    copy.title = t("copyCode");
    copy.setAttribute("aria-label", t("copyCode"));
    // 与消息复制按钮同一套反馈语义:成功才切图标、1000ms、窗口内不重复写。
    attachCopyFeedback(copy, () => code.textContent || "", {
      render: (done) => { copy.innerHTML = lucideIconSvg(done ? "check" : "copy", { size: 12 }); },
      labels: { done: t("codeCopied"), idle: t("copyCode") }
    });
    toolbar.append(language, copy);
    pre.before(block);
    block.append(toolbar, pre);
  }
}

/// 正文里是否出现了公式定界符。粗判即可 —— 目的只是决定"要不要去拉 KaTeX",
/// 真正的判定在 splitMathSegments 里。宁可多拉一次(一次性的),
/// 也不要因为漏判而让公式永远渲染不出来。
export function mayContainMath(text) {
  return typeof text === "string" && text.includes("$");
}

/**
 * 把 markdown 正文渲染进容器,并补上代码着色与公式。
 *
 * KaTeX 与 hljs 都是按需异步加载的,所以这里分两步:先同步渲染一版
 *(此时公式降级成原文、代码块无色),资源到位后再重绘一次。对已经加载过的
 * 情况没有额外开销 —— isKatexReady() 为真时不会有第二次渲染。
 *
 * @param {Element} body 目标容器。
 * @param {string} text markdown 源码。
 * @param {{streaming?: boolean}} options 流式进行中时跳过最后一个代码块的着色。
 */
export function renderMarkdownInto(body, text, { streaming = false } = {}) {
  body.innerHTML = mdToHtml(text);
  decorateCodeBlocks(body);
  void highlightCodeBlocks(body, { streaming });

  // 公式:首次遇到时才拉 KaTeX,拉到后重绘这一条。
  if (mayContainMath(text) && !isKatexReady()) {
    void ensureKatex().then((ready) => {
      // 加载期间这条消息可能已被新内容替换或移出文档 —— 那就不必重绘了。
      if (!ready || !body.isConnected) return;
      body.innerHTML = mdToHtml(text);
      decorateCodeBlocks(body);
      void highlightCodeBlocks(body, { streaming });
    });
  }
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
    fork.innerHTML = lucideIconSvg("git-fork", { size: 14 });
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
      <span class="thinking-icon">${lucideIconSvg("brain", { size: 13 })}</span>
      <span class="thinking-title">${escapeHtml(t("thinking"))}</span>
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
    // lucide: circle-check / circle-dot / circle
    const icon = todo.status === "completed" ? "circle-check"
      : todo.status === "in_progress" ? "circle-dot" : "circle";
    li.append(lucideIcon(icon, { size: 13 }), document.createTextNode(` ${todo.content}`));
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
