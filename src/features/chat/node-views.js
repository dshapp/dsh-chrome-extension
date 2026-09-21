// 各类节点的行渲染。对齐 Mac 的 MessageItems / ToolRow / TrajectoryView 的信息密度,
// 但沿用本插件既有的 CSS 语言(tool-row / msg-* / chip)。
//
// 每个 create* 返回一个 DOM 节点;每个 update* 就地更新同一节点。
// renderer 靠 nodeId 决定复用还是重建。
import { t } from "../../shared/i18n.js";
import { mdToHtml, escapeHtml, readFence, isClosingFence } from "../../shared/md-to-html.js";
import { NodeKind, AssistantStatus, ToolRowState } from "../sessions/chat-nodes.js";
import { toolRowModel, resultText, hasResultText, ToolVariant } from "./tool-row-model.js";
import { resolveMention, deliverablesBasename } from "../sessions/turn-deliverables.js";
import { getToolIconSvg, getToolPresentation } from "./tool-presentation.js";
import { decorateCodeBlocks, fmtTime } from "./chat-view.js";
import { renderIncrementalMarkdown } from "./incremental-markdown.js";
import { openCardDetail } from "./card-detail.js";
import { splitUserContent, projectUserText, referenceSummary, fileExtension, fileSizeText } from "./user-content.js";
import { parseXMLMessageCards } from "./user-xml-cards.js";
import { createUserXmlCards } from "./user-xml-cards-view.js";
import { attachCopyFeedback } from "./copy-feedback.js";
import { foldMessageText, chunkText } from "./long-message.js";
import { lucideIcon, fileTypeIconName, linkIconName, fileTypeKind } from "./file-icons.js";
import { buildUnifiedDiff, unifiedDiffText } from "./unified-diff.js";

/// assistant 正文的折叠阈值。比用户消息的 1000 宽松得多:模型回答本来就长,
/// 过早折叠会破坏正常阅读。这里要挡的是"打印整个文件"那一类,所以取一个
/// 正常回答几乎碰不到、但能让每帧 markdown 解析量封顶的值。
const AGENT_FOLD_LIMIT = 20000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/// 历史图片按 attachmentId 惰性读回(content-addressed,块里没有字节)。
/// 同一 id 只读一次;读回前留 loading 占位,失败标 failed(绝不写 ...base64,undefined)。
///
/// 缓存必须有上限:entry.url 是整张图的 `data:` base64,模块级 Map 无上限累积
/// 等于把这段会话里渲染过的每一张图都钉死在内存里(长会话 + 多截图时是实打实的
/// 增长,而且永不释放)。超出上限时从最旧的**已结算**条目开始淘汰;淘汰掉的再次
/// 需要时重读即可,readAttachment 本来就是幂等的读路径。在途条目跳过,免得把同一
/// 张图读两遍。
const ATTACHMENT_IMAGE_CACHE_MAX = 32;
/// 插入顺序即最近使用顺序(Map 按插入序迭代),命中时移到队尾。
const attachmentImageCache = new Map();

function markAttachmentImageUsed(id, entry) {
  attachmentImageCache.delete(id);
  attachmentImageCache.set(id, entry);
}

function trimAttachmentImageCache() {
  while (attachmentImageCache.size > ATTACHMENT_IMAGE_CACHE_MAX) {
    let victim = null;
    for (const [key, value] of attachmentImageCache) {
      // 只淘汰已结算的:在途条目被删掉会让同一张图被读第二遍。
      if (value.url) { victim = key; break; }
    }
    if (victim === null) return; // 全在途:宁可短暂超界,也不重复读
    attachmentImageCache.delete(victim);
  }
}

/// 仅供测试观察缓存是否真的被裁剪。上限见 ATTACHMENT_IMAGE_CACHE_LIMIT。
export function attachmentImageCacheSize() { return attachmentImageCache.size; }
export const ATTACHMENT_IMAGE_CACHE_LIMIT = ATTACHMENT_IMAGE_CACHE_MAX;

function applyImageSource(img, source, context = {}) {
  const a = source ?? {};
  const mediaType = a.mediaType || "image/png";
  if (typeof a.data === "string" && a.data) {
    img.src = `data:${mediaType};base64,${a.data}`;
    img.classList.remove("img-loading", "img-failed");
    return;
  }
  const id = a.attachmentId ?? a.attachment?.attachmentId;
  if (!id || typeof context.readAttachment !== "function") {
    img.classList.add("img-failed");
    return;
  }
  const cached = attachmentImageCache.get(id);
  if (cached?.url) {
    markAttachmentImageUsed(id, cached); // 命中刷到队尾,让 LRU 顺序反映真实使用
    img.src = cached.url;
    img.classList.remove("img-loading", "img-failed");
    return;
  }
  img.classList.add("img-loading");
  let entry = cached;
  if (!entry) {
    entry = { url: null, pending: null };
    attachmentImageCache.set(id, entry);
    trimAttachmentImageCache();
  }
  if (!entry.pending) {
    entry.pending = Promise.resolve(context.readAttachment(id)).then((value) => {
      const bytes = typeof value === "string" ? value : value?.data;
      const type = value?.attachment?.mediaType || mediaType;
      if (typeof bytes !== "string" || !bytes) throw new Error("empty attachment");
      const url = `data:${type};base64,${bytes}`;
      entry.url = url;
      markAttachmentImageUsed(id, entry);
      trimAttachmentImageCache();
      return url;
    }).catch(() => { attachmentImageCache.delete(id); return null; });
  }
  void entry.pending.then((url) => {
    img.classList.remove("img-loading");
    if (url) img.src = url; else img.classList.add("img-failed");
  });
}

// ---------- user / steering / context ----------

function makeCopyButton(getText) {
  const copy = el("button", "act-btn");
  copy.type = "button";
  copy.title = t("copy");
  copy.setAttribute("aria-label", t("copy"));
  const paint = (done) => copy.replaceChildren(lucideIcon(done ? "check" : "copy", { size: 14 }));
  paint(false);
  attachCopyFeedback(copy, getText, { render: paint });
  return copy;
}

/// 把全文按分片逐帧塞进容器。一次性 append 百万字符会让浏览器在单个文本
/// 节点上做同步换行计算,主线程直接卡住;分帧后首屏立刻可读,余下逐步补齐。
/// 返回一个 cancel 函数,弹窗关闭时停掉还没跑完的排程。
function appendChunked(target, chunks) {
  let index = 0;
  let handle = null;
  const schedule = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);
  const cancel = typeof cancelAnimationFrame === "function" && typeof requestAnimationFrame === "function"
    ? cancelAnimationFrame
    : clearTimeout;

  function step() {
    handle = null;
    if (index >= chunks.length) return;
    // 每帧一片:片大小已按 CHUNK_SIZE 控制,单帧布局成本可预期。
    target.append(document.createTextNode(chunks[index]));
    index += 1;
    if (index < chunks.length) handle = schedule(step);
  }

  // 首片同步塞入,保证弹窗一打开就有内容,不闪空白。
  if (chunks.length) {
    target.append(document.createTextNode(chunks[0]));
    index = 1;
    if (chunks.length > 1) handle = schedule(step);
  }
  return () => { if (handle != null) cancel(handle); };
}

/// 在弹窗里分片渲染一段可能很长的纯文本,并把 cancel 绑到弹窗关闭。
/// reasoning 全文、context 注入块都可能有几百 KB,单个 Text 节点会同步布局卡顿。
function openChunkedTextDetail({ title, text, className }) {
  let cancel = null;
  const dialog = openCardDetail({
    title,
    // 惰性:不打开就不拼,打开也只在点复制时才求值。
    copyText: () => text,
    build: () => {
      const host = el("pre", className);
      cancel = appendChunked(host, chunkText(text));
      return host;
    }
  });
  dialog?.addEventListener("close", () => { cancel?.(); cancel = null; }, { once: true });
  return dialog;
}

/// 用户消息正文。超长时只渲染前 FOLD_LIMIT 字符,并给一个"查看全部"入口 ——
/// 余下的文本不进这棵 DOM,靠弹窗惰性分片渲染。
function createUserText(text, refs = {}) {
  const fold = foldMessageText(text);
  if (!fold.folded) {
    const plain = el("div", "msg-user-body");
    plain.append(projectUserText(text, refs));
    return plain;
  }

  const wrap = el("div", "msg-user-body");
  const preview = el("span", "msg-user-preview");
  preview.append(projectUserText(fold.preview, refs));
  wrap.append(preview);
  wrap.append(el("span", "msg-user-ellipsis", "…"));

  const more = el("button", "msg-user-more");
  more.type = "button";
  more.textContent = t("message.viewAll");
  more.title = t("message.foldedChars", { n: String(fold.hidden) });
  more.addEventListener("click", () => {
    let cancel = null;
    const dialog = openCardDetail({
      title: t("message.fullText"),
      // 全文只在这里构建,且是分片的:点击不再一次性布局整段长文本。
      build: () => {
        const pre = el("pre", "msg-full-text");
        cancel = appendChunked(pre, chunkText(text));
        return pre;
      },
      copyText: () => text
    });
    // 弹窗关闭即停掉未完成的分片排程,避免关掉之后还在后台建节点。
    dialog?.addEventListener("close", () => { cancel?.(); cancel = null; }, { once: true });
  });
  wrap.append(more);
  return wrap;
}

