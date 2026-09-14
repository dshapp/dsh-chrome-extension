// 轨迹页:工具栏 + 台账(轮次分组、请求编号、折叠、搜索、加载更早)。
//
// 入口与视图形态 = Mac(对话列内切换、保留 composer),台账语义 = Web
// (packages/client/ui-trajectory 的 ledger/layout/folding)。
import { t } from "../../shared/i18n.js";
import { lucideIcon } from "../chat/file-icons.js";
import {
  buildTurns, ledgerRows, visibleRows, collapsibleTurns, assistantIdsWithCalls,
  numberRequests, turnStartRowIds, groupTitle
} from "./trajectory-layout.js";
import { buildSearchMatches } from "./trajectory-search.js";
import { recordSummary, previewText } from "./trajectory-model.js";
import { mountTrajectoryTimeline } from "./trajectory-timeline-view.js";
import { openRecordDetail, kindLabel, statusLabel, recordStatus, formatDuration } from "./trajectory-detail.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/// 折叠按钮 = lucide +/minus 图标 + 文案(替换原先的 ⊞/⊟ 字符)。
function setFoldContent(button, iconName, label) {
  button.replaceChildren(
    lucideIcon(iconName, { size: 13, className: "trajectory-fold-icon" }),
    el("span", "trajectory-fold-label", label)
  );
}

