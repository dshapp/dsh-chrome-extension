// 各类节点的行渲染。对齐 Mac 的 MessageItems / ToolRow / TrajectoryView 的信息密度,
// 但沿用本插件既有的 CSS 语言(tool-row / msg-* / chip)。
//
// 每个 create* 返回一个 DOM 节点;每个 update* 就地更新同一节点。
// renderer 靠 nodeId 决定复用还是重建。
import { t } from "../../shared/i18n.js";
import { mdToHtml, escapeHtml } from "../../shared/md-to-html.js";
import { NodeKind, AssistantStatus, ToolRowState, blocksToText } from "../sessions/chat-nodes.js";
import { toolRowModel, resultText, hasResultText, ToolVariant } from "./tool-row-model.js";
import { getToolIconSvg, getToolPresentation } from "./tool-presentation.js";
import { decorateCodeBlocks, renderMarkdownInto, fmtTime } from "./chat-view.js";
import { openCardDetail } from "./card-detail.js";
import { foldMessageText, chunkText } from "./long-message.js";

// lucide: chevron-down (https://github.com/lucide-icons/lucide,ISC),原始路径,stroke-width 调至 1.7。
const CHEVRON = '<svg class="tool-chevron dropdown-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- user / steering / context ----------

function makeCopyButton(getText) {
  const copy = el("button", "act-btn");
  copy.type = "button";
  copy.title = t("copy");
  copy.setAttribute("aria-label", t("copy"));
  copy.textContent = "⧉";
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(getText() || "").catch(() => {});
    copy.textContent = "✓";
    setTimeout(() => { copy.textContent = "⧉"; }, 1200);
  });
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