export function createUserNode(node, context = {}) {
  const turn = el("div", "msg-user-turn");
  const bubble = el("div", "msg-user");
  const { text, images, files, rest } = splitUserContent(node.content);
  // 圈选元素的消息正文是一段属性 XML:投影成键值卡片,不把标记原样铺开。
  // [指令] 之后的原话仍在气泡里,按普通用户消息渲染。
  const cards = parseXMLMessageCards(text);

  // 附件行:图片 + 文件卡(web attachmentRow)。
  if (images.length || files.length) {
    const strip = el("div", "msg-imgs");
    for (const image of images) {
      const img = document.createElement("img");
      img.alt = image.name || "";
      applyImageSource(img, image, context);
      strip.append(img);
    }
    for (const file of files) {
      const card = el("span", "file-card");
      card.title = file.name;
      const fileIcon = el("span", "file-icon file-type-" + fileTypeKind(file.name));
      fileIcon.append(lucideIcon(fileTypeIconName(file.name), { size: 16 }));
      card.append(fileIcon);
      const content = el("span", "file-content");
      content.append(el("span", "file-name", file.name));
      const meta = [
        fileExtension(file.name).toUpperCase().slice(0, 8),
        fileSizeText(file.bytes)
      ].filter(Boolean).join(" ");
      if (meta) content.append(el("span", "file-meta", meta));
      card.append(content);
      strip.append(card);
    }
    bubble.append(strip);
  }

  const refs = {
    sessionRefs: node.referenceSessions ?? [],
    slashNames: node.skillNames ?? [],
    onOpenFile: context.onOpenFile,
    onOpenSkill: context.onOpenSkill,
    onOpenSession: context.onOpenSession
  };
  const remainder = cards ? cards.remainder : text;
  if (remainder) bubble.append(createUserText(remainder, refs));
  for (const block of rest) bubble.append(createJsonBlock(block, t("message.extraBlock")));

  // 卡片不进气泡:气泡是用户消息的强调底色,卡片各有自己的表面。
  if (cards) turn.append(createUserXmlCards(cards.cards, cards));
  if (bubble.childNodes.length) turn.append(bubble);
  const summary = referenceSummary(node.referenceLabels);
  if (summary) turn.append(summary);

  const actions = el("div", "msg-actions msg-user-actions");
  actions.append(el("span", "msg-timestamp", fmtTime(node.time)), makeCopyButton(() => text));
  turn.append(actions);
  return turn;
}

/// 用户消息里的其余块:与未知 assistant 块同构,原文进弹窗。
function createJsonBlock(value, label) {
  const wrap = el("div", "unknown-node");
  const trigger = el("button", "unknown-summary", label);
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.addEventListener("click", () => openCardDetail({
    title: label,
    copyText: safeJson(value),
    build: () => el("pre", null, safeJson(value))
  }));
  wrap.append(trigger);
  return wrap;
}

/// steering:插队消息。与普通用户消息使用同一种样式,不再做视觉区分。
export function createSteeringNode(node, context = {}) {
  return createUserNode(node, context);
}

