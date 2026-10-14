// 工具行模型派生。对齐 macos/Sources/DSHMacKit/Components/Tools/ToolRow.swift 的 toolRowModel。
//
// 折叠行只显示一行文字,所以"显示什么"全在这里决定:variant 分类 → summary 派生 →
// verdict 阶梯(todo/ask/plan 这几个自带结论的行)→ 错误态判定。

import { t } from "../../shared/i18n.js";
import { ToolRowState } from "../sessions/chat-nodes.js";

export const ToolVariant = Object.freeze({
  bash: "bash", read: "read", search: "search", write: "write",
  edit: "edit", code: "code", others: "others"
});

/// 工具名 → variant。**精确匹配**(按 wire name),这样 `cordis_bash` 这类名字
/// 不会误蹭上 bash 的摘要规则。
const TOOL_VARIANTS = Object.freeze({
  bash: ToolVariant.bash,
  // PowerShell 孪生体也是 shell 工具:走 bash 行家族(图标、配色)。
  pwsh: ToolVariant.bash,
  read: ToolVariant.read,
  read_image: ToolVariant.read,
  web_fetch: ToolVariant.read,
  web_search: ToolVariant.search,
  grep: ToolVariant.search,
  glob: ToolVariant.search,
  write: ToolVariant.write,
  edit: ToolVariant.edit,
  run_code: ToolVariant.code,
  cordis_package_inspect: ToolVariant.read,
  cordis_runtime_inspect: ToolVariant.read,
  // 三个运行控制动词吃一个包 id、产出一张回执,所以泛化行是"决定"而非"未分类默认"。
  cordis_run: ToolVariant.others,
  cordis_stop: ToolVariant.others,
  cordis_undefine: ToolVariant.others
});

/// summary 由专门的 keyed 行撰写的 others 工具:摘要已经读起来像句子,
/// 泛化 others 规则不能再把工具名前缀拼上去。
const KEYED_ROW_TOOLS = new Set([
  "cordis_run", "cordis_stop", "cordis_undefine",
  "skill", "todo_write", "ask_user_question", "exit_plan_mode"
]);

/// 每个 variant 的摘要取值优先级(取自参数)。
const SUMMARY_KEYS = Object.freeze({
  [ToolVariant.bash]: ["description", "command"],
  [ToolVariant.read]: ["path", "file_path", "url"],
  [ToolVariant.search]: ["query", "pattern", "url"],
  [ToolVariant.write]: ["path", "file_path"],
  [ToolVariant.edit]: ["path", "file_path"],
  [ToolVariant.code]: ["description"],
  [ToolVariant.others]: []
});

/// 摘要可能是可打开的工作区路径的 variant。
const FILE_PATH_VARIANTS = new Set([ToolVariant.read, ToolVariant.write, ToolVariant.edit]);

export function classifyTool(name) {
  return TOOL_VARIANTS[name] ?? ToolVariant.others;
}

/// 文本首行(折叠行只有一行)。
function firstLine(text) {
  const nl = String(text ?? "").indexOf("\n");
  return nl === -1 ? String(text ?? "") : String(text).slice(0, nl);
}

/// 解析参数 JSON;非 JSON(流式截断)返回 null。
const CONTENT_FIELDS = ["content", "old_string", "new_string"];

// Scan only the argument head: a multi-MB write must not reparse every token.
export function preparingArguments(name, raw = "") {
  const head = raw.slice(0, 8192);
  const partialString = (key) => {
    const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(head);
    if (!match) return null;
    const start = match.index + match[0].length;
    let i = start;
    for (; i < head.length; i++) {
      if (head[i] === "\\") { i++; continue; }
      if (head[i] === '"') break;
    }
    const complete = i < head.length;
    let encoded = head.slice(start, i);
    if (!complete) {
      encoded = encoded.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
    }
    try { return { value: JSON.parse(`"${encoded}"`), complete }; } catch { return null; }
  };
  const variant = classifyTool(name);
  const path = FILE_PATH_VARIANTS.has(variant) ? partialString("file_path") ?? partialString("path") : null;
  const summary = path?.complete ? firstLine(path.value)
    : FILE_PATH_VARIANTS.has(variant) ? "" : firstLine(partialString("description")?.value ?? "");
  const kilobytes = (variant === ToolVariant.write || variant === ToolVariant.edit)
    && CONTENT_FIELDS.some((key) => new RegExp(`"${key}"\\s*:`).test(head))
    ? Math.ceil(raw.length / 1024) : null;
  return { summary, filePath: path?.complete ? firstLine(path.value) : null, kilobytes };
}