/// 用户消息正文。超长时只渲染前 FOLD_LIMIT 字符,并给一个"查看全部"入口 ——
/// 余下的文本不进这棵 DOM,靠弹窗惰性分片渲染。
function createUserText(text) {
  const fold = foldMessageText(text);
  if (!fold.folded) return el("div", null, text);

  const wrap = el("div", "msg-user-body");
  wrap.append(el("span", "msg-user-preview", fold.preview));
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

export function createUserNode(node) {
  const turn = el("div", "msg-user-turn");
  const bubble = el("div", "msg-user");
  const images = (node.content ?? []).filter((b) => b?.type === "image" && b.data);
  if (images.length) {
    const strip = el("div", "msg-imgs");
    for (const image of images) {
      const img = document.createElement("img");
      img.src = `data:${image.mediaType || "image/png"};base64,${image.data}`;
      img.alt = image.name || "";
      strip.append(img);
    }
    bubble.append(strip);
  }
  const text = blocksToText(node.content);
  if (text) bubble.append(createUserText(text));
  const actions = el("div", "msg-actions msg-user-actions");
  actions.append(el("span", "msg-timestamp", fmtTime(node.time)), makeCopyButton(() => text));
  turn.append(bubble, actions);
  return turn;
}

/// steering:插队消息。视觉上比普通用户消息更轻,并标注它是中途插入的。
export function createSteeringNode(node) {
  const wrap = el("div", "msg-user-turn steering");
  const bubble = el("div", "msg-user steering");
  bubble.append(el("span", "steering-badge", "⚡"));
  bubble.append(el("span", null, blocksToText(node.content)));
  wrap.append(bubble);
  return wrap;
}

/// context:插件/工具注入的上下文。记录里只留一行入口,全文进弹窗。
export function createContextNode(node) {
  const label = node.provenanceLabel || node.provenanceRole || "context";
  const text = blocksToText(node.content);
  const wrap = el("div", "context-node");
  const trigger = el("button", "context-summary");
  trigger.type = "button";
  trigger.append(el("span", "context-label", label));
  trigger.append(el("span", "context-preview", text.slice(0, 80)));
  trigger.insertAdjacentHTML("beforeend", CHEVRON);
  trigger.addEventListener("click", () => openCardDetail({
    title: label,
    copyText: text,
    build: () => el("pre", "context-body", text)
  }));
  wrap.append(trigger);
  return wrap;
}

// ---------- assistant ----------

/// assistant step 的一行。reasoning 块折叠展示,text 块渲染 markdown。
export function createAssistantNode(node) {
  const turn = el("div", "msg-turn");
  updateAssistantNode(turn, node);
  return turn;
}

export function updateAssistantNode(turn, node) {
  turn.replaceChildren();
  turn.classList.toggle("interrupted", node.status === AssistantStatus.interrupted);

  for (const block of node.blocks ?? []) {
    if (!block) continue;
    if (block.type === "reasoning" && block.text) {
      turn.append(createReasoningBlock(block.text));
    } else if (block.type === "text" && block.text) {
      const body = el("div", "msg-agent");
      renderMarkdownInto(body, block.text);
      turn.append(body);
    } else if (block.type === "image" && block.attachment) {
      const img = document.createElement("img");
      img.className = "msg-agent-img";
      const a = block.attachment;
      if (typeof a === "object" && a.data) img.src = `data:${a.mediaType || "image/png"};base64,${a.data}`;
      turn.append(img);
    }
  }

  // 被打断的 step 即使没有内容也要留下"已停止"的痕迹。
  if (node.status === AssistantStatus.interrupted && !turn.childElementCount) {
    turn.append(el("div", "msg-interrupted", t("tool.interrupted")));
  }

  // assistant step **不挂操作行**。对齐 Mac 的 ChatNodeRow:`.assistant` 只渲染
  // AssistantMarkdown,复制/分叉/时钟统一由每轮末尾的 turnTail 页脚承担
  // (TurnTailIconActions),整轮只出现一次。
  //
  // 此前每个 step 都追加一行 msg-actions,而一个只发起了工具调用、没有文本块的
  // step 同样会拿到它 —— 于是工具卡底下浮出一行光秃秃的复制+时间戳,正是
  // "卡片底下也有 msg-turn" 的来源。
}

/// 思考块:记录里只留一行"思考"入口,全文进弹窗(对齐 Mac 的 .think 卡)。
function createReasoningBlock(text) {
  const wrap = el("div", "thinking-bubble");
  const header = el("button", "thinking-header");
  header.type = "button";
  header.append(el("span", "thinking-icon", "✨"), el("span", "thinking-title", t("thinking")));
  header.insertAdjacentHTML("beforeend",
    '<svg class="thinking-chevron dropdown-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');
  header.addEventListener("click", () => openCardDetail({
    title: t("thinking"),
    copyText: text,
    build: () => el("div", "thinking-body", text)
  }));
  wrap.append(header);
  return wrap;
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

  // ---- 头部(唯一可见部分:点击才弹出详情)----
  const header = el("button", "tool-header");
  header.type = "button";

  const icon = el("span", "tool-icon");
  if (model.state === ToolRowState.running) icon.classList.add("running");
  if (model.state === ToolRowState.error) icon.classList.add("error");
  if (model.state === ToolRowState.stopped) icon.classList.add("stopped");
  icon.innerHTML = getToolIconSvg(getToolPresentation(node.name).iconKey);

  const summary = el("span", "tool-label");
  summary.textContent = model.errorSummary ?? model.summary;
  if (model.state === ToolRowState.error) {
    // 失败的代码执行把失败行渲成警告色(程序跑失败是可恢复的结果,不是应用错误);
    // 其他工具保持错误红。
    summary.classList.add(model.variant === ToolVariant.code ? "warn" : "error");
  }
  if (model.filePath) summary.classList.add("path");

  header.append(icon, summary);
  if (model.summarySuffix) header.append(el("span", "tool-suffix", model.summarySuffix));
  header.insertAdjacentHTML("beforeend", CHEVRON);

  // ---- 详情入口 ----
  // 正文不再挂进记录流,只在点击时惰性构建;运行中的调用每次打开都取当前
  // 节点快照,所以结果到达后再打开能看到最新输出。
  const hasDetail = hasToolDetail(node, model) || subCallCount(node) > 0;
  row.classList.toggle("no-detail", !hasDetail);
  header.setAttribute("aria-disabled", String(!hasDetail));
  header.setAttribute("aria-haspopup", "dialog");
  header.addEventListener("click", () => {
    if (!hasDetail) return;
    openCardDetail({
      title: (model.errorSummary ?? model.summary ?? t("tool.call")).split("\n")[0],
      copyText: () => toolCopyText(node, model),
      build: () => buildToolBody(node, model, context)
    });
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
    if ((node.result.content ?? []).some((b) => b?.type === "image" && b.data)) return true;
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
      const card = el("div", "plan-inline");
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
    args.append(el("pre", null, prettyJson(node.argsRaw)));
    wrap.append(args);
  }

  // 结果。
  if (node.result) {
    const text = resultText(node.result);
    if (text) {
      const out = el("details", "tool-output");
      out.open = true;
      out.append(el("summary", null, "OUT"));
      out.append(el("pre", null, text));
      wrap.append(out);
    }
    // 结果里的图片块直接显示。
    for (const block of node.result.content ?? []) {
      if (block?.type === "image" && block.data) {
        const img = document.createElement("img");
        img.className = "tool-result-img";
        img.src = `data:${block.mediaType || "image/png"};base64,${block.data}`;
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
  if (exhausted && reason) {
    const more = el("button", "chip-more", reason.split("\n")[0]);
    more.type = "button";
    more.setAttribute("aria-haspopup", "dialog");
    more.addEventListener("click", () => openCardDetail({
      title: label,
      copyText: reason,
      build: () => el("pre", "command-output-body", reason)
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
  return wrap;
}

export function createTurnMaxTokensNode() {
  const wrap = el("div", "chip-row maxtokens-chip");
  wrap.append(el("span", "chip-icon", "⚠"), el("span", "chip-label", t("node.maxTokens")));
  return wrap;
}

export function createCommandNode(node) {
  const wrap = el("div", "chip-row command-chip");
  wrap.append(el("span", "chip-icon", "›"));
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

/// turnTail:每轮的页脚操作行。对齐 Mac 的 TurnTailIconActions:复制 → 分叉 → 时钟。
///
/// 分叉挂在**页脚**而不是 assistant 消息上,是 Mac 明确的设计:分叉要按 turn/end 的
/// seq 落点(`data.seq`),而 assistant step 的 seq 落在未闭合的轮次内部,服务端会以
/// OPEN_TURN 拒绝。所以整个记录里只有这一行能发起分叉。
export function createTurnTailNode(node, { onFork, isLastTurn = true } = {}) {
  const parts = [];
  if (node.ttftMs != null) parts.push(t("turn.ttft", { ms: String(Math.round(node.ttftMs)) }));
  if (node.decodeTokensPerSec != null) parts.push(t("turn.throughput", { rate: node.decodeTokensPerSec.toFixed(1) }));
  if (node.runMs != null) parts.push(t("turn.runtime", { seconds: (node.runMs / 1000).toFixed(1) }));
  const tokens = node.usage?.outputTokens;
  if (tokens != null) parts.push(t("usage.tokens", { tokens: String(tokens) }));
  // 只有指标为空、且这一轮也没有可复制/可分叉的收尾消息时,才彻底不占行。
  if (!parts.length && node.messageId == null) return null;

  // 对齐 Mac 的 TurnTailIconActions:复制 → 分叉 → 时钟,是**同一行里的一簇**,
  // 左对齐、不加 spacer(Mac 注释明确写了 "No Spacer ... a single left-aligned
  // cluster")。整行沿用 msg-actions 的 hover 浮现语义。
  const row = el("div", "msg-actions turn-tail-actions");

  if (node.messageId != null) {
    row.append(makeCopyButton(() => node.closingText || ""));

    // 分叉。Mac 在不可用时**保留按钮**(dimmed 0.4)而不是移除,这样 tooltip
    // 还能解释为什么不能点——一个凭空消失的按钮没法自我说明。
    const fork = el("button", "act-btn", "⑂");
    fork.type = "button";
    const unavailable = !onFork || !isLastTurn || !Number.isInteger(node.seq);
    const label = unavailable ? t("fork.unavailable") : t("fork");
    fork.title = label;
    fork.setAttribute("aria-label", label);
    fork.disabled = unavailable;
    fork.classList.toggle("unavailable", unavailable);
    if (!unavailable) fork.addEventListener("click", () => onFork(node));
    row.append(fork);
  }

  row.append(el("span", "msg-timestamp", fmtTime(node.time)));
  if (parts.length) row.append(el("span", "turn-tail", parts.join(" · ")));
  return row;
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
  header.insertAdjacentHTML("beforeend", CHEVRON);
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
  trigger.insertAdjacentHTML("beforeend", CHEVRON);
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

// ---------- 分发 ----------

export function createNodeElement(node, context) {
  switch (node.kind) {
    case NodeKind.user: return createUserNode(node);
    case NodeKind.steering: return createSteeringNode(node);
    case NodeKind.context: return createContextNode(node);
    case NodeKind.assistant: return createAssistantNode(node, context);
    case NodeKind.toolCall: return createToolNode(node, context);
    case NodeKind.compaction: return createCompactionNode(node);
    case NodeKind.modelRetry: return createModelRetryNode(node);
    case NodeKind.turnError: return createTurnErrorNode(node);
    case NodeKind.turnMaxTokens: return createTurnMaxTokensNode(node);
    case NodeKind.command: return createCommandNode(node);
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