/// 注入上下文的纯文本部分。
///
/// 不能用 blocksToText:它把图片块折成 "[image]" 占位符,而图片在这里是**正文**
/// (插件工具的截图往往是整条消息的全部内容),占位符只会把摘要行变成一句
/// "[image]",图片本身反而看不见 —— 正是 Mac ContextRow 修掉的那个症状。
function contextText(content) {
  return (content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/// 注入上下文里的图片(插件工具截图、粘贴的参考图)。
/// 历史消息里只有 attachment 引用,草稿/乐观消息才内联 data —— 两种都收。
function contextImageStrip(images, context, onOpen) {
  const strip = el("div", images.length > 1 ? "context-imgs multi" : "context-imgs");
  for (const image of images) {
    const img = document.createElement("img");
    img.alt = image.name || "";
    applyImageSource(img, image, context);
    if (onOpen) {
      img.addEventListener("click", onOpen);
      img.title = t("card.viewDetail");
    }
    strip.append(img);
  }
  return strip;
}

/// context:插件/工具注入的上下文。记录里只留一行入口,全文进弹窗 ——
/// 但图片例外,它们直接在行内出图。
///
/// 对齐 Mac 的 ContextRow:一行只写着 "tools-ptc" 等于把截图从记录里藏掉了,
/// 而截图恰恰是这类消息的全部内容。图片行内渲染,点击进详情看大图。
export function createContextNode(node, context = {}) {
  const label = node.provenanceLabel || node.provenanceRole || "context";
  const text = contextText(node.content);
  const { images } = splitUserContent(node.content);
  const wrap = el("div", "context-node");
  const trigger = el("button", "context-summary");
  trigger.type = "button";
  trigger.append(el("span", "context-label", label));
  trigger.append(el("span", "context-preview", text.slice(0, 80)));
  const openDetail = () => openContextDetail({ title: label, text, images, context });
  trigger.addEventListener("click", openDetail);
  wrap.append(trigger);
  if (images.length) wrap.append(contextImageStrip(images, context, openDetail));
  return wrap;
}

/// 上下文详情:图片在上、正文在下。正文仍然分片渲染(注入块可能几百 KB)。
function openContextDetail({ title, text, images, context }) {
  let cancel = null;
  const dialog = openCardDetail({
    title,
    // 只有文本才可复制;纯图片的注入不给复制键(对齐 Mac:结构化 UI 不给复制)。
    copyText: text ? () => text : null,
    build: () => {
      const host = el("div", "context-detail");
      if (images.length) host.append(contextImageStrip(images, context, null));
      if (text) {
        const pre = el("pre", "context-body");
        cancel = appendChunked(pre, chunkText(text));
        host.append(pre);
      }
      return host;
    }
  });
  dialog?.addEventListener("close", () => { cancel?.(); cancel = null; }, { once: true });
  return dialog;
}

// ---------- assistant ----------

/// assistant step 的一行。reasoning 块折叠展示,text 块渲染 markdown。
export function createAssistantNode(node, context = {}) {
  const turn = el("div", "msg-turn");
  updateAssistantNode(turn, node, context);
  return turn;
}

/// assistant 正文。超长时只把前 AGENT_FOLD_LIMIT 字符交给 markdown 渲染,
/// 余下的走"查看全部"弹窗 —— 与用户消息同样的策略。
///
/// 这里不只是省 DOM:流式期间每帧都会 replaceChildren + 重新 mdToHtml 整段正文,
/// 不设上限的话一条几百 KB 的回答会被反复解析重建(总工作量随长度平方增长),
/// 侧栏在模型打印大文件时直接卡死。折叠让每帧的解析量有上界。
/// assistant 正文:超长时前 AGENT_FOLD_LIMIT 字符走增量 markdown,余下进"查看全部"弹窗。
/// 元素跨帧复用,冻结前缀的 DOM(含着色)不会每帧重建。
function updateAgentText(body, text, mentions = null) {
  const fold = foldMessageText(text, AGENT_FOLD_LIMIT);
  // 截断处可能落在未闭合的代码围栏里,原样渲染会把后面的正文吞进代码块。
  // 补一行收尾围栏,让这一段仍是合法 markdown。
  const preview = fold.folded ? closeOpenFence(fold.preview) : text;
  renderIncrementalMarkdown(body, preview);
  decorateMentions(body, mentions);

  let more = body.querySelector(":scope > .msg-user-more");
  if (fold.folded) {
    if (!more) {
      more = el("button", "msg-user-more");
      more.type = "button";
      more.textContent = t("message.viewAll");
      more.addEventListener("click", () => {
        const full = body.__fullText ?? "";
        let cancel = null;
        const dialog = openCardDetail({
          title: t("message.fullText"),
          // 全文按分片建节点,且只在点开时构建。
          build: () => {
            const pre = el("pre", "msg-full-text");
            cancel = appendChunked(pre, chunkText(full));
            return pre;
          },
          copyText: () => full
        });
        dialog?.addEventListener("close", () => { cancel?.(); cancel = null; }, { once: true });
      });
      body.append(more);
    }
    body.__fullText = text;
    more.title = t("message.foldedChars", { n: String(fold.hidden) });
  } else if (more) {
    more.remove();
  }
}

/// 折叠切点若落在未闭合的围栏内,补一行**等长**围栏收尾。
///
/// 不能固定补三个反引号:开栅栏是四个时 ``` 关不掉它,反而变成代码块里多出来
/// 的一行。判定共用 md-to-html 的 readFence/isClosingFence,长度取开栅栏长度。
export function closeOpenFence(preview) {
  let openRun = 0;
  for (const line of String(preview ?? "").split("\n")) {
    if (openRun === 0) {
      const fence = readFence(line);
      if (fence) openRun = fence.run;
    } else if (isClosingFence(line, openRun)) {
      openRun = 0;
    }
  }
  return openRun === 0 ? preview : `${preview}\n${"`".repeat(openRun)}`;
}

/// 正文里被行内 code 命名的本轮产出路径 → 可点按钮(web fileMentions / mac
/// openMention)。精确路径匹配,或恰好唯一一个路径的 basename。
function decorateMentions(body, mentions) {
  const paths = mentions?.paths ?? [];
  const onOpen = mentions?.onOpen;
  if (!paths.length || typeof onOpen !== "function") {
    // 词表消失(重试后不再是收尾步)时把遗留的 mention 还原成普通 code。
    for (const link of body.querySelectorAll(".mention-link")) {
      const code = document.createElement("code");
      code.textContent = link.textContent ?? "";
      link.replaceWith(code);
    }
    return;
  }
  for (const code of body.querySelectorAll("code")) {
    if (code.closest("pre")) continue;         // fenced code 不是 mention
    const value = code.textContent ?? "";
    const path = resolveMention(value, mentions.paths);
    if (!path) continue;
    const btn = el("button", "mention-link", value);
    btn.type = "button";
    btn.title = path;
    btn.setAttribute("aria-label", `${t("reference.file")}: ${path}`);
    btn.addEventListener("click", () => mentions.onOpen(path));
    code.replaceWith(btn);
  }
}

/// 按 block 下标对账:同一位置、同一类型复用元素;text 块走增量 markdown。
/// 这样流式每帧只有尾部重解析,text 之外的块也不用重建。
export function updateAssistantNode(turn, node, context = {}) {
  turn.classList.toggle("interrupted", node.status === AssistantStatus.interrupted);

  // 行内 code mention 只给关闭轮的收尾 assistant step(web/Mac 的 closing 规则)。
  const paths = node.closing && node.status !== AssistantStatus.running
    ? (context.producedPaths?.(node.turn) ?? [])
    : [];
  const mentions = (paths.length && typeof context.onOpenPath === "function")
    ? { paths, onOpen: (path) => context.onOpenPath(resolveToolPath(path, context.cwd)) }
    : null;

  const blocks = node.blocks ?? [];
  const parts = turn.__parts ?? (turn.__parts = []);
  while (parts.length < blocks.length) parts.push(null);
  while (parts.length > blocks.length) parts.pop()?.el.remove();

  const ordered = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // 连续图片合成一组(web renderMessageImages 的 compact 行为)。
    if (block?.type === "image" && block.attachment) {
      let j = i + 1;
      while (j < blocks.length && blocks[j]?.type === "image" && blocks[j].attachment) j += 1;
      const kind = j - i > 1 ? "imageGroup" : "image";
      let part = parts[i];
      if (!part || part.kind !== kind || part.count !== j - i) {
        part?.el.remove();
        part = { kind, count: j - i, el: createBlockPart(kind) };
        parts[i] = part;
      }
      updateBlockPart(part, { run: blocks.slice(i, j) }, mentions, context);
      ordered.push(part.el);
      for (let k = i + 1; k < j; k += 1) { parts[k]?.el.remove(); parts[k] = null; }
      i = j - 1;
      continue;
    }
    if (!blockVisible(block)) {
      parts[i]?.el.remove();
      parts[i] = null;
      continue;
    }
    const kind = blockPartKind(block);
    let part = parts[i];
    if (!part || part.kind !== kind) {
      part?.el.remove();
      part = { kind, el: createBlockPart(kind) };
      parts[i] = part;
    }
    updateBlockPart(part, block, mentions, context);
    ordered.push(part.el);
  }

  // 按目标顺序落位(已存在则移动,不重建,着色 DOM 原地保留)。
  let cursor = turn.firstElementChild;
  for (const child of ordered) {
    if (child === cursor) cursor = cursor.nextElementSibling;
    else turn.insertBefore(child, cursor);
  }

  // 被打断的 step 即使没有内容也要留下"已停止"的痕迹。
  if (node.status === AssistantStatus.interrupted && !ordered.length) {
    if (!turn.__stopped) {
      turn.__stopped = el("div", "msg-interrupted", t("tool.interrupted"));
      turn.append(turn.__stopped);
    }
  } else if (turn.__stopped) {
    turn.__stopped.remove();
    turn.__stopped = null;
  }

  // assistant step **不挂操作行**。对齐 Mac 的 ChatNodeRow:`.assistant` 只渲染
  // AssistantMarkdown,复制/分叉/时钟统一由每轮末尾的 turnTail 页脚承担
  // (TurnTailIconActions),整轮只出现一次。
  //
  // 此前每个 step 都追加一行 msg-actions,而一个只发起了工具调用、没有文本块的
  // step 同样会拿到它 —— 于是工具卡底下浮出一行光秃秃的复制+时间戳,正是
  // "卡片底下也有 msg-turn" 的来源。
}

// ---- assistant block 对账 ----

function blockVisible(block) {
  if (!block) return false;
  if (block.type === "reasoning") return Boolean(block.text);
  if (block.type === "text") return Boolean(block.text);
  if (block.type === "image") return Boolean(block.attachment);
  // other:仅当承载了未知内容时成行(tool-result 映射过来的 value=null 不成行)。
  if (block.type === "other") return block.value != null;
  return false;
}

function blockPartKind(block) {
  return block.type;
}

function createBlockPart(kind) {
  if (kind === "reasoning") return createReasoningBlock();
  if (kind === "text") return el("div", "msg-agent md-body");
  if (kind === "other") return el("div", "unknown-node");
  if (kind === "imageGroup") return el("div", "msg-img-group");
  return assistantImage(null);
}

/// assistant 图片块:内联 base64 或按 attachmentId 读回 + 文件名作 alt。
function assistantImage(attachment, context = {}) {
  const img = document.createElement("img");
  img.className = "msg-agent-img";
  const a = attachment;
  img.alt = a?.name || "";
  applyImageSource(img, a, context);
  return img;
}

function updateBlockPart(part, block, mentions, context = {}) {
  if (part.kind === "reasoning") {
    updateReasoningBlock(part.el, block.text);
  } else if (part.kind === "text") {
    updateAgentText(part.el, block.text, mentions);
  } else if (part.kind === "other") {
    updateUnknownBlock(part.el, block.value);
  } else if (part.kind === "imageGroup") {
    part.el.replaceChildren(...(block.run ?? []).map((entry) => assistantImage(entry.attachment, context)));
  } else {
    // 单张图片也走 { run: [...] } 包装(与 imageGroup 同一条路径),这里取第一个附件。
    const a = block.attachment ?? block.run?.[0]?.attachment;
    part.el.alt = a?.name || "";
    applyImageSource(part.el, a, context);
  }
}

/// 未知 assistant 块:保留一行入口,原始 JSON 只在点击时进弹窗(web JsonBlock)。
function updateUnknownBlock(wrap, value) {
  const type = value && typeof value === "object" ? (value.type ?? "unknown") : typeof value;
  const label = t("node.unknownBlock", { type: String(type) });
  wrap.replaceChildren();
  const trigger = el("button", "unknown-summary", label);
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.addEventListener("click", () => openCardDetail({
    title: label,
    copyText: safeJson(value),
    build: () => el("pre", null, safeJson(value))
  }));
  wrap.append(trigger);
}

/// 思考块:对齐 Mac 的 ThinkRow —— 图标 + 思考文本的**第一行**作摘要,单行截断;
/// 完整全文仍只在详情弹窗里(无流式预览,思考就是一张和工具行同构的普通卡行)。
function createReasoningBlock() {
  const wrap = el("div", "thinking-bubble");
  const header = el("button", "thinking-header");
  header.type = "button";
  const thinkingIcon = el("span", "thinking-icon");
  thinkingIcon.append(lucideIcon("brain", { size: 13 }));
  header.append(thinkingIcon, el("span", "thinking-title", ""));
  // 可读名称 = "思考过程" + 摘要,与 Mac 的 accessibilityRowLabel 一致。
  header.addEventListener("click", () => openChunkedTextDetail({
    title: t("thinking"), text: wrap.__text ?? "", className: "thinking-body"
  }));
  wrap.append(header);
  return wrap;
}

function updateReasoningBlock(wrap, text) {
  wrap.__text = text;
  const summary = thinkingSummary(text);
  wrap.querySelector(".thinking-title").textContent = summary;
  wrap.querySelector(".thinking-header").setAttribute("aria-label", [t("thinking"), summary].filter(Boolean).join(" "));
}

/// Mac ThinkRow.summary:取第一行非空白内容,trim 后作为行的摘要;
/// 整段都是空白时返回空串,行退化为只有图标(标签兜底交给 aria)。
function thinkingSummary(text) {
  const line = String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  // 剥掉 markdown 粗体标记(web ReasoningRow 的 replaceAll('**','')):
  // 摘要行不解析 markdown,留着 ** 只会露出标记本身。
  return (line ?? "").replace(/\*\*/g, "");
}

// ---------- 工具行 ----------

export function createToolNode(node, context) {
  const row = el("div", "tool-row");
  updateToolNode(row, node, context);
  return row;
}

export function updateToolNode(row, node, context = {}) {
  const model = toolRowModel(node, context);

  row.dataset.state = model.state;
  row.replaceChildren();

  // ---- 头部(点击才弹出详情)----
  // 用 div+role 而不是 <button>:摘要路径内部要放一个可点的文件链接,
  // 交互元素不能嵌套在 button 里(Mac 的 ToolRow 也是 glyph+summary 才可点)。
  const header = el("div", "tool-header");
  header.setAttribute("role", "button");
  header.tabIndex = 0;

  const icon = el("span", "tool-icon");
  if (model.state === ToolRowState.running) icon.classList.add("running");
  if (model.state === ToolRowState.error) icon.classList.add("error");
  if (model.state === ToolRowState.stopped) icon.classList.add("stopped");
  icon.innerHTML = getToolIconSvg(getToolPresentation(node.name).iconKey);

  const summaryText = model.errorSummary ?? model.summary;
  let summary;
  if (model.filePath && typeof context.onOpenPath === "function") {
    // 路径即交互:相对 cwd 解析后交给宿主打开(Mac 的 Link / web 路径链接)。
    summary = el("button", "tool-label path tool-path", summaryText);
    summary.type = "button";
    summary.title = resolveToolPath(model.filePath, context.cwd);
    summary.addEventListener("click", (event) => {
      event.stopPropagation();
      context.onOpenPath(resolveToolPath(model.filePath, context.cwd));
    });
  } else {
    summary = el("span", "tool-label", summaryText);
  }
  if (model.state === ToolRowState.error) {
    // 失败的代码执行把失败行渲成警告色(程序跑失败是可恢复的结果,不是应用错误);
    // 其他工具保持错误红。
    summary.classList.add(model.variant === ToolVariant.code ? "warn" : "error");
  }
  if (model.filePath && !summary.classList.contains("path")) summary.classList.add("path");

  header.append(icon, summary);
  if (model.summarySuffix) header.append(el("span", "tool-suffix", model.summarySuffix));

  // ---- 详情入口 ----
  // 正文不再挂进记录流,只在点击时惰性构建;运行中的调用每次打开都取当前
  // 节点快照,所以结果到达后再打开能看到最新输出。
  const hasDetail = hasToolDetail(node, model) || subCallCount(node) > 0;
  row.classList.toggle("no-detail", !hasDetail);
  header.setAttribute("aria-disabled", String(!hasDetail));
  header.setAttribute("aria-haspopup", "dialog");
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    header.click();
  });
  header.addEventListener("click", () => {
    if (!hasDetail) return;
    // 参数与输出都可能是几 MB(写文件的 args、构建日志的 stdout)。正文里的这两块
    // 走分片渲染,弹窗关闭时要停掉未跑完的排程,否则关掉后还在后台建节点。
    const cancels = [];
    const dialog = openCardDetail({
      title: (model.errorSummary ?? model.summary ?? t("tool.call")).split("\n")[0],
      copyText: () => toolCopyText(node, model),
      build: () => buildToolBody(node, model, { ...context, onChunked: (fn) => cancels.push(fn) })
    });
    dialog?.addEventListener("close", () => {
      for (const fn of cancels.splice(0)) fn?.();
    }, { once: true });
  });

  // 子调用(run_code 的 code-dispatch 嵌套)不进记录流:一次 fan-out 可能派发
  // 几十个子调用,平铺出来就把滚动区变成一棵树。树只在详情弹窗里建。
  row.append(header);
}