function contentKilobytes(args) {
  const values = CONTENT_FIELDS.map((key) => args?.[key]).filter((value) => typeof value === "string");
  return values.length ? Math.ceil(values.reduce((size, value) => size + value.length, 0) / 1024) : null;
}

function recordedFilePath(path, node) {
  if (!path) return null;
  const recorded = node.result?.meta?.path;
  if (typeof recorded === "string" && /^(\/|[a-zA-Z]:[\\/])/.test(recorded)) return recorded;
  if (/^(\/|~|[a-zA-Z]:[\\/])/.test(path)) return path;
  // No guessed local links for running/failed/nested relative calls without metadata.
  return node.result && !node.result.isError && !node.parentCallId ? path : null;
}

export function parseArgs(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const value = JSON.parse(raw);
    return value != null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function pickString(args, keys) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/// 按 variant 派生参数摘要。
function deriveSummary(variant, argsRaw, args) {
  if (!argsRaw) return "";
  if (args) {
    // web_search 吃的是一批查询:每条都是这行要报告的内容,所以合并而非用第一条代表全部。
    if (variant === ToolVariant.search && Array.isArray(args.queries)) {
      const texts = args.queries.filter((q) => typeof q === "string" && q).map(firstLine);
      if (texts.length) return texts.join(", ");
    }
    const picked = pickString(args, SUMMARY_KEYS[variant] ?? []);
    if (picked) return firstLine(picked);
    for (const value of Object.values(args)) {
      if (typeof value === "string" && value) return firstLine(value);
    }
  }
  return firstLine(argsRaw);
}

function deriveFilePath(variant, args) {
  if (!FILE_PATH_VARIANTS.has(variant) || !args) return null;
  const picked = pickString(args, ["path", "file_path"]);
  return picked ? firstLine(picked) : null;
}

/// 已结算的终端结果视图是否报告了失败退出——非零 exitCode 或终止信号。
/// bash 把失败命令结算为**完成**的调用(isError 保持 false:退出码是结果数据),
/// 所以这是折叠行唯一的失败信号。
function terminalFailed(resultView) {
  if (!resultView || resultView.card !== "terminal") return false;
  if (typeof resultView.exitCode === "number" && resultView.exitCode !== 0) return true;
  if (typeof resultView.signal === "string" && resultView.signal) return true;
  return false;
}

/// 已结算结果的内容块摊平成显示文本:文本块原样,其他块形状转 JSON。
/// 失败调用的空内容回退到结构化错误的 `name: code` 行。
export function resultText(result) {
  const parts = [];
  for (const block of result.content ?? []) {
    if (block?.type === "text") parts.push(block.text ?? "");
    else {
      try { parts.push(JSON.stringify(block)); } catch { /* 跳过不可序列化块 */ }
    }
  }
  if (!parts.length && result.error) parts.push(result.error.reason || `${result.error.name}: ${result.error.code}`);
  return parts.join("\n");
}

/// 详情入口只需要知道是否存在可显示文本，不应为此拼接整份工具输出。
export function hasResultText(result) {
  for (const block of result?.content ?? []) {
    if (block?.type === "text") {
      if (block.text) return true;
      continue;
    }
    try {
      if (JSON.stringify(block)) return true;
    } catch { /* 跳过不可序列化块 */ }
  }
  return Boolean(result?.error);
}

/// 已结算结果的首行,不构建整体。
/// 折叠行的错误摘要只要一行,而经由 resultText 会先把所有内容块拼起来——
/// 为了读首行而整份复制一个几 MB 的构建日志,这行既不显示它也不需要它。
function resultFirstLine(result) {
  for (const block of result.content ?? []) {
    if (block?.type === "text") {
      if (!block.text) continue;
      return firstLine(block.text);
    }
    try {
      const s = JSON.stringify(block);
      if (s) return firstLine(s);
    } catch { /* 跳过 */ }
  }
  if (result.error) return firstLine(result.error.reason || `${result.error.name}: ${result.error.code}`);
  return "";
}

/// 搜索结果视图可以在结算时替换标题(命中计数摘要)。
function searchResultTitle(resultView) {
  if (!resultView || resultView.card !== "search") return null;
  return typeof resultView.title === "string" ? resultView.title : null;
}

/// 终端卡片由模型撰写的描述。呈现契约规定它渲染在卡片**上方**,
/// 因此在折叠行上优先级高于参数摘要。运行中由 callView 携带,结算后的 resultView 没有。
function terminalDescription(callView) {
  if (!callView || callView.card !== "terminal") return null;
  return typeof callView.description === "string" ? callView.description : null;
}

/// todo 行的摘要,在省略号边界处切成两段:summary 会被截断,
/// suffix 是并行活跃计数、**不能**被截断——窄行绝不该把"有好几个任务在跑"这一句裁掉。
function todoSummary(argsRaw) {
  const args = parseArgs(argsRaw);
  if (!args || !Array.isArray(args.todos)) return null;
  const todos = args.todos.filter((item) => item && typeof item === "object");
  const active = todos.filter((item) => item.status === "in_progress");
  const done = todos.filter((item) => item.status === "completed").length;
  const head = t("tool.todoCompleted", { done: String(done), total: String(todos.length) });
  const first = active.map((item) => item.content).find((c) => typeof c === "string" && c.trim());
  if (!first) return { summary: head, suffix: null };
  return {
    summary: `${head} · ${first}`,
    suffix: active.length > 1 ? `+${active.length - 1}` : null
  };
}

/// ask 行的交互结论摘要:挂起时"等待回答",结算后给出已答计数,
/// 用户撤销或本轮被打断则各自具名。返回 null 表示沿用泛化摘要。
function askSummary(node) {
  const code = node.result?.error?.code;
  if (code === "ASK_CANCELLED") return t("tool.askCancelled");
  if (code === "ASK_ABORTED") return t("tool.askInterrupted");
  if (!node.result) return t("tool.askWaiting");
  if (node.result.isError) return null;
  const text = (node.result.content ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("");
  const obj = parseArgs(text);
  if (!obj || !Array.isArray(obj.answers)) return null;
  const answered = obj.answers.filter((a) => {
    if (Array.isArray(a?.selected) && a.selected.length) return true;
    if (typeof a?.custom === "string" && a.custom) return true;
    return false;
  }).length;
  return t("tool.askAnswered", { answered: String(answered), total: String(obj.answers.length) });
}

/// exit_plan_mode 行的结论摘要:审阅中显示"等待审阅",批准后显示"计划已批准",
/// 任何错误返回 null(继续规划的反馈、被撤销的审阅、计划模式外的调用),
/// 让共享的错误摘要路径去显示反馈首行。exit_plan_mode 唯一的成功结局就是批准,
/// 所以一个已结算且非错误的调用就是一次批准。
export function planSummary(node) {
  if (!node.result) return t("tool.planAwaitingReview");
  if (node.result.isError) return null;
  return t("tool.planApproved");
}

/// 把绝对路径显示为相对工作区根的路径。
function relativizeToCwd(text, cwd) {
  if (!cwd || !text || !text.startsWith(cwd)) return text;
  const rest = text.slice(cwd.length);
  return rest.startsWith("/") ? rest.slice(1) : (rest || text);
}

/// 残留的 POSIX home 路径显示为 `~`。
function abbreviateHomePath(text, home) {
  if (!home || !text || !text.startsWith(home)) return text;
  return `~${text.slice(home.length)}`;
}

/// 从冻结的调用切片派生完整行模型。
export function toolRowModel(node, { cwd = null, home = null } = {}) {
  const variant = classifyTool(node.name);
  const done = node.result != null;
  if (node.preparing) {
    const partial = preparingArguments(node.name, node.argsRaw);
    const base = abbreviateHomePath(relativizeToCwd(partial.summary, cwd), home);
    const summary = variant === ToolVariant.others && !KEYED_ROW_TOOLS.has(node.name)
      ? [node.name, base].filter(Boolean).join(" · ") : base;
    return { variant, summary,
      filePath: null, state: "preparing", errorSummary: null, output: null,
      summarySuffix: base && partial.kilobytes != null ? t("tool.contentSize", { n: String(partial.kilobytes) }) : null };
  }
  const argsRaw = node.argsRaw ?? "";
  // 解析一次,向下游各处传递。此前每个派生函数各自 parseArgs,
  // 渲染一行要把同一份 JSON 解两三遍。
  const args = argsRaw ? parseArgs(argsRaw) : null;

  // 基础生命周期;keyed 行随后可以细化它(ask 的结论阶梯)。
  let state = !done
    ? ToolRowState.running
    : node.result?.error?.code === "interrupted"
      ? ToolRowState.stopped
      : node.result?.isError
        ? ToolRowState.error
        : ToolRowState.ok;

  let base;
  switch (node.name) {
    case "todo_write": base = todoSummary(argsRaw)?.summary ?? ""; break;
    case "ask_user_question": base = askSummary(node) ?? ""; break;
    case "exit_plan_mode": base = planSummary(node) ?? ""; break;
    default:
      base = abbreviateHomePath(relativizeToCwd(deriveSummary(variant, argsRaw, args), cwd), home);
  }

  // 折叠摘要的优先级:终端卡片的描述(callView)> 搜索结果视图的替换标题 > 参数摘要。
  // 泛化 others 调用把自己的 wire name 带进摘要位(光标图形本身没法命名一个未映射的工具),
  // 除非有 keyed 行直接拥有该摘要。
  const replacement = terminalDescription(node.callView) ?? searchResultTitle(node.result?.resultView);
  const summary = (variant === ToolVariant.others && node.name && !KEYED_ROW_TOOLS.has(node.name))
    ? `${node.name} · ${base}`
    : (replacement ?? base);

  // ask 行的中止结论沿用其他被打断调用的共享 stopped(琥珀)语义。
  if (node.name === "ask_user_question" && node.result?.error?.code === "ASK_ABORTED") {
    state = ToolRowState.stopped;
  }
  const resolvedState = (state === ToolRowState.ok && terminalFailed(node.result?.resultView))
    ? ToolRowState.error
    : state;

  // 直接读结果而不经过 output,这样折叠行永远不会为了显示一行而 materialize 一份大日志。
  const errorSummary = resolvedState === ToolRowState.error && node.result
    ? (resultFirstLine(node.result) || null)
    : null;

  return {
    variant,
    summary,
    filePath: recordedFilePath(deriveFilePath(variant, args), node),
    summarySuffix: errorSummary != null ? null : node.name === "todo_write" ? todoSummary(argsRaw)?.suffix ?? null
      : (variant === ToolVariant.write || variant === ToolVariant.edit) && summary && contentKilobytes(args) != null
        ? t("tool.contentSize", { n: String(contentKilobytes(args)) }) : null,
    // 保留既有模型 API，但把完整输出延迟到真正读取时。折叠行渲染不再复制日志。
    get output() {
      return done && node.result ? (resultText(node.result) || null) : null;
    },
    errorSummary,
    state: resolvedState
  };
}
