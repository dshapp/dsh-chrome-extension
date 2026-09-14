// 轨迹时间线投影:三车道(输入/模型/工具)的水平概览。
//
// 逻辑对齐 Web packages/client/ui-trajectory/src/client/timeline.ts:
//   - 顺序(sequence):每个可见记录占一个等宽槽位,与时长无关。
//   - 时长(duration):按记录的实际起止时间投影,并压掉空闲间隙。
// 交互形态对齐 macapp Components/Trajectory/TrajectoryTimeline.swift。
import { t } from "../../shared/i18n.js";

/// 时间线投影模式。
export const TimelineMode = Object.freeze({
  sequence: "sequence",
  duration: "duration",
  time: "time",
  actual: "actual"
});

/// 工具栏循环顺序(对齐 Web 两个开关的四种组合)。
export const TIMELINE_MODES = Object.freeze([
  TimelineMode.sequence, TimelineMode.duration, TimelineMode.time, TimelineMode.actual
]);

/// 下一个模式(工具栏单击轮换)。
export function nextTimelineMode(mode) {
  const index = TIMELINE_MODES.indexOf(mode);
  return TIMELINE_MODES[(index < 0 ? 0 : index + 1) % TIMELINE_MODES.length];
}

/// 车道序号(自上而下)。
export const TimelineLane = Object.freeze({
  input: 0,
  model: 1,
  tools: 2
});

/// 记录类型 → 车道。对齐 Web timeline.ts 的 laneFor。
export function laneFor(kind) {
  if (kind === "tool" || kind === "subtool") return TimelineLane.tools;
  if (kind === "assistant" || kind === "compacted") return TimelineLane.model;
  return TimelineLane.input;
}

function finite(value) {
  return value != null && Number.isFinite(value);
}

/// 记录的实际时间区间(毫秒);没有起始时间时返回 null。
function cellRange(record) {
  if (!finite(record.startedAt)) return null;
  const durationMs = finite(record.durationSeconds)
    ? Math.max(0, record.durationSeconds * 1000)
    : 0;
  return { start: record.startedAt, end: record.startedAt + durationMs };
}

function spanOf(record) {
  const typing = assistantTiming(record);
  return {
    id: record.id,
    kind: record.kind,
    lane: laneFor(record.kind),
    label: record.text ?? "",
    isError: record.status === "error",
    startedAt: finite(record.startedAt) ? record.startedAt : null,
    durationMs: finite(record.durationSeconds)
      ? Math.max(0, record.durationSeconds * 1000)
      : null,
    ...typing
  };
}

/// 助手计时:TTFT 与解码时长(以及 TTFT 在整段里的比例,供双色段用)。
function assistantTiming(record) {
  const timing = record.timing;
  if (!timing
    || !finite(timing.stepStartedAt)
    || !finite(timing.firstTokenAt)
    || !finite(timing.completedAt)
    || timing.firstTokenAt < timing.stepStartedAt
    || timing.completedAt < timing.firstTokenAt) return {};
  const ttftMs = timing.firstTokenAt - timing.stepStartedAt;
  const decodingMs = timing.completedAt - timing.firstTokenAt;
  const total = ttftMs + decodingMs;
  return {
    ttftMs,
    decodingMs,
    ttftFraction: total > 0 ? ttftMs / total : null
  };
}

/// 顺序投影:每个记录一个等宽槽位。
function deriveSequence(turns) {
  const spans = [];
  const turnBoundaries = [];
  for (const turn of turns) {
    const records = turn.groups
      .flatMap((group) => group.records)
      .filter((record) => record.requestOnly !== true);
    if (records.length === 0) continue;
    const base = spans.length;
    if (turn.turn != null) turnBoundaries.push({ turn: turn.turn, time: base });
    records.forEach((record, offset) => {
      const order = base + offset;
      spans.push({ ...spanOf(record), order, start: order, end: order + 1 });
    });
  }
  if (spans.length === 0) return null;
  return { start: 0, end: spans.length, spans, turnBoundaries };
}

/// 计时投影:按实际起止时间;actualDuration=false 时记录只落一个开始标记,
/// compressIdle=true 时压掉操作之间的空闲间隙。
function deriveTimed(turns, actualDuration, compressIdle) {
  const collected = [];
  for (const turn of turns) {
    const raw = turn.groups
      .flatMap((group) => group.records)
      .filter((record) => record.requestOnly !== true)
      .map((record) => {
        const range = cellRange(record);
        return range === null ? null : { ...range, record };
      })
      .filter(Boolean);
    if (raw.length) collected.push({ turn: turn.turn, raw });
  }
  const allRaw = collected.flatMap((entry) => entry.raw);
  if (allRaw.length === 0) return null;

  // 空闲压缩:按开始时间排序,记录每个跨度之前被移除的空闲总量。
  const removedBySpan = new Map();
  let removedIdle = 0;
  let coveredUntil = null;
  for (const span of [...allRaw].sort((left, right) =>
    left.start - right.start || left.end - right.end)) {
    if (compressIdle && coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans = [];
  const turnBoundaries = [];
  let order = 0;
  for (const entry of collected) {
    const projected = entry.raw.map((span) => {
      const offset = removedBySpan.get(span) ?? 0;
      return {
        ...spanOf(span.record),
        order: order++,
        start: span.start - offset,
        end: (actualDuration ? span.end : span.start) - offset
      };
    });
    spans.push(...projected);
    if (entry.turn != null) {
      turnBoundaries.push({
        turn: entry.turn,
        time: Math.min(...projected.map((span) => span.start))
      });
    }
  }
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries
  };
}

/// 记录集 → 时间线模型;没有任何可投影记录时返回 null。
export function deriveTrajectoryTimeline(turns, mode = TimelineMode.sequence) {
  if (mode === TimelineMode.duration) return deriveTimed(turns, true, true);
  if (mode === TimelineMode.time) return deriveTimed(turns, false, false);
  if (mode === TimelineMode.actual) return deriveTimed(turns, true, false);
  return deriveSequence(turns);
}

/// 落在选中区间内的记录 id(闭区间;顺序模式下区间是槽位号)。
export function timelineFocusIds(model, range) {
  if (!model || !range) return new Set();
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const result = new Set();
  for (const span of model.spans) {
    if (span.start <= end && span.end >= start) result.add(span.id);
  }
  return result;
}

/// 时间线模式的本地化名称。
export function timelineModeLabel(mode) {
  if (mode === TimelineMode.duration) return t("trajectory.timelineModeDuration");
  if (mode === TimelineMode.time) return t("trajectory.timelineModeTime");
  if (mode === TimelineMode.actual) return t("trajectory.timelineModeActual");
  return t("trajectory.timelineModeSequence");
}

/// 毫秒 → 与台账一致的整毫秒标签。
export function formatTimelineOffset(milliseconds) {
  if (!finite(milliseconds)) return "";
  return `${Math.round(milliseconds)} ms`;
}

/// 墙钟时间 → HH:mm:ss.SSS。
export function formatClock(timestamp) {
  if (!finite(timestamp)) return "";
  const date = new Date(timestamp);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
