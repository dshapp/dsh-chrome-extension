// 运行状态条:对齐 Mac 的 RunningStatusRow —— 运行中的轮次在输入框上方给出一行
// "正在做哪类工作 · 用时",例如 "正在运行命令 · 1分5秒"。
//
// 它不是记录流里的一行:Mac 把它放在 transcript 列表之外、输入框之上的固定条里,
// 上方运行中的卡片已经点名具体调用,这里只说工作类别。首个 token 之前(还没有任何
// 卡片)它是唯一的运行提示。
import { t } from "../../shared/i18n.js";
import { NodeKind } from "../sessions/chat-nodes.js";
import { formatRunDuration } from "./node-views.js";

/// 工具名 → 工作类别文案 key(Mac ToolRowModel.liveActivity,按 wire 名精确匹配)。
export function liveActivityKey(name) {
  switch (name) {
    case "read": return "activity.read";
    case "read_image": return "activity.readImage";
    case "grep": case "glob": return "activity.search";
    case "write": return "activity.write";
    case "edit": case "apply_patch": return "activity.edit";
    case "bash": case "pwsh": case "exec_command": case "write_stdin": return "activity.commands";
    case "run_code": return "activity.code";
    case "web_search": return "activity.webSearch";
    case "web_fetch": return "activity.webFetch";
    case "todo_write": case "create_goal": case "update_goal": case "get_goal": return "activity.plan";
    case "ask_user_question": case "request_user_input": return "activity.questions";
    default: {
      const n = String(name ?? "");
      if (n.endsWith("_inspect")) return "activity.search";
      if (n.startsWith("terminal_")) return "activity.commands";
      if (n === "subagent" || n.startsWith("subagent_")) return "activity.subagents";
      return "activity.tools";
    }
  }
}

/// 最新一轮里最新的、尚无结果的工具调用名(Mac SessionStore.liveToolName):
/// 只看最新一轮,早先轮次里遗留的未结算调用不算"正在做"。
export function liveToolName(snapshot) {
  if (!snapshot?.running) return null;
  const nodes = snapshot.nodes ?? [];
  let newestTurn = null;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node.turn != null) {
      if (newestTurn == null) newestTurn = node.turn;
      else if (node.turn !== newestTurn) break;
    }
    if (node.kind === NodeKind.toolCall && node.result == null) return node.name ?? null;
  }
  return null;
}

/// 状态条文案:有工具在跑报工作类别,否则 "正在分析请求"(Mac activityThinking)。
/// 返回 null 表示不显示。awaitingTurnStart:已发送、host 还没开轮。
export function runningStatusLabel(snapshot, { awaitingTurnStart = false } = {}) {
  if (!snapshot?.running && !awaitingTurnStart) return null;
  const name = liveToolName(snapshot);
  return t(name ? liveActivityKey(name) : "activity.thinking");
}

/// 挂在 el(#running-status)上的状态条。set(label, startedAt):label 为 null 时隐藏;
/// startedAt 是本轮 turn/start 的时间戳(Mac runningStartTime),没有时不显示用时。
export function mountRunningStatus(el) {
  el.replaceChildren();
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const spinner = document.createElement("span");
  spinner.className = "running-status-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "running-status-label";
  const time = document.createElement("span");
  time.className = "running-status-time";
  time.setAttribute("aria-hidden", "true");
  el.append(spinner, label, time);
  el.hidden = true;

  let startedAt = null;
  let timer = null;

  function paintTime() {
    if (startedAt == null) { time.textContent = ""; return; }
    // 与 web/Mac 一致:下限 1 秒。
    time.textContent = `· ${formatRunDuration(Math.max(1000, Date.now() - startedAt))}`;
  }

  function set(text, start = null) {
    if (text == null) {
      el.hidden = true;
      startedAt = null;
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    if (label.textContent !== text) label.textContent = text;
    startedAt = start ?? null;
    paintTime();
    if (!timer) timer = setInterval(paintTime, 1000);
    el.hidden = false;
  }

  return { set, clear: () => set(null) };
}
