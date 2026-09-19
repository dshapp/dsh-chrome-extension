// 轨迹时间线视图:车道标签 + 三车道色块 + 轮次分界 + 悬停读数 + 拖选 + 缩放/平移。
//
// 视觉对齐 Web TrajectoryTimeline.module.css(50px 高、44px 标签列、8px 色块),
// 交互对齐 Web TrajectoryTimeline.tsx 与 macapp TrajectoryTimeline.swift:
//   滚轮缩放时间域、右键拖拽平移、右键单击/双击/Esc 复位、拖选聚焦、
//   边缘自动滚动、悬停竖线与 500ms 读数、assistant TTFT/解码双色段。
import { t } from "../../shared/i18n.js";
import { kindLabel } from "./trajectory-detail.js";
import {
  TimelineMode, deriveTrajectoryTimeline, timelineFocusIds,
  timelineModeLabel, nextTimelineMode, formatTimelineOffset, formatClock
} from "./trajectory-timeline.js";

const MINIMUM_DRAG_PX = 3;
const TOOLTIP_DELAY_MS = 500;
const ZOOM_SENSITIVITY = 0.0015;
const MIN_ZOOM_OPERATIONS = 4;
const MIN_ZOOM_MILLISECONDS = 20;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_MAX_PX = 32;
const EDGE_PAN_STEP_FRACTION = 0.025;
const EDGE_PAN_INTERVAL_MS = 30;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function finite(value) {
  return value != null && Number.isFinite(value);
}

function clampFraction(value) {
  return Math.min(1, Math.max(0, value));
}

/// 记录 → 一行的可读读数(kind + 文本摘要)。
function spanHeading(span) {
  const kind = kindLabel(span.kind);
  const label = (span.label ?? "").trim();
  return label ? `${kind} · ${label.slice(0, 60)}` : kind;
}