/// 挂载轨迹页。调用方提供数据存取与"加载更早"能力(service 的 loadEarlier)。
export function mountTrajectoryPane({
  pane, ledger, getTrajectory, getSessionId, hasMore, onLoadEarlier, onClose
}) {
  const messages = pane.closest?.("#messages") ?? pane.parentElement;
  const toolbar = pane.querySelector(".trajectory-toolbar");
  const turnsBtn = pane.querySelector('[data-action="turns"]');
  const callsBtn = pane.querySelector('[data-action="calls"]');
  const searchInput = pane.querySelector("#trajectory-search");
  const searchClear = pane.querySelector(".trajectory-search-clear");
  const closeBtn = pane.querySelector(".trajectory-close");
  const earlier = pane.querySelector(".trajectory-load-earlier");
  const earlierBtn = pane.querySelector(".trajectory-load-btn");
  const timelineSection = pane.querySelector("#trajectory-timeline");
  const timelineBtn = pane.querySelector(".trajectory-timeline-mode");

  let open = false;
  let searchQuery = "";
  let loadingEarlier = false;
  const collapsedTurns = new Set();
  const collapsedAssistants = new Set();
  let lastTrajectory = null;
  let lastKey = null;
  let selectedRecordId = null;
  let rowById = new Map();

  const timeline = mountTrajectoryTimeline({
    section: timelineSection,
    hasMore: () => hasMore?.() === true,
    onLoadEarlier,
    onSelect: (id) => openRowById(id)
  });

  function bound(labelKey, ariaKey) {
    const label = t(labelKey);
    const aria = t(ariaKey);
    return { label, aria };
  }

  function paintToolbar() {
    if (toolbar) toolbar.setAttribute("aria-label", t("trajectory.toolbarLabel"));
    if (turnsBtn) {
      const { label, aria } = bound("trajectory.toolbarTurns", "trajectory.toolbarCollapseTurns");
      setFoldContent(turnsBtn, "minus", label);
      turnsBtn.setAttribute("aria-label", aria);
    }
    if (callsBtn) {
      const { label, aria } = bound("trajectory.toolbarCalls", "trajectory.toolbarCollapseCalls");
      setFoldContent(callsBtn, "minus", label);
      callsBtn.setAttribute("aria-label", aria);
    }
    if (searchInput) {
      searchInput.placeholder = t("trajectory.searchPlaceholder");
      searchInput.setAttribute("aria-label", t("trajectory.search"));
    }
    if (searchClear) searchClear.setAttribute("aria-label", t("trajectory.searchClear"));
    if (closeBtn) closeBtn.setAttribute("aria-label", t("trajectory.close"));
    if (earlierBtn) earlierBtn.textContent = loadingEarlier ? t("trajectory.loadingEarlier") : t("trajectory.loadEarlier");
  }

  function paintFoldButtons(turns) {
    const foldable = collapsibleTurns(turns);
    const callFoldable = assistantIdsWithCalls(turns);
    const allTurns = foldable.size > 0 && [...foldable].every((turn) => collapsedTurns.has(turn));
    const allCalls = callFoldable.size > 0 && [...callFoldable].every((id) => collapsedAssistants.has(id));
    if (turnsBtn) {
      setFoldContent(turnsBtn, allTurns ? "plus" : "minus", t("trajectory.toolbarTurns"));
      turnsBtn.setAttribute("aria-label", t(allTurns ? "trajectory.toolbarExpandTurns" : "trajectory.toolbarCollapseTurns"));
      turnsBtn.disabled = foldable.size === 0;
    }
    if (callsBtn) {
      setFoldContent(callsBtn, allCalls ? "plus" : "minus", t("trajectory.toolbarCalls"));
      callsBtn.setAttribute("aria-label", t(allCalls ? "trajectory.toolbarExpandCalls" : "trajectory.toolbarCollapseCalls"));
      callsBtn.disabled = callFoldable.size === 0;
    }
    return { foldable, callFoldable, allTurns, allCalls };
  }

  function rowElement(row, meta) {
    const { indexById, turnStart, callFoldable } = meta;
    const record = row.record;
    if (row.requestBoundary) {
      const boundary = el("div", "trajectory-boundary");
      const number = meta.requestNumber(record);
      const button = el("button", "trajectory-boundary-btn", number == null ? t("trajectory.requestLabel") : `Request #${number}`);
      button.type = "button";
      button.setAttribute("aria-label", number == null ? t("trajectory.requestLabel") : `Request #${number}`);
      button.addEventListener("click", () => openRow(row));
      boundary.append(button);
      return boundary;
    }
    if (row.turnSummary) {
      return el("div", "trajectory-folded-summary", row.turnSummary);
    }
    if (row.assistantSummary) {
      return el("div", "trajectory-folded-summary", row.assistantSummary);
    }
    const status = recordStatus(record);
    const wrap = el("div", `trajectory-row kind-${record.kind} status-${status}`);
    wrap.dataset.id = record.id;
    const top = el("div", "trajectory-row-top");
    if (meta.turnStart.has(row.id) && row.turn != null) {
      const chip = el("button", "trajectory-turn-chip", t("trajectory.turn", { turn: String(row.turn) }));
      chip.type = "button";
      chip.dataset.turn = String(row.turn);
      const folded = collapsedTurns.has(row.turn);
      chip.classList.toggle("folded", folded);
      chip.setAttribute("aria-label", t("trajectory.turnA11y", {
        turn: String(row.turn),
        state: t(folded ? "trajectory.turnFoldedState" : "trajectory.turnExpandedState")
      }));
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        if (collapsedTurns.has(row.turn)) collapsedTurns.delete(row.turn);
        else collapsedTurns.add(row.turn);
        render();
      });
      top.append(chip);
    }
    top.append(el("span", `trajectory-kind kind-${record.kind}`, kindLabel(record.kind)));
    top.append(el("span", "trajectory-summary", recordSummary(record)));
    if (record.kind === "tool" || record.kind === "subtool") {
      const result = record.result || (record.outputDetail ? previewText(record.outputDetail) : "");
      if (result) {
        top.append(el("span", "trajectory-arrow", "→"));
        top.append(el("span", "trajectory-result", result));
      } else if (status === "running") {
        top.append(el("span", "trajectory-arrow", "→"));
        top.append(el("span", "trajectory-result pending", t("trajectory.statusPending")));
      } else {
        top.append(el("span", "trajectory-arrow", "→"));
        top.append(el("span", "trajectory-result pending", t("trajectory.recordNoOutput")));
      }
    }
    const duration = formatDuration(record.durationSeconds);
    if (duration) top.append(el("span", "trajectory-duration", duration));
    wrap.append(top);

    const metaRow = el("div", "trajectory-row-meta");
    metaRow.append(el("span", "trajectory-index", `#${indexById.get(row.id) ?? "?"}`));
    const number = meta.requestNumber(record);
    if (number != null) metaRow.append(el("span", "trajectory-request-dot", `Request #${number}`));
    const dot = el("span", `trajectory-status-dot status-${status}`);
    dot.setAttribute("aria-hidden", "true");
    metaRow.append(dot);
    metaRow.append(el("span", "trajectory-status-word", statusLabel(status)));
    if (row.groupStart !== false) {
      const groupLabel = groupTitle(row.group, { standalone: row.turn == null });
      const groupText = row.groupDescription ? `${groupLabel} · ${row.groupDescription}` : groupLabel;
      metaRow.append(el("span", "trajectory-group", groupText));
    }
    if (callFoldable.has(record.id)) {
      const folded = collapsedAssistants.has(record.id);
      const fold = el("button", "trajectory-call-fold");
      fold.append(lucideIcon(folded ? "plus" : "minus", { size: 13 }));
      fold.type = "button";
      fold.dataset.id = record.id;
      fold.setAttribute("aria-label", t("trajectory.callsFoldA11y", { state: t(folded ? "trajectory.callsFoldedState" : "trajectory.callsExpandedState") }));
      fold.addEventListener("click", (event) => {
        event.stopPropagation();
        if (collapsedAssistants.has(record.id)) collapsedAssistants.delete(record.id);
        else collapsedAssistants.add(record.id);
        render();
      });
      metaRow.append(fold);
    }
    wrap.append(metaRow);

    wrap.addEventListener("click", () => openRow(row));
    return wrap;
  }

  function openRowById(id) {
    const row = rowById.get(id);
    if (row) openRow(row);
  }

  function openRow(row) {
    selectedRecordId = row.record.id;
    paintTimeline();
    const trajectory = getTrajectory();
    const request = row.record.requestId
      ? trajectory.requests.find((entry) => entry.id === row.record.requestId) ?? null
      : null;
    const numbers = numberRequests(trajectory.requests);
    const stats = request == null ? null : {
      toolCalls: trajectory.records.filter((entry) => entry.requestId === request.id && entry.kind === "tool").length,
      subtoolCalls: trajectory.records.filter((entry) => entry.requestId === request.id && entry.kind === "subtool").length
    };
    openRecordDetail({
      record: row.record,
      request,
      requestNumber: numbers.get(request?.id) ?? null,
      index: rowIndex.get(row.id) ?? null,
      stats
    });
  }

  let rowIndex = new Map();
  let lastTurns = [];
  let lastMatches = null;

  function paintTimeline() {
    if (timelineBtn) {
      const label = timeline.modeLabel();
      timelineBtn.textContent = label;
      timelineBtn.setAttribute("aria-pressed", String(timeline.getMode() === "duration"));
      timelineBtn.setAttribute("aria-label", t("trajectory.timelineModeA11y", { mode: label }));
    }
    timeline.render({ turns: lastTurns, searchMatches: lastMatches, selectedId: selectedRecordId });
  }

  function render() {
    if (!open) return;
    paintToolbar();
    const trajectory = getTrajectory();
    const key = `${searchQuery}|fold:${[...collapsedTurns].sort().join(",")}|${[...collapsedAssistants].sort().join(",")}|tl:${timeline.getMode()}|sel:${selectedRecordId ?? ""}`;
    if (trajectory === lastTrajectory && key === lastKey) return;
    lastTrajectory = trajectory;
    lastKey = key;

    const turns = buildTurns(trajectory);
    const foldState = paintFoldButtons(turns);
    const searchMatches = buildSearchMatches(trajectory, searchQuery);
    const rows = ledgerRows(turns);
    const numbers = numberRequests(trajectory.requests);
    const visible = visibleRows(rows, turns, {
      collapsedTurns, collapsedAssistants, searchMatches
    });
    rowIndex = new Map(rows.map((row, index) => [row.id, index + 1]));
    rowById = new Map(rows.map((row) => [row.id, row]));
    lastTurns = turns;
    lastMatches = searchMatches;

    ledger.replaceChildren();
    if (rows.length === 0) {
      ledger.append(el("div", "trajectory-empty", t("trajectory.ledgerEmpty")));
    } else if (visible.length === 0) {
      ledger.append(el("div", "trajectory-empty", t("trajectory.ledgerNoMatches")));
    } else {
      const meta = {
        indexById: rowIndex,
        turnStart: turnStartRowIds(rows),
        callFoldable: foldState.callFoldable,
        requestNumber: (record) => {
          const requestId = record.requestId
            ?? (record.turn != null && record.step != null
              ? trajectory.requests.find((request) => request.turn === record.turn && request.step === record.step)?.id
              : null);
          return requestId == null ? null : numbers.get(requestId) ?? null;
        }
      };
      const focused = timeline.focusedIds();
      for (const row of visible) {
        const node = rowElement(row, meta);
        if (focused != null && !focused.has(row.id)) node.classList.add("out-of-focus");
        ledger.append(node);
      }
    }
    if (earlier) {
      const more = hasMore?.() === true;
      earlier.hidden = !more && !loadingEarlier;
      if (earlierBtn) earlierBtn.disabled = loadingEarlier;
    }
    paintTimeline();
  }

  function toggleAll(kind, turns) {
    if (kind === "turns") {
      const foldable = collapsibleTurns(turns);
      const all = foldable.size > 0 && [...foldable].every((turn) => collapsedTurns.has(turn));
      for (const turn of foldable) {
        if (all) collapsedTurns.delete(turn); else collapsedTurns.add(turn);
      }
    } else {
      const foldable = assistantIdsWithCalls(turns);
      const all = foldable.size > 0 && [...foldable].every((id) => collapsedAssistants.has(id));
      for (const id of foldable) {
        if (all) collapsedAssistants.delete(id); else collapsedAssistants.add(id);
      }
    }
    render();
  }

  function openPane() {
    if (open) { render(); return; }
    open = true;
    lastTrajectory = null;
    lastKey = null;
    pane.hidden = false;
    messages?.classList.add("trajectory-open");
    paintToolbar();
    render();
  }

  function closePane() {
    if (!open) return;
    open = false;
    pane.hidden = true;
    messages?.classList.remove("trajectory-open");
  }

  turnsBtn?.addEventListener("click", () => toggleAll("turns", buildTurns(getTrajectory())));
  callsBtn?.addEventListener("click", () => toggleAll("calls", buildTurns(getTrajectory())));
  timelineBtn?.addEventListener("click", () => { timeline.toggleMode(); selectedRecordId = null; render(); });
  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value ?? "";
    if (searchClear) searchClear.hidden = searchQuery === "";
    render();
  });
  searchClear?.addEventListener("click", () => {
    searchQuery = "";
    if (searchInput) searchInput.value = "";
    if (searchClear) searchClear.hidden = true;
    render();
  });
  // × 是用户主动关闭,要让调用方把开合状态持久化;程序化 close() 不写。
  closeBtn?.addEventListener("click", () => { closePane(); onClose?.(); });
  earlierBtn?.addEventListener("click", async () => {
    if (loadingEarlier || !onLoadEarlier) return;
    loadingEarlier = true;
    paintToolbar();
    render();
    try {
      await onLoadEarlier();
    } finally {
      loadingEarlier = false;
      lastTrajectory = null;
      render();
    }
  });

  return {
    open: openPane,
    close: closePane,
    isOpen: () => open,
    render,
    focusSearch: () => searchInput?.focus(),
    relabel() {
      lastTrajectory = null;
      lastKey = null;
      timeline.relabel();
      render();
    },
    get searchQuery() { return searchQuery; },
    /// 测试/会话切换用:当前渲染的折叠集合快照。
    foldedSnapshot: () => ({
      turns: new Set(collapsedTurns),
      calls: new Set(collapsedAssistants),
      query: searchQuery
    }),
    /// 测试用:时间线模式与当前选中记录。
    timelineMode: () => timeline.getMode(),
    selectedRecordId: () => selectedRecordId
  };
}