/// 这一行有没有可展开的内容——决定入口是否可点。
/// 与 buildToolBody 同源:三个来源(计划文档 / 参数或命令 / 结果)任一存在即可点。
function subCallCount(node) {
  return node.subCalls?.length ?? 0;
}

function hasToolDetail(node, model) {
  if (node.name === "exit_plan_mode" && planText(node)) return true;
  if (node.argsRaw) return true;
  if (node.result) {
    if (hasResultText(node.result)) return true;
    // 历史结果里的图片块只有 attachment 引用(字节按需读回),只认 data 会让
    // 一条纯图片的工具结果整行不可点 —— 图既不在行上,也打不开详情。
    if ((node.result.content ?? []).some((b) => b?.type === "image" && (b.data || b.attachment))) return true;
  }
  return false;
}

/// 弹窗右上角复制用的纯文本形态:命令 / 参数 / 输出拼在一起。
function toolCopyText(node, model) {
  const parts = [];
  if (node.name === "exit_plan_mode") {
    const plan = planText(node);
    if (plan) return plan;
  }
  if (model.variant === ToolVariant.bash) {
    const command = argValue(node.argsRaw, "command");
    if (command) parts.push(`$ ${command}`);
  } else if (node.argsRaw) {
    parts.push(prettyJson(node.argsRaw));
  }
  if (node.result) {
    const text = resultText(node.result);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/// 详情正文:按 variant 选卡片。返回 null 表示无可展开内容。
function buildToolBody(node, model, context = {}) {
  const wrap = el("div", "tool-detail");

  // exit_plan_mode:计划文档本身,渲染 markdown 而不是塞进 JSON 参数信封。
  if (node.name === "exit_plan_mode") {
    const plan = planText(node);
    if (plan) {
      const card = el("div", "plan-inline md-body");
      card.innerHTML = mdToHtml(plan);
      decorateCodeBlocks(card);
      wrap.append(card);
      return wrap;
    }
  }

  // bash/pwsh:命令 + 输出的终端卡。
  if (model.variant === ToolVariant.bash) {
    const command = argValue(node.argsRaw, "command");
    if (command) {
      const pre = el("pre", "tool-command");
      pre.append(el("code", null, `$ ${command}`));
      wrap.append(pre);
    }
  }

  // 参数(命令类已单独展示则跳过)。
  if (node.argsRaw && model.variant !== ToolVariant.bash) {
    const args = el("details", "tool-args");
    args.append(el("summary", null, "IN"));
    const pre = el("pre", null);
    // prettyJson 会把原文重新缩进(通常膨胀 3-5 倍),对写文件这类巨型参数来说
    // 分片是必须的:一次性塞进单个 Text 节点会同步布局到卡死。
    context.onChunked?.(appendChunked(pre, chunkText(prettyJson(node.argsRaw))));
    args.append(pre);
    wrap.append(args);
  }

  // 结果。
  if (node.result) {
    const text = resultText(node.result);
    if (text) {
      const out = el("details", "tool-output");
      out.open = true;
      out.append(el("summary", null, "OUT"));
      const pre = el("pre", null);
      // 一条 `cat big.json` / 十万行构建日志展开时就是这里:分片渲染。
      context.onChunked?.(appendChunked(pre, chunkText(text)));
      out.append(pre);
      wrap.append(out);
    }
    // 结果里的图片块直接显示。
    for (const block of node.result.content ?? []) {
      if (block?.type === "image" && (block.data || block.attachment)) {
        const img = document.createElement("img");
        img.className = "tool-result-img";
        img.alt = block.name || "";
        applyImageSource(img, block.attachment ?? block, context);
        wrap.append(img);
      }
    }
  }

  // 子调用树:嵌套行只在弹窗里建,和记录流里的折叠行同一套渲染。
  if (subCallCount(node)) {
    const nested = el("div", "tool-subcalls");
    for (const child of node.subCalls) nested.append(createToolNode(child, context));
    wrap.append(nested);
  }

  return wrap.childElementCount ? wrap : null;
}

function planText(node) {
  // 宿主的 presentCall 视图第一个文本块优先,回退到参数里的 plan 字段。
  const view = node.callView;
  if (view && Array.isArray(view.content)) {
    const first = view.content.find((b) => b?.type === "text" && b.text);
    if (first) return first.text;
  }
  return argValue(node.argsRaw, "plan");
}

function argValue(argsRaw, key) {
  try {
    const obj = JSON.parse(argsRaw);
    return typeof obj?.[key] === "string" ? obj[key] : null;
  } catch {
    return null;
  }
}

/// 相对路径按 cwd 解析(绝对路径、~ 开头原样)。对齐 Mac ToolRow 的 Link 解析。
function resolveToolPath(path, cwd) {
  const value = String(path ?? "");
  if (!value) return value;
  if (/^([a-zA-Z]:[\\/]|\/|~)/.test(value) || !cwd) return value;
  const separator = String(cwd).includes("\\") ? "\\" : "/";
  return `${String(cwd).replace(/[\\/]+$/, "")}${separator}${value}`;
}

function prettyJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// ---------- 其他节点 ----------

export function createCompactionNode(node) {
  const wrap = el("div", "chip-row compaction-chip");
  wrap.append(el("span", "chip-icon", "⇲"));
  const label = node.shadowedTokenCount != null
    ? `${t("node.compaction")} · ${t("node.compactionTokens", { tokens: String(node.shadowedTokenCount) })}`
    : t("node.compaction");
  wrap.append(el("span", "chip-label", label));
  // 摘要全文进弹窗,记录里只留这枚 chip。
  if (node.summary) {
    const more = el("button", "chip-more", t("card.viewDetail"));
    more.type = "button";
    more.setAttribute("aria-haspopup", "dialog");
    more.addEventListener("click", () => openCardDetail({
      title: t("node.compaction"),
      copyText: node.summary,
      build: () => {
        const body = el("div", "compaction-body");
        body.innerHTML = mdToHtml(node.summary);
        decorateCodeBlocks(body);
        return body;
      }
    }));
    wrap.append(more);
  }
  return wrap;
}

export function createModelRetryNode(node) {
  /// 预算耗尽:retry ≥ maxRetries(∞ 模式 maxRetries 为 null,永不触发)。
  /// store 有意让重试链隐藏该轮 turn-error,失败原因的唯一出口就是本行 ——
  /// 所以耗尽时整行转错误色,并补一个详情入口(started 态标签不含 reason)。
  const exhausted = node.maxRetries != null && node.retry != null && node.retry >= node.maxRetries;
  const wrap = el("div", "chip-row retry-chip" + (exhausted ? " exhausted" : ""));
  wrap.append(el("span", "chip-icon", "↻"));
  const reason = node.failureMessage || node.failureCode || "";
  const label = node.retryState === "started"
    ? t("node.retryStarted", { retry: String(node.retry) })
    : t("node.retryScheduled", {
        retry: String(node.retry),
        max: String(node.maxRetries ?? "?"),
        reason
      });
  wrap.append(el("span", "chip-label", label));

  // 倒计时(web ModelRetryItem):只在等待期内跳动,到 1s 停止。
  const active = node.retryState === "scheduled" || node.retryState === "started";
  const delayMs = Number(node.delayMs);
  if (active && Number.isFinite(delayMs)) {
    const seconds = el("span", "chip-seconds", "");
    wrap.append(seconds);
    const deadline = Date.now() + delayMs;
    let timer = null;
    const tick = () => {
      const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      seconds.textContent = ` · ${remaining}s`;
      if (remaining <= 1 && timer) { clearInterval(timer); timer = null; }
      return remaining;
    };
    if (tick() > 1) timer = setInterval(tick, 250);
    wrap.dispose = () => { if (timer) clearInterval(timer); timer = null; };
  }

  // 详情:延迟 + 失败原因(web retryDetails)。耗尽时整行已转错误色。
  if (delayMs != null || reason) {
    const more = el("button", "chip-more", t("card.viewDetail"));
    more.type = "button";
    more.setAttribute("aria-haspopup", "dialog");
    more.addEventListener("click", () => openCardDetail({
      title: label,
      copyText: [delayMs != null ? t("node.retryDelay", { ms: String(Math.round(delayMs)) }) : "", reason]
        .filter(Boolean).join("\n"),
      build: () => {
        const body = el("div", "retry-detail");
        if (delayMs != null) {
          body.append(el("div", "retry-detail-row", t("node.retryDelay", { ms: String(Math.round(delayMs)) })));
        }
        if (reason) {
          body.append(el("div", "retry-detail-label", t("node.retryFailure")));
          body.append(el("pre", "command-output-body", reason));
        }
        return body;
      }
    }));
    wrap.append(more);
  }
  return wrap;
}

export function createTurnErrorNode(node) {
  const wrap = el("div", "msg-error");
  wrap.setAttribute("role", "alert");
  wrap.append(el("div", "msg-error-title", node.message));
  if (node.code) wrap.append(el("div", "msg-error-code", node.code));
  // 全文/错误码进详情弹窗,行内保持一眼可读(Mac 的失败 sheet)。
  const detailText = [node.message, node.code].filter(Boolean).join("\n");
  const more = el("button", "chip-more", t("card.viewDetail"));
  more.type = "button";
  more.setAttribute("aria-haspopup", "dialog");
  more.addEventListener("click", () => openCardDetail({
    title: node.message || t("node.unknown", { type: "error" }),
    copyText: detailText,
    build: () => el("pre", "command-output-body", detailText)
  }));
  wrap.append(more);
  return wrap;
}

export function createTurnMaxTokensNode() {
  const wrap = el("div", "chip-row maxtokens-chip");
  const alertIcon = el("span", "chip-icon");
  alertIcon.append(lucideIcon("triangle-alert", { size: 13 }));
  wrap.append(alertIcon, el("span", "chip-label", t("node.maxTokens")));
  const more = el("button", "chip-more", t("card.viewDetail"));
  more.type = "button";
  more.setAttribute("aria-haspopup", "dialog");
  more.addEventListener("click", () => openCardDetail({
    title: t("node.maxTokens"),
    copyText: t("node.maxTokensHint"),
    build: () => el("p", "maxtokens-hint", t("node.maxTokensHint"))
  }));
  wrap.append(more);
  return wrap;
}

export function createCommandNode(node) {
  const wrap = el("div", "chip-row command-chip");
  const prefixIcon = el("span", "chip-icon");
  prefixIcon.append(lucideIcon("chevron-right", { size: 12 }));
  wrap.append(prefixIcon);
  const name = t("node.commandRan", { name: node.name ?? "?" });
  wrap.append(el("span", "chip-label", node.args ? `${name} ${node.args}` : name));
  if (node.outcome?.text) {
    const more = el("button", "chip-more", node.outcome.kind);
    more.type = "button";
    more.setAttribute("aria-haspopup", "dialog");
    more.addEventListener("click", () => openCardDetail({
      title: name,
      copyText: node.outcome.text,
      build: () => el("pre", "command-output-body", node.outcome.text)
    }));
    wrap.append(more);
  }
  if (node.outcome?.kind === "error") wrap.classList.add("error");
  return wrap;
}

// ── 本轮用时/用量读数与锚定浮层(对齐 web TurnUsagePanel / TurnTimePanel + mac TurnStatPill)──

/// 整轮总 token(web TurnTokenUsage.totalTokens 优先,回退到已报桶之和)。
function turnTotalTokens(usage) {
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  const uncached = usage.uncachedInputTokens ?? usage.inputTokens ?? 0;
  return uncached + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
}

/// 紧凑 token 数:517 / 12.2K / 1.2M(web formatTokens)。
function formatCompactTokens(value) {
  const scaled = (candidate) => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10);
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${scaled(value / 1000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/// 精确 token 数,千分位分组(web formatExactTokens)。
function formatExactTokens(value) {
  const digits = String(Math.round(value));
  const groups = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups.join(",");
}

/// 精确 "N tok"(web message.turnUsage.count / mac tokenCount)。
function tokenCount(value) {
  return t("turn.usageCount", { count: formatExactTokens(value) });
}

/// 紧凑 "2.9M tok"——药丸自己的标签。
function compactTokenCount(value) {
  return t("turn.usageCount", { count: formatCompactTokens(value) });
}

/// 整秒向下取整的时长:不足一分钟 "{s}s",过一分钟 "{m}m {ss}s"(web formatRunDuration)。
function formatRunDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad2 = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  if (hours > 0) return t("duration.hours", { hours: String(hours), minutes: pad2(minutes), seconds: pad2(seconds) });
  if (minutes > 0) return t("duration.minutes", { minutes: String(minutes), seconds: pad2(seconds) });
  return t("duration.seconds", { seconds: String(seconds) });
}

/// 亚秒延迟读数:十秒以内一位小数,超过取整(web formatLatencySeconds)。
function formatLatencySeconds(ms) {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}

/// 解码吞吐:十以上取整,以下一位小数(web formatTokensPerSecond)。
function formatTokensPerSecond(tps) {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/// 缓存读占计费 prompt 的比例,一位小数;部分命中绝不进位到 100%(web formatCacheHitPercent)。
function cacheHitPercent(usage) {
  if (usage.cacheReadTokens == null) return null;
  const prompt = turnTotalTokens(usage) - (usage.outputTokens ?? 0);
  if (prompt <= 0) return null;
  const tenths = Math.min(1000, Math.max(0, Math.round(usage.cacheReadTokens / prompt * 1000)));
  const units = usage.cacheReadTokens < prompt ? Math.min(tenths, 999) : tenths;
  const whole = Math.floor(units / 10);
  const fraction = units % 10;
  return fraction === 0 ? String(whole) : `${whole}.${fraction}`;
}

/// 浮层的键值行(<dl>),null 值直接跳过。
function turnStatRows(rows) {
  const dl = el("dl", "turn-stat-rows");
  for (const [label, value] of rows) {
    if (value == null) continue;
    dl.append(el("dt", null, label));
    dl.append(el("dd", null, value));
  }
  return dl;
}

/// 用量明细(web TurnUsagePanel 的 <dl>)。
function buildTurnUsageRows(usage) {
  const routes = (usage.routes ?? []).map((route) => `${route.provider}/${route.model}`).join(", ");
  const hit = cacheHitPercent(usage);
  const output = tokenCount(usage.outputTokens ?? 0)
    + (usage.reasoningTokens != null
      ? t("turn.usageReasoning", { tokens: tokenCount(usage.reasoningTokens) })
      : "");
  const rows = [];
  if (routes) rows.push([t("turn.usageModel"), routes]);
  if (hit != null) rows.push([t("turn.usageCacheHit"), `${hit}%`]);
  rows.push([t("turn.usageInput"), tokenCount(usage.uncachedInputTokens ?? usage.inputTokens ?? 0)]);
  if (usage.cacheReadTokens != null) rows.push([t("turn.usageCacheRead"), tokenCount(usage.cacheReadTokens)]);
  if (usage.cacheWriteTokens != null) rows.push([t("turn.usageCacheWrite"), tokenCount(usage.cacheWriteTokens)]);
  rows.push([t("turn.usageOutput"), output]);
  return turnStatRows(rows);
}

/// 用时/速度明细(web TurnTimePanel 的 <dl>)。
function buildTurnTimeRows(runMs, tps, ttftMs) {
  const rows = [[t("turn.timeDuration"), formatRunDuration(runMs)]];
  if (tps != null && Number.isFinite(tps) && tps > 0) {
    rows.push([t("turn.timeSpeed"), `${formatTokensPerSecond(tps)} tok/s`]);
  }
  if (ttftMs != null) {
    rows.push([t("turn.timeTtft"), t("duration.seconds", { seconds: formatLatencySeconds(ttftMs) })]);
  }
  return turnStatRows(rows);
}

/// 全侧栏共用一个锚定浮层(原生 popover,自动 light-dismiss / Escape)。
/// 触发钮临时声明 anchor-name,浮层用 CSS 锚点定位吸附在其正上方。
let turnStatPopover = null;
let turnStatAnchor = null;
let turnStatPill = null;
let turnStatOpen = false;

function ensureTurnStatPopover() {
  if (turnStatPopover?.isConnected) return turnStatPopover;
  const panel = el("div", "turn-stat-pop");
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "dialog");
  panel.addEventListener("toggle", (event) => {
    if (event.newState === "closed") {
      turnStatOpen = false;
      releaseTurnStatAnchor();
    }
  });
  document.body.append(panel);
  turnStatPopover = panel;
  return panel;
}

function releaseTurnStatAnchor() {
  if (turnStatAnchor) turnStatAnchor.style.removeProperty("anchor-name");
  turnStatAnchor = null;
  if (turnStatPill) turnStatPill.setAttribute("aria-expanded", "false");
  turnStatPill = null;
}

/// 打开/切换某颗药丸的浮层。同一颗再点一次即关闭(native popover 的轻触关闭已处理外部点击)。
function openTurnStatPopover(anchor, { icon, title, headline, build }) {
  const panel = ensureTurnStatPopover();
  panel.replaceChildren();
  const head = el("div", "turn-stat-head");
  const headLabel = el("span", "turn-stat-head-label");
  headLabel.append(lucideIcon(icon, { size: 14 }));
  headLabel.append(el("span", null, title));
  head.append(headLabel);
  if (headline != null) head.append(el("span", "turn-stat-headline", headline));
  panel.append(head);
  panel.append(el("div", "turn-stat-rule"));
  panel.append(build());
  panel.setAttribute("aria-label", title);
  releaseTurnStatAnchor();
  turnStatAnchor = anchor;
  turnStatPill = anchor;
  anchor.style.setProperty("anchor-name", "--turn-stat-anchor");
  anchor.setAttribute("aria-expanded", "true");
  panel.style.setProperty("position-anchor", "--turn-stat-anchor");
  turnStatOpen = true;
  if (typeof panel.showPopover === "function") {
    try { panel.showPopover(); } catch { /* jsdom 无 popover API */ }
  } else {
    panel.classList.add("open");
  }
}

/// 关掉当前浮层(换会话 / 清空记录时调用,避免它停在上一会话的读数上)。
export function closeTurnStatPopover() {
  turnStatOpen = false;
  releaseTurnStatAnchor();
  if (!turnStatPopover) return;
  turnStatPopover.classList.remove("open");
  if (typeof turnStatPopover.hidePopover === "function") {
    try { turnStatPopover.hidePopover(); } catch { /* 已关闭 */ }
  }
}

/// 一颗读数药丸:图标 + 标签,点击开锚定浮层(web TurnStatPill)。
function buildTurnStatPill({ className, icon, label, title, headline, build }) {
  const pill = el("button", `turn-tail turn-tail-stat ${className}`);
  pill.type = "button";
  pill.setAttribute("aria-haspopup", "dialog");
  pill.title = label;
  pill.setAttribute("aria-label", label);
  pill.append(lucideIcon(icon, { size: 13 }));
  pill.append(el("span", "turn-tail-stat-label", label));
  pill.addEventListener("click", () => {
    if (turnStatOpen && turnStatAnchor === pill) {
      closeTurnStatPopover();
      return;
    }
    openTurnStatPopover(pill, { icon, title, headline, build });
  });
  return pill;
}

/// turnTail:每轮的页脚操作行。对齐 Mac 的 TurnTailIconActions:复制 → 分叉 → 时钟。
///
/// 分叉挂在**页脚**而不是 assistant 消息上,是 Mac 明确的设计:分叉要按 turn/end 的
/// seq 落点(`data.seq`),而 assistant step 的 seq 落在未闭合的轮次内部,服务端会以
/// OPEN_TURN 拒绝。所以整个记录里只有这一行能发起分叉。
export function createTurnTailNode(node, context = {}) {
  const { onFork, isLastTurn = true, producedPaths, presentedFiles, onOpenPath, onRevealPath } = context;
  const produced = typeof producedPaths === "function" ? (producedPaths(node.turn) ?? []) : [];
  const presented = typeof presentedFiles === "function" ? (presentedFiles(node.turn) ?? []) : [];
  // 产出/present 的 path 是工作区相对路径;宿主 openWorkspacePath 只按自己的 cwd
  // 解析(实测相对路径会被 open 到宿主 home),所以这里先按会话 cwd 补成绝对路径。
  const openPath = (path) => { if (typeof onOpenPath === "function") onOpenPath(resolveToolPath(path, context.cwd)); };
  const revealPath = (path) => { if (typeof onRevealPath === "function") onRevealPath(resolveToolPath(path, context.cwd)); };

  // 本轮改动文件记录的公告 seq(workspace-changes 插件);没有记录时为 null。
  const changesSeq = typeof context.changesSeq === "function" ? context.changesSeq(node.turn) : null;

  const usage = node.usage ?? null;
  const totalTokens = usage ? turnTotalTokens(usage) : 0;
  const hasUsage = totalTokens > 0;
  const runMs = node.runMs;
  const hasTime = runMs != null && runMs > 0;
  // 收尾消息、本轮用量、本轮用时三者皆无时,才彻底不占行(对齐 web/Mac 的 gate)。
  const hasActions = node.messageId != null || hasUsage || hasTime;
  if (!hasActions && !produced.length && !presented.length && changesSeq == null) return null;

  const wrap = el("div", "turn-tail-node");
  // 顺序对齐 web:改动文件卡在最上,其后才是产出 chips 与交付卡。
  if (changesSeq != null) wrap.append(buildChangedFiles(changesSeq, context, openPath));
  // 产出 chips 在收尾正文与图标动作之间(web TurnTail chain / mac ProducedFilesRow)。
  if (produced.length) wrap.append(buildProducedFiles(produced, openPath));
  if (presented.length) wrap.append(buildPresentedFiles(presented, openPath, revealPath));

  if (hasActions) {
    // 对齐 Mac 的 TurnTailIconActions:复制 → 分叉 → 用量 → 用时 → 时钟,是**同一行里
    // 的一簇**,左对齐、不加 spacer。整行沿用 msg-actions 的 hover 浮现语义。
    const row = el("div", "msg-actions turn-tail-actions");
    // 交互口径=Mac:最新一轮常显,其余 hover 才浮现。
    row.classList.toggle("always", isLastTurn);

    if (node.messageId != null) {
      row.append(makeCopyButton(() => node.closingText || ""));

      // 分叉。交互口径=Mac:每个已完成轮次都可分叉(不再限定最后一轮);
      // 不可用时保留按钮(dimmed 0.4)而不是移除,让 tooltip 解释原因。
      const fork = el("button", "act-btn");
      fork.append(lucideIcon("git-fork", { size: 14 }));
      fork.type = "button";
      const unavailable = !onFork || !Number.isInteger(node.seq);
      const label = unavailable ? t("fork.unavailable") : t("fork");
      fork.title = label;
      fork.setAttribute("aria-label", label);
      fork.disabled = unavailable;
      fork.classList.toggle("unavailable", unavailable);
      if (!unavailable) {
        fork.addEventListener("click", async () => {
          // in-flight:禁用并转圈,直到分叉返回(成功会切到新会话,元素随之销毁)。
          fork.disabled = true;
          fork.classList.add("busy");
          try {
            await onFork(node);
          } finally {
            fork.disabled = false;
            fork.classList.remove("busy");
          }
        });
      }
      row.append(fork);
    }

    // 本轮用量 / 用时:各一颗"图标 + 读数"的药丸,点开锚定浮层(web TurnUsagePanel /
    // TurnTimePanel,mac TurnStatPill)。顺序与 web/Mac 一致:用量 → 用时 → 时钟。
    if (hasUsage) {
      row.append(buildTurnStatPill({
        className: "turn-tail-usage",
        icon: "database",
        label: t("turn.usagePill", { total: compactTokenCount(totalTokens) }),
        title: t("turn.usageTitle"),
        headline: tokenCount(totalTokens),
        build: () => buildTurnUsageRows(usage)
      }));
    }
    if (hasTime) {
      row.append(buildTurnStatPill({
        className: "turn-tail-time",
        icon: "clock",
        label: t("turn.ranFor", { duration: formatRunDuration(runMs) }),
        title: t("turn.timeTitle"),
        build: () => buildTurnTimeRows(runMs, node.decodeTokensPerSec, node.ttftMs)
      }));
    }

    row.append(el("span", "msg-timestamp", fmtTime(node.time)));
    wrap.append(row);
  }
  return wrap;
}

/// 文件类型徽标(web FileTypeIcon 的扩展名回退):无扩展名时退回省略号。
function fileBadge(path) {
  const extension = fileExtension(deliverablesBasename(path)).replace(/^\./, "").toUpperCase();
  return extension ? extension.slice(0, 4) : "·";
}

/// 本轮产出 chips:最多 6 个(web ProducedFiles SHOWN_LIMIT),余量折成 "+N 文件"。
/// chip 上是文件名,title 给全路径(重名时的消歧)。
function buildProducedFiles(paths, onOpen) {
  const row = el("div", "turn-produces");
  row.append(el("span", "turn-produces-label", t("turn.produced")));
  const shown = paths.slice(0, 6);
  for (const path of shown) {
    const chip = el("button", "turn-produce-chip");
    chip.type = "button";
    chip.title = path;
    chip.setAttribute("aria-label", t("turn.openFile", { name: path }));
    const chipIcon = el("span", "turn-produce-icon");
    chipIcon.append(lucideIcon(linkIconName(path), { size: 13 }));
    chip.append(chipIcon);
    chip.append(el("span", "turn-produce-name", deliverablesBasename(path)));
    if (typeof onOpen === "function") chip.addEventListener("click", () => onOpen(path));
    row.append(chip);
  }
  if (paths.length > shown.length) {
    row.append(el("span", "turn-produce-more", t("turn.moreFiles", { n: String(paths.length - shown.length) })));
  }
  return row;
}

/// "在文件管理器中显示"的平台文案(web presented.finder / presented.explorer)。
function revealLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /win/i.test(platform) ? t("turn.revealInExplorer") : t("turn.revealInFolder");
}

/// 同一时刻只留一个交付卡菜单;点空白处或 Esc 关闭。
let presentMenusBound = false;
function closePresentMenus() {
  for (const menu of document.querySelectorAll(".turn-present-menu.open")) {
    menu.classList.remove("open");
    menu.parentElement?.querySelector(".turn-present-chevron")?.setAttribute("aria-expanded", "false");
  }
}
function bindPresentMenuDismiss() {
  if (presentMenusBound) return;
  presentMenusBound = true;
  document.addEventListener("click", (event) => {
    if (event.target?.closest?.(".turn-present-actions")) return;
    closePresentMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePresentMenus();
  });
}

/// present 交付卡(web Deliverables / PresentedFileCard,mac Docks 交付卡):
/// 类型徽标 + 文件名 + 描述 + 拆分动作 —— 主按钮"打开"(默认应用),右侧 chevron
/// 的菜单给"用默认应用打开 / 在 Finder 中显示"(web PresentedFileCard 的 split)。
/// 前 4 张直接展示(COLLAPSED_PRESENTED_COUNT),余下折成展开入口。
/// 每张卡占行宽一半(等宽两列),单文件时独占一行。
function buildPresentedFiles(files, onOpen, onReveal) {
  bindPresentMenuDismiss();
  const wrap = el("div", "turn-presents");
  wrap.append(el("span", "turn-produces-label", t("turn.presented")));
  const grid = el("div", "turn-present-grid");
  grid.dataset.single = files.length === 1 ? "true" : "false";
  const openFile = (path) => { if (typeof onOpen === "function") onOpen(path); };
  const revealFile = (path) => { if (typeof onReveal === "function") onReveal(path); };
  const render = (showAll) => {
    grid.replaceChildren();
    const limit = showAll ? files.length : Math.min(4, files.length);
    for (const file of files.slice(0, limit)) {
      const card = el("div", "turn-present-card");
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.title = file.path;
      card.setAttribute("aria-label", t("turn.openFile", { name: file.path }));
      const icon = el("span", "turn-present-icon file-type-" + fileTypeKind(file.path));
      icon.append(lucideIcon(fileTypeIconName(file.path), { size: 20 }));
      card.append(icon);
      const body = el("div", "turn-present-body");
      body.append(el("span", "turn-present-name", deliverablesBasename(file.path)));
      // 无描述时退回扩展名,保证第二行始终有信息(web cardDescription 的 metadata 回退)。
      body.append(el("span", "turn-present-desc",
        file.description || fileBadge(file.path)));
      card.append(body);
      const actions = el("div", "turn-present-actions");
      const open = el("button", "turn-present-open", t("turn.open"));
      open.type = "button";
      open.addEventListener("click", (event) => { event.stopPropagation(); openFile(file.path); });
      const chevron = el("button", "turn-present-chevron");
      chevron.type = "button";
      chevron.setAttribute("aria-haspopup", "menu");
      chevron.setAttribute("aria-expanded", "false");
      chevron.setAttribute("aria-label", t("turn.more", { name: file.path }));
      chevron.append(lucideIcon("chevron-down", { size: 13 }));
      const menu = el("div", "turn-present-menu");
      menu.setAttribute("role", "menu");
      const menuItem = (icon, label, action) => {
        const item = el("button", "turn-present-menu-item");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.append(lucideIcon(icon, { size: 15 }));
        item.append(el("span", null, label));
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          closePresentMenus();
          action();
        });
        return item;
      };
      menu.append(
        menuItem("arrow-up-right", t("turn.openWithDefault"), () => openFile(file.path)),
        menuItem("folder-open", revealLabel(), () => revealFile(file.path))
      );
      chevron.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = !menu.classList.contains("open");
        closePresentMenus();
        menu.classList.toggle("open", willOpen);
        chevron.setAttribute("aria-expanded", String(willOpen));
      });
      actions.append(open, chevron, menu);
      card.append(actions);
      card.addEventListener("click", () => openFile(file.path));
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openFile(file.path);
      });
      grid.append(card);
    }
  };
  render(false);
  wrap.append(grid);
  if (files.length > 4) {
    let expanded = false;
    const more = el("button", "turn-present-more", t("turn.showAll", { n: String(files.length) }));
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      expanded = !expanded;
      render(expanded);
      more.textContent = expanded
        ? t("turn.collapseAll", { n: String(files.length) })
        : t("turn.showAll", { n: String(files.length) });
      more.setAttribute("aria-expanded", String(expanded));
    });
    wrap.append(more);
  }
  return wrap;
}