/// 挂载时间线。调用方提供数据、选中回调与"聚焦台账行"回调。
export function mountTrajectoryTimeline({ section, hasMore, onLoadEarlier, onSelect, onFocus }) {
  if (!section) {
    return {
      render() {}, relabel() {}, toggleMode() {}, reset() {}, getMode: () => TimelineMode.sequence,
      focusedIds: () => null, clearRange() {}, isAvailable: () => false
    };
  }
  const track = section.querySelector(".trajectory-timeline-track");
  const labelNodes = [...section.querySelectorAll(".trajectory-timeline-labels span")];
  const lanes = section.querySelector(".trajectory-timeline-lanes");
  const boundaries = section.querySelector(".trajectory-timeline-boundaries");
  const selection = section.querySelector(".trajectory-timeline-selection");
  const hoverLine = section.querySelector(".trajectory-timeline-hover-line");
  const tooltip = section.querySelector(".trajectory-timeline-tooltip");
  const earlier = section.querySelector(".trajectory-timeline-earlier");

  let mode = TimelineMode.sequence;
  let viewport = null;         // null = 全域名
  let range = null;            // 已提交的框选
  let draft = null;            // 拖拽中的框选
  let selectedId = null;
  let searchMatches = null;
  let model = null;
  let lastSignature = null;
  let drag = null;             // 左键拖选
  let pan = null;              // 右键平移
  let edgeTimer = null;
  let edgeHint = null;         // {dir, strength, clientX}
  let suppressClick = false;
  let tooltipTimer = null;
  let focusedIdsSet = new Set();

  // ── 域几何 ──
  function fullDuration() { return model ? Math.max(1, model.end - model.start) : 1; }
  function viewportDuration() {
    if (!viewport) return fullDuration();
    return Math.min(fullDuration(), Math.max(1, viewport.end - viewport.start));
  }
  function domainStart() {
    if (!model) return 0;
    if (!viewport) return model.start;
    return Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration());
  }
  function domainDuration() { return model ? (viewport ? viewportDuration() : fullDuration()) : 1; }
  function fraction(value) { return (value - domainStart()) / domainDuration(); }
  function timeAtFraction(f) { return domainStart() + clampFraction(f) * domainDuration(); }

  function trackFraction(event) {
    const rect = track?.getBoundingClientRect?.();
    if (!rect || !rect.width) return 0;
    return clampFraction((event.clientX - rect.left) / rect.width);
  }

  function laneTexts() {
    const texts = [t("trajectory.laneInput"), t("trajectory.laneModel"), t("trajectory.laneTools")];
    labelNodes.forEach((node, index) => { node.textContent = texts[index] ?? ""; });
  }

  // ── 缩放 / 平移 ──
  function setViewport(next) {
    if (!next || next.end - next.start >= fullDuration() * 0.999) viewport = null;
    else viewport = next;
    renderCurrent();
  }

  function panBy(deltaFraction) {
    if (!model) return;
    const duration = viewportDuration();
    if (duration >= fullDuration()) return;
    const start = Math.min(
      Math.max(domainStart() - deltaFraction * duration, model.start),
      model.end - duration
    );
    viewport = { start, end: start + duration };
    renderCurrent();
  }

  function onWheel(event) {
    if (!model) return;
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    const anchor = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
    const full = fullDuration();
    const minimum = Math.min(mode === TimelineMode.sequence ? MIN_ZOOM_OPERATIONS : MIN_ZOOM_MILLISECONDS, full);
    const next = Math.min(full, Math.max(minimum, domainDuration() * Math.exp(event.deltaY * ZOOM_SENSITIVITY)));
    if (next >= full * 0.999) { setViewport(null); return; }
    const anchorTime = domainStart() + anchor * domainDuration();
    const start = Math.min(Math.max(anchorTime - anchor * next, model.start), model.end - next);
    setViewport({ start, end: start + next });
  }

  // ── 框选 ──
  function minimumSelectionDuration() {
    if (!model || model.spans.length === 0) return 0;
    return Math.min(domainDuration(), fullDuration() / model.spans.length);
  }

  function centeredRange(center, width) {
    const minimum = model ? model.start : 0;
    const maximum = model ? Math.max(model.start, model.end) : 0;
    const clamped = Math.min(maximum - minimum, Math.max(0, width));
    const start = Math.min(Math.max(center - clamped / 2, minimum), Math.max(minimum, maximum - clamped));
    return { start, end: start + clamped };
  }

  function commitRange(next) {
    range = next;
    draft = null;
    lastSignature = null;
    renderCurrent();
  }

  function clearRange() {
    if (range == null && draft == null) return;
    range = null;
    draft = null;
    lastSignature = null;
    renderCurrent();
  }

  function resetAll() {
    range = null;
    draft = null;
    viewport = null;
    lastSignature = null;
    renderCurrent();
  }

  // ── 拖拽(左选/右移)与边缘滚动 ──
  function beginDrag(event) {
    if (!model) return;
    if (event.button === 2) {
      const duration = viewportDuration();
      if (duration >= fullDuration()) return;
      pan = { anchorX: event.clientX, moved: false };
      return;
    }
    if (event.button != null && event.button !== 0) return;
    drag = { anchorX: event.clientX, anchor: timeAtFraction(trackFraction(event)), moved: false };
  }

  function stopEdgeScroll() {
    if (edgeTimer != null) { clearInterval(edgeTimer); edgeTimer = null; }
    edgeHint = null;
  }

  function startEdgeScroll() {
    if (edgeTimer != null) return;
    edgeTimer = setInterval(() => {
      if (!drag || !drag.moved || edgeHint == null || !model) { stopEdgeScroll(); return; }
      panBy(edgeHint.dir * EDGE_PAN_STEP_FRACTION * edgeHint.strength);
      draft = { start: drag.anchor, end: timeAtFraction(trackFraction({ clientX: edgeHint.clientX })) };
      renderCurrent();
    }, EDGE_PAN_INTERVAL_MS);
  }

  function updateEdgeHint(event) {
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const zone = Math.min(EDGE_PAN_MAX_PX, rect.width * EDGE_PAN_ZONE_FRACTION);
    if (zone <= 0) return;
    const fromLeft = event.clientX - rect.left;
    const fromRight = rect.right - event.clientX;
    if (fromLeft < zone) edgeHint = { dir: -1, strength: Math.min(1, (zone - fromLeft) / zone), clientX: event.clientX };
    else if (fromRight < zone) edgeHint = { dir: 1, strength: Math.min(1, (zone - fromRight) / zone), clientX: event.clientX };
    else edgeHint = null;
    if (edgeHint) startEdgeScroll(); else stopEdgeScroll();
  }

  function moveDrag(event) {
    if (pan) {
      const deltaX = event.clientX - pan.anchorX;
      if (!pan.moved && Math.abs(deltaX) < MINIMUM_DRAG_PX) return;
      pan.moved = true;
      suppressClick = true;
      panBy(-deltaX / Math.max(1, track?.getBoundingClientRect?.().width ?? 1));
      pan.anchorX = event.clientX;
      return;
    }
    if (!drag || !model) return;
    if (!drag.moved && Math.abs(event.clientX - drag.anchorX) < MINIMUM_DRAG_PX) return;
    drag.moved = true;
    suppressClick = true;
    draft = { start: drag.anchor, end: timeAtFraction(trackFraction(event)) };
    updateEdgeHint(event);
    renderCurrent();
  }

  function endDrag(event) {
    stopEdgeScroll();
    if (pan) {
      const moved = pan.moved;
      pan = null;
      if (!moved) { clearRange(); suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
      return;
    }
    if (!drag) return;
    const moved = drag.moved;
    const anchor = drag.anchor;
    drag = null;
    if (moved) {
      const width = Math.max(minimumSelectionDuration(), Math.abs(timeAtFraction(trackFraction(event)) - anchor));
      commitRange(centeredRange((anchor + timeAtFraction(trackFraction(event))) / 2, width));
      setTimeout(() => { suppressClick = false; }, 0);
      return;
    }
    suppressClick = false;
    if (event.target?.closest?.(".trajectory-timeline-span")) return;
    const nearest = nearestSpan(trackFraction(event));
    if (nearest) onFocus?.(nearest.id);
  }

  function nearestSpan(fractionValue) {
    if (!model || model.spans.length === 0) return null;
    const time = timeAtFraction(fractionValue);
    let best = null;
    let bestDistance = Infinity;
    for (const span of model.spans) {
      const distance = time < span.start ? span.start - time : time > span.end ? time - span.end : 0;
      if (distance < bestDistance) { bestDistance = distance; best = span; }
    }
    return best;
  }

  // ── 悬停竖线与读数 ──
  function hideHoverLine() {
    if (hoverLine) hoverLine.hidden = true;
  }

  function updateHoverLine(event) {
    if (!hoverLine || !model || drag || pan) return;
    const overSpan = event.target?.closest?.(".trajectory-timeline-span");
    if (overSpan) { hideHoverLine(); return; }
    hoverLine.style.left = `${(trackFraction(event) * 100).toFixed(4)}%`;
    hoverLine.hidden = false;
  }

  function hideTooltip() {
    if (tooltipTimer != null) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    if (tooltip) tooltip.hidden = true;
  }

  function showTooltip(span, node) {
    node.classList.add("hovered");
    if (!tooltip) return;
    hideTooltip();
    tooltipTimer = setTimeout(() => {
      tooltipTimer = null;
      const lines = [spanHeading(span)];
      if (span.durationMs != null) lines.push(t("trajectory.timelineTotal", { duration: formatTimelineOffset(span.durationMs) }));
      else if (span.startedAt != null) lines.push(t("trajectory.timelineStarted", { time: formatClock(span.startedAt) }));
      if (finite(span.ttftMs) && finite(span.decodingMs)) {
        lines.push(t("trajectory.timelineTtftDecoding", {
          ttft: formatTimelineOffset(span.ttftMs),
          decoding: formatTimelineOffset(span.decodingMs)
        }));
      }
      if (span.startedAt != null) {
        const end = span.durationMs == null ? null : span.startedAt + span.durationMs;
        lines.push(end == null
          ? `${formatClock(span.startedAt)}`
          : `${formatClock(span.startedAt)} → ${formatClock(end)}`);
      }
      tooltip.replaceChildren(...lines.map((line, index) => el("div", index === 0 ? "trajectory-timeline-tip-title" : "trajectory-timeline-tip-line", line)));
      const center = fraction((span.start + span.end) / 2);
      tooltip.style.left = `clamp(0px, calc(${(center * 100).toFixed(4)}% - 60px), calc(100% - 120px))`;
      tooltip.hidden = false;
    }, TOOLTIP_DELAY_MS);
  }

  // ── 绘制 ──
  function paintSelection() {
    if (!selection) return;
    const active = draft ?? range;
    if (!model || !active) { selection.hidden = true; return; }
    const left = Math.min(fraction(active.start), fraction(active.end));
    const right = Math.max(fraction(active.start), fraction(active.end));
    selection.style.left = `${(left * 100).toFixed(4)}%`;
    selection.style.width = `${(Math.max(0, right - left) * 100).toFixed(4)}%`;
    selection.dataset.dragging = draft != null ? "true" : "false";
    selection.hidden = false;
  }

  function paintSpans() {
    if (!lanes) return;
    for (const node of lanes.children) {
      const id = node.dataset.id;
      const focused = range == null || focusedIdsSet.has(id);
      node.classList.remove("hovered");
      node.classList.toggle("selected", id === selectedId);
      node.classList.toggle("dimmed", searchMatches != null && !searchMatches.has(id));
      node.classList.toggle("out-of-focus", !focused);
    }
  }

  function updateAria() {
    if (!track) return;
    track.setAttribute("aria-label", t("trajectory.timelineOverviewAria"));
    if (!model) return;
    const visible = viewport == null ? model.start : domainStart();
    track.setAttribute("aria-valuetext", `visible=${Math.round(visible)};domain=${Math.round(model.start)}-${Math.round(model.end)}`);
  }

  /// 用当前状态重绘(拖拽/缩放/选择都走这里)。
  function renderCurrent() {
    render(lastInput);
  }

  let lastInput = {};

  function render({ turns, searchMatches: matches = null, selectedId: nextSelected = null } = {}) {
    lastInput = { turns, searchMatches: matches, selectedId: nextSelected };
    laneTexts();
    selectedId = nextSelected;
    searchMatches = matches;
    model = deriveTrajectoryTimeline(turns ?? [], mode);
    // 域变了:越界的视口/选择要 clamp 或重置。
    if (model) {
      if (viewport && (viewport.end < model.start || viewport.start > model.end)) viewport = null;
      if (range && (range.end < model.start || range.start > model.end)) range = null;
      if (draft && (draft.end < model.start || draft.start > model.end)) draft = null;
    } else {
      viewport = null;
    }
    focusedIdsSet = range == null || !model ? new Set() : timelineFocusIds(model, range);

    if (earlier) {
      const atStart = !model || domainStart() <= model.start + 1e-6;
      earlier.hidden = !(hasMore?.() === true && atStart);
      earlier.setAttribute("aria-label", t("trajectory.loadEarlier"));
      earlier.setAttribute("aria-disabled", String(earlier.disabled));
    }

    const signature = [
      mode,
      model?.spans.map((span) => span.id).join("|") ?? "",
      model?.turnBoundaries.length ?? 0,
      searchMatches == null ? "all" : [...searchMatches].sort().join(","),
      selectedId ?? "",
      range ? `${range.start}:${range.end}` : "",
      draft ? `d${draft.start}:${draft.end}` : "",
      viewport ? `v${viewport.start}:${viewport.end}` : "full"
    ].join("\u0000");
    if (signature === lastSignature) { updateAria(); return; }
    lastSignature = signature;

    if (track) {
      track.classList.toggle("empty", model === null);
      track.dataset.empty = t("trajectory.timelineNoData");
    }
    if (lanes) lanes.replaceChildren();
    if (boundaries) boundaries.replaceChildren();
    hideHoverLine();

    if (!model) {
      hideTooltip();
      paintSelection();
      updateAria();
      return;
    }
    const duration = domainDuration();
    if (boundaries) {
      for (const boundary of model.turnBoundaries) {
        if (boundary.time <= domainStart()) continue;
        const line = el("div", "trajectory-timeline-boundary");
        line.style.left = `${(fraction(boundary.time) * 100).toFixed(4)}%`;
        boundaries.append(line);
      }
    }
    if (lanes) {
      for (const span of model.spans) {
        if (span.end < domainStart() || span.start > domainStart() + duration) continue;
        const node = el("button", `trajectory-timeline-span kind-${span.kind} lane-${span.lane}`);
        node.type = "button";
        node.dataset.id = span.id;
        node.dataset.order = String(span.order);
        if (span.isError) node.classList.add("status-error");
        if (span.end <= span.start) node.classList.add("marker");
        if (finite(span.ttftFraction)) {
          node.classList.add("has-timing");
          node.style.setProperty("--trajectory-assistant-ttft", `${(span.ttftFraction * 100).toFixed(2)}%`);
        }
        node.style.left = `${(fraction(span.start) * 100).toFixed(4)}%`;
        node.style.width = `calc(${(((span.end - span.start) / duration) * 100).toFixed(4)}% - 1px)`;
        node.setAttribute("aria-label", spanHeading(span));
        node.addEventListener("pointerenter", () => showTooltip(span, node));
        node.addEventListener("pointerleave", () => { node.classList.remove("hovered"); hideTooltip(); });
        node.addEventListener("click", () => { if (!suppressClick) onSelect?.(span.id); });
        lanes.append(node);
      }
    }
    paintSpans();
    paintSelection();
    updateAria();
  }

  /// 手势的中止路径:停掉边缘滚动并丢掉拖拽/平移状态。
  function cancelDrag() {
    stopEdgeScroll();
    drag = null;
    pan = null;
    hideHoverLine();
  }

  track?.addEventListener("pointerdown", beginDrag);
  track?.addEventListener("pointermove", (event) => { moveDrag(event); updateHoverLine(event); });
  track?.addEventListener("pointerup", endDrag);
  track?.addEventListener("pointercancel", cancelDrag);
  // 指针不必在轨道上抬起:拖到边缘后把鼠标移出去再松手,pointerup 会落在别的
  // 元素上(pointerleave 在拖拽中又刻意 return),只监听 track 就会漏掉收尾 ——
  // 30ms 的边缘滚动定时器会一直跑下去,时间线在松手后继续自己漂移。
  // 文档级兜底;轨道上的那次已经处理过时,drag/pan 为空,这里直接跳过。
  document.addEventListener("pointerup", (event) => { if (drag || pan) endDrag(event); });
  document.addEventListener("pointercancel", () => { if (drag || pan) cancelDrag(); });
  track?.addEventListener("pointerleave", (event) => {
    if (drag || pan) return;
    hideHoverLine();
    if (!event.target?.closest?.(".trajectory-timeline-span")) hideTooltip();
  });
  track?.addEventListener("contextmenu", (event) => event.preventDefault());
  track?.addEventListener("dblclick", () => resetAll());
  track?.addEventListener("wheel", onWheel, { passive: false });
  track?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    resetAll();
  });
  earlier?.addEventListener("click", () => {
    if (!onLoadEarlier || earlier.disabled) return;
    earlier.disabled = true;
    earlier.setAttribute("aria-disabled", "true");
    Promise.resolve(onLoadEarlier()).finally(() => {
      earlier.disabled = false;
      earlier.setAttribute("aria-disabled", "false");
      lastSignature = null;
      renderCurrent();
    });
  });
  const onKeydown = (event) => { if (event.key === "Escape") clearRange(); };
  document.addEventListener("keydown", onKeydown);
  if (track) track.tabIndex = 0;

  return {
    render,
    relabel() {
      laneTexts();
      lastSignature = null;
      renderCurrent();
    },
    toggleMode() {
      mode = nextTimelineMode(mode);
      range = null;
      draft = null;
      viewport = null;
      lastSignature = null;
      return mode;
    },
    getMode: () => mode,
    modeLabel: () => timelineModeLabel(mode),
    focusedIds: () => (range == null ? null : new Set(focusedIdsSet)),
    clearRange,
    reset: resetAll,
    isAvailable: () => true
  };
}
