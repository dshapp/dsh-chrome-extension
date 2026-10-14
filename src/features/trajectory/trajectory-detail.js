// 轨迹记录详情:复用聊天区唯一的展开出口 card-detail 模态。
// 区段按 Mac TrajectoryInspector 的 TrajectoryInspectionSection 口径组织,
// 重内容(系统提示词 60KB、工具输出)只在 build() 惰性物化,关闭即销毁。
import { t } from "../../shared/i18n.js";
import { openCardDetail } from "../chat/card-detail.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/// 秒 → 人读时长(与台账行/详情共用)。
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const ms = Math.max(0, Math.round(seconds * 1000));
  if (ms < 1000) return `${ms}ms`;
  const value = seconds;
  if (value < 60) return `${(Math.round(value * 10) / 10).toFixed(1)}s`;
  const total = Math.round(value);
  return `${Math.floor(total / 60)}m${total % 60}s`;
}

function formatClock(time) {
  if (!Number.isFinite(time)) return "—";
  try { return new Date(time).toLocaleTimeString(); } catch { return String(time); }
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

const KIND_LABEL = {
  system: "trajectory.kindSystem",
  user: "trajectory.kindUser",
  context: "trajectory.kindContext",
  compacted: "trajectory.kindCompacted",
  assistant: "trajectory.kindAssistant",
  tool: "trajectory.kindTool",
  subtool: "trajectory.kindSubtool"
};

const STATUS_LABEL = {
  running: "trajectory.statusPending",
  complete: "trajectory.statusCompleted",
  error: "trajectory.statusFailed"
};

export function kindLabel(kind) {
  return t(KIND_LABEL[kind] ?? "trajectory.kindAssistant");
}

export function statusLabel(status) {
  return t(STATUS_LABEL[status] ?? "trajectory.statusCompleted");
}

/// 记录状态:错误优先;未结算的工具/压缩记录仍在进行。
export function recordStatus(record) {
  if (record.isError) return "error";
  if ((record.kind === "tool" || record.kind === "subtool")
    && record.outputDetail == null && record.outputBlocks == null) {
    return "running";
  }
  if (record.kind === "compacted" && record.durationSeconds == null) return "running";
  return "complete";
}

function section(titleKey, body) {
  const wrap = el("section", "trajectory-detail-section");
  wrap.append(el("div", "trajectory-detail-title", t(titleKey)));
  wrap.append(body);
  return wrap;
}

function pre(text) {
  return el("pre", "trajectory-detail-pre", text || "—");
}

function definitionList(rows) {
  const list = el("dl", "trajectory-detail-rows");
  for (const [label, value] of rows) {
    if (value == null || value === "") continue;
    list.append(el("dt", "trajectory-detail-label", label));
    list.append(el("dd", "trajectory-detail-value", value));
  }
  return list;
}

function blocksText(blocks, limit = 20000) {
  if (!blocks?.length) return "";
  const text = blocks.map((block) => {
    if (block.type === "tool-call") return `${block.toolName ?? "tool"}(${block.content ?? ""})`;
    return `[${block.type}] ${block.content ?? ""}`;
  }).join("\n\n");
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function usageRows(usage, prefixKey) {
  if (!usage) return [];
  return [
    [t("trajectory.usageInput"), formatTokens(usage.inputTokens)],
    [t("trajectory.usageCacheRead"), formatTokens(usage.cacheReadTokens)],
    [t("trajectory.usageCacheWrite"), formatTokens(usage.cacheWriteTokens)],
    [t("trajectory.usageOutput"), formatTokens(usage.outputTokens)],
    [t("trajectory.usageReasoning"), formatTokens(usage.reasoningTokens)]
  ];
}

function timingRows(record) {
  const timing = record.timing;
  if (!timing) return [];
  const rows = [];
  if (Number.isFinite(timing.stepStartedAt)) rows.push([t("trajectory.timingStarted"), formatClock(timing.stepStartedAt)]);
  if (Number.isFinite(timing.firstTokenAt) && Number.isFinite(timing.stepStartedAt)) {
    rows.push([t("trajectory.timingTtft"), formatDuration((timing.firstTokenAt - timing.stepStartedAt) / 1000)]);
  }
  if (Number.isFinite(timing.completedAt) && Number.isFinite(timing.firstTokenAt)) {
    rows.push([t("trajectory.timingDecode"), formatDuration((timing.completedAt - timing.firstTokenAt) / 1000)]);
  }
  if (Number.isFinite(record.durationSeconds)) rows.push([t("trajectory.timingTotal"), formatDuration(record.durationSeconds)]);
  const outputTokens = record.usage?.outputTokens;
  const decodeSeconds = Number.isFinite(timing.completedAt) && Number.isFinite(timing.firstTokenAt)
    ? (timing.completedAt - timing.firstTokenAt) / 1000
    : null;
  if (Number.isFinite(outputTokens) && decodeSeconds != null && decodeSeconds > 0) {
    rows.push([t("trajectory.detailThroughput"), t("trajectory.detailTokensPerSecond", { value: (outputTokens / decodeSeconds).toFixed(1) })]);
  }
  return rows;
}

function promptBody(prompt) {
  const wrap = el("div", "trajectory-detail-stack");
  wrap.append(el("div", "trajectory-detail-sub", t("trajectory.detailSystemPrompt")));
  wrap.append(pre(prompt.system));
  wrap.append(el("div", "trajectory-detail-sub", t("trajectory.detailTools")));
  const tools = prompt.tools ?? [];
  if (!tools.length) {
    wrap.append(pre(""));
  } else {
    const list = el("div", "trajectory-detail-tools");
    for (const tool of tools) {
      const row = el("div", "trajectory-tool-row");
      row.append(el("span", "trajectory-tool-name", tool.name ?? ""));
      row.append(el("span", "trajectory-tool-desc", tool.description ?? ""));
      list.append(row);
    }
    wrap.append(list);
  }
  return wrap;
}

function detailBuild({ record, request, requestNumber, stats }) {
  return () => {
    const wrap = el("div", "trajectory-detail");
    const summaryRows = [
      [t("trajectory.detailKind"), kindLabel(record.kind)],
      [t("trajectory.detailTurn"), record.turn == null ? null : String(record.turn)],
      [t("trajectory.detailStep"), record.step == null ? null : String(record.step)],
      [t("trajectory.detailRequest"), requestNumber == null ? null : `#${requestNumber}`],
      [t("trajectory.detailStatus"), statusLabel(recordStatus(record))],
      [t("trajectory.detailCallId"), record.callId ?? null],
      [t("trajectory.detailTool"), record.toolName ?? null],
      [t("trajectory.detailPurpose"), request?.purpose === "compaction" ? t("trajectory.kindCompacted") : (request ? t("trajectory.kindAssistant") : null)],
      [t("trajectory.detailProvider"), request?.provider ?? null],
      [t("trajectory.detailModel"), request?.model ?? null],
      [t("trajectory.detailToolCalls"), stats?.toolCalls == null ? null : String(stats.toolCalls)],
      [t("trajectory.detailSubtoolCalls"), stats?.subtoolCalls == null ? null : String(stats.subtoolCalls)],
      [t("trajectory.detailRetry"), request?.retry == null
        ? null
        : `${t("trajectory.detailScheduled")} ${request.retry}${request.maxRetries == null ? "" : ` / ${request.maxRetries}`}`],
      [t("trajectory.detailRetryDelay"), request?.retryDelayMs == null ? null : formatDuration(request.retryDelayMs / 1000)],
      [t("trajectory.detailResult"), request?.purpose === "compaction"
        ? t("trajectory.detailsCompacted")
        : (request?.resultSeq == null ? null : t("trajectory.detailsAssistantMessage"))],
      [t("trajectory.detailDuration"), formatDuration(record.durationSeconds) || null],
      [t("trajectory.detailError"), record.error?.reason ?? record.error?.code ?? request?.error ?? null]
    ];
    wrap.append(definitionList(summaryRows));

    if (record.prompt) wrap.append(section("trajectory.detailPrompt", promptBody(record.prompt)));
    if (record.previousPrompt) {
      wrap.append(section("trajectory.detailPreviousPrompt", promptBody(record.previousPrompt)));
    }
    if (record.inputDetail) wrap.append(section("trajectory.detailPayload", pre(record.inputDetail)));
    if (record.outputDetail) wrap.append(section("trajectory.detailResult", pre(record.outputDetail)));
    else if (record.result) wrap.append(section("trajectory.detailResult", pre(record.result)));
    if (record.thinkingDetail) wrap.append(section("trajectory.detailThinking", pre(record.thinkingDetail)));
    if (record.sourceBlocks?.length) wrap.append(section("trajectory.detailSource", pre(blocksText(record.sourceBlocks))));
    if (record.meta != null) {
      wrap.append(section("trajectory.detailMetadata", pre(JSON.stringify(record.meta, null, 2))));
    }
    if (record.toolSchema) {
      wrap.append(section("trajectory.detailSchema", pre(JSON.stringify(record.toolSchema.raw, null, 2))));
    }
    const timing = timingRows(record);
    if (timing.length) wrap.append(section("trajectory.detailTiming", definitionList(timing)));
    const usage = usageRows(record.usage);
    if (usage.length) wrap.append(section("trajectory.detailUsage", definitionList(usage)));
    const cumulative = usageRows(request?.cumulativeUsage);
    if (cumulative.length) wrap.append(section("trajectory.detailCumulativeUsage", definitionList(cumulative)));
    return wrap;
  };
}

function copyTextFor(record, request) {
  return () => record.outputDetail || record.inputDetail || record.prompt?.system
    || record.thinkingDetail || blocksText(record.sourceBlocks) || request?.error || record.text || "";
}

/// 打开一条轨迹记录的详情模态。
export function openRecordDetail({ record, request, requestNumber, index, stats = null }) {
  const title = [
    index == null ? null : `#${index}`,
    kindLabel(record.kind),
    record.toolName || record.text || ""
  ].filter(Boolean).join(" · ");
  return openCardDetail({
    title,
    build: detailBuild({ record, request, requestNumber, stats }),
    copyText: copyTextFor(record, request)
  });
}