/// 本轮改动文件卡(web ui-deliverables ChangedFiles / mac ChangedFilesCard)。
///
/// 两段式:耐久事件只公告"这一轮有改动记录",清单与逐文件对比要按公告的 seq
/// 去宿主读。所以这张卡先挂一个**空占位**,摘要落地后自己填 —— 宿主不再提供
/// (会话被回收后 404)时占位保持隐藏,而不是画一张空卡或报错。
const CHANGED_FILES_SHOWN = 3;

function buildChangedFiles(seq, context, openPath) {
  const card = el("div", "turn-changes");
  card.hidden = true;
  let expanded = false;

  const paint = (summary) => {
    card.replaceChildren();
    const header = el("div", "turn-changes-header");
    const tile = el("span", "turn-changes-tile");
    tile.append(lucideIcon("file-pen", { size: 13 }));
    header.append(tile);
    const titles = el("div", "turn-changes-titles");
    titles.append(el("span", "turn-changes-title",
      summary.total === 1 ? t("changes.titleOne") : t("changes.title", { n: String(summary.total) })));
    const stat = el("span", "turn-changes-stat");
    if (summary.added > 0) stat.append(el("span", "turn-changes-added", t("changes.added", { n: String(summary.added) })));
    if (summary.deleted > 0) stat.append(el("span", "turn-changes-deleted", t("changes.deleted", { n: String(summary.deleted) })));
    titles.append(stat);
    header.append(titles);
    card.append(header);

    const list = el("ul", "turn-changes-list");
    const shown = expanded ? summary.files : summary.files.slice(0, CHANGED_FILES_SHOWN);
    shown.forEach((file) => {
      // index 必须取自完整清单:diff 路由按摘要里的下标寻址,折叠后的切片下标会错位。
      const index = summary.files.indexOf(file);
      const item = el("li", null);
      const row = el("button", "turn-changes-row");
      row.type = "button";
      row.title = file.path;
      row.setAttribute("aria-label", t("changes.viewDiff", { name: file.display }));
      row.append(el("span", "turn-changes-path", file.display));
      const counts = el("span", "turn-changes-counts");
      if (file.binary) counts.append(el("span", null, t("changes.binary")));
      else if (file.oversized) counts.append(el("span", null, t("changes.oversized")));
      else {
        if (file.added > 0) counts.append(el("span", "turn-changes-added", t("changes.added", { n: String(file.added) })));
        if (file.deleted > 0) counts.append(el("span", "turn-changes-deleted", t("changes.deleted", { n: String(file.deleted) })));
      }
      row.append(counts);
      row.addEventListener("click", () => openChangedFileDetail(seq, index, file, context, openPath));
      item.append(row);
      list.append(item);
    });
    card.append(list);

    if (summary.files.length > CHANGED_FILES_SHOWN) {
      const toggle = el("button", "turn-changes-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.append(lucideIcon(expanded ? "chevron-up" : "chevron-down", { size: 13 }));
      toggle.append(el("span", null, expanded
        ? t("changes.collapse")
        : t("changes.showAll", { n: String(summary.files.length) })));
      toggle.addEventListener("click", () => { expanded = !expanded; paint(summary); });
      card.append(toggle);
    }
    card.hidden = false;
  };

  const render = (summary) => {
    // 宿主不再提供、或这一轮其实没有列出任何文件:保持隐藏的空占位。
    if (!summary || !summary.files.length) return;
    paint(summary);
  };

  const cached = typeof context.changesSummary === "function" ? context.changesSummary(seq) : null;
  if (cached) render(cached);
  else if (typeof context.loadChangesSummary === "function") {
    Promise.resolve(context.loadChangesSummary(seq)).then(render).catch(() => {});
  }
  return card;
}

/// 一个改动文件的 turn 起止对比:按需读一次,画进详情弹窗(mac ChangedFileReviewSheet)。
function openChangedFileDetail(seq, index, file, context, openPath) {
  openCardDetail({
    title: file.display,
    copyText: () => {
      const diff = typeof context.changesDiff === "function" ? context.changesDiff(seq, index) : null;
      return diff?.kind === "text" ? unifiedDiffText(diff.hunks) : "";
    },
    build: () => {
      const sheet = el("div", "diff-sheet");
      const head = el("div", "diff-sheet-head");
      head.append(el("span", "diff-sheet-path", file.path));
      const open = el("button", "diff-sheet-open", t("turn.open"));
      open.type = "button";
      open.addEventListener("click", () => openPath(file.path));
      head.append(open);
      const body = el("div", "diff-sheet-body");
      body.append(el("div", "diff-note", t("changes.loading")));
      sheet.append(head, body);

      const fill = (diff) => {
        body.replaceChildren();
        if (!diff) { body.append(el("div", "diff-note", t("changes.unavailable"))); return; }
        if (diff.kind === "binary") { body.append(el("div", "diff-note", t("changes.binary"))); return; }
        if (diff.kind === "oversized") { body.append(el("div", "diff-note", t("changes.oversized"))); return; }
        // 行级对比超时:宿主退化成整文件替换,明说一句,别让读者以为文件全被重写了。
        if (diff.coarse) body.append(el("div", "diff-note", t("changes.coarse")));
        if (!diff.hunks.length) { body.append(el("div", "diff-note", t("changes.identical"))); return; }
        body.append(buildUnifiedDiff(diff.hunks));
      };

      const cached = typeof context.changesDiff === "function" ? context.changesDiff(seq, index) : null;
      if (cached) fill(cached);
      else if (typeof context.loadChangesDiff === "function") {
        Promise.resolve(context.loadChangesDiff(seq, index)).then(fill).catch(() => fill(null));
      } else fill(null);
      return sheet;
    }
  });
}

/// workflow:记录里只留标题行 + 成员计数,phases/members 全部进弹窗。
/// 这是最重的一张卡(一次 fan-out 可能上百个成员),放进弹窗后滚动区不再承担它。
export function createWorkflowNode(node) {
  const wrap = el("div", "workflow-node");
  const header = el("button", "workflow-header");
  header.type = "button";
  header.setAttribute("aria-haspopup", "dialog");
  header.append(el("span", "chip-icon", "⛓"));
  header.append(el("span", "chip-label", t("node.workflow", { name: node.name })));
  header.append(el("span", `workflow-status ${node.status}`, node.status));
  const count = (node.phases ?? []).reduce((sum, phase) => sum + (phase.members?.length ?? 0), 0);
  if (count) header.append(el("span", "workflow-count", String(count)));
  header.addEventListener("click", () => openCardDetail({
    title: t("node.workflow", { name: node.name }),
    build: () => {
      const body = el("div", "workflow-detail");
      for (const phase of node.phases ?? []) {
        const group = el("div", "workflow-phase");
        if (phase.phase) group.append(el("div", "workflow-phase-label", phase.phase));
        for (const member of phase.members) {
          const row = el("div", `workflow-member ${member.status}`);
          row.append(el("span", "workflow-member-label", member.label));
          row.append(el("span", "workflow-member-status", member.status));
          group.append(row);
        }
        body.append(group);
      }
      return body;
    }
  }));
  wrap.append(header);
  return wrap;
}

/// 未被任何定义认领的事件:保留可见行,折叠原始 JSON。
export function createUnknownNode(node) {
  const wrap = el("div", "unknown-node");
  const label = t("node.unknown", { type: node.type });
  const trigger = el("button", "unknown-summary", label);
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.addEventListener("click", () => openCardDetail({
    title: label,
    copyText: safeJson(node.data),
    build: () => el("pre", null, safeJson(node.data))
  }));
  wrap.append(trigger);
  return wrap;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/// Turn process 折叠头:整行可点(button 自带 Enter/Space),chevron + 计数。
/// 没有可折叠成员时返回 null,不占行。
export function createTurnProcessNode(node, context = {}) {
  if (!(node.memberCount > 0)) return null;
  const button = el("button", "turn-process");
  button.type = "button";
  button.dataset.turnProcess = String(node.turn);
  const labels = [];
  if (node.toolCallCount > 0) labels.push(t("process.toolCalls", { n: String(node.toolCallCount) }));
  if (node.messageCount > 0) labels.push(t("process.messages", { n: String(node.messageCount) }));
  if (node.subagentCount > 0) labels.push(t("process.subagents", { n: String(node.subagentCount) }));
  const label = labels.length ? labels.join(t("process.separator")) : t("process.thought");
  const open = Boolean(context.processOpen);
  button.dataset.open = open ? "true" : "false";
  button.setAttribute("aria-expanded", String(open));
  button.title = open ? t("process.collapse") : t("process.expand");
  const chevron = el("span", "turn-process-chevron");
    chevron.append(lucideIcon("chevron-right", { size: 14 }));
    button.append(chevron, el("span", "turn-process-label", label));
  button.addEventListener("click", () => context.onToggleProcess?.(node.turn));
  return button;
}

// ---------- 分发 ----------

export function createNodeElement(node, context) {
  switch (node.kind) {
    case NodeKind.user: return createUserNode(node, context);
    case NodeKind.steering: return createSteeringNode(node, context);
    case NodeKind.context: return createContextNode(node, context);
    case NodeKind.assistant: return createAssistantNode(node, context);
    case NodeKind.toolCall: return createToolNode(node, context);
    case NodeKind.compaction: return createCompactionNode(node);
    case NodeKind.modelRetry: return createModelRetryNode(node);
    case NodeKind.turnError: return createTurnErrorNode(node);
    case NodeKind.turnMaxTokens: return createTurnMaxTokensNode(node);
    case NodeKind.command: return createCommandNode(node);
    case NodeKind.turnProcess: return createTurnProcessNode(node, context);
    case NodeKind.turnTail: return createTurnTailNode(node, context);
    case NodeKind.workflowRun: return createWorkflowNode(node);
    case NodeKind.unknownSurface: return createUnknownNode(node);
    default: return null;
  }
}

/// 就地更新。返回 false 表示这种节点不支持原地更新,调用方应重建。
export function updateNodeElement(element, node, context) {
  switch (node.kind) {
    case NodeKind.assistant: updateAssistantNode(element, node, context); return true;
    case NodeKind.toolCall: updateToolNode(element, node, context); return true;
    default: return false;
  }
}
