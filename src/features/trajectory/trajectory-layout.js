// 轨迹布局:记录 → 轮次/分组 → 台账行(含折叠与请求编号)。
// 逐条对齐 macapp TrajectoryLayoutBuilder.swift + TrajectoryFolding.swift。
import { t } from "../../shared/i18n.js";

/// 排序锚点:初始系统提示词排在所有已记录事件之前。
function layoutOrder(record) {
  return record.kind === "system" && record.previousPrompt == null ? Number.MIN_SAFE_INTEGER : 0;
}

function groupKindFor(record) {
  if (record.kind === "compacted") return { type: "compaction", seq: record.sourceSeq ?? 0 };
  if (record.step != null && record.step > 0
    && (record.kind === "assistant" || record.kind === "tool" || record.kind === "subtool" || record.requestOnly)) {
    return { type: "step", step: record.step };
  }
  return { type: "message" };
}

function groupStableKey(kind) {
  if (kind.type === "step") return `step:${kind.step}`;
  if (kind.type === "compaction") return `compaction:${kind.seq}`;
  return "message";
}

/// 分组的可读标题;standalone 压缩落在轮次之间。
export function groupTitle(kind, { standalone = false } = {}) {
  if (standalone) return t("trajectory.betweenTurns");
  if (kind.type === "step") return t("trajectory.groupStep", { step: String(kind.step) });
  if (kind.type === "compaction") return t("trajectory.groupCompaction", { seq: String(kind.seq) });
  return t("trajectory.groupMessage");
}

/// 分组的描述(总耗时 + 工具名计数),纯函数于最终记录集。
function describeRecords(records) {
  const parts = [];
  const intervals = records
    .filter((record) => Number.isFinite(record.startedAt))
    .map((record) => [record.startedAt, record.startedAt + Math.max(0, record.durationSeconds ?? 0) * 1000]);
  if (intervals.length) {
    const minimum = Math.min(...intervals.map((pair) => pair[0]));
    const maximum = Math.max(...intervals.map((pair) => pair[1]));
    if (maximum > minimum) {
      const value = String(Math.round(maximum - minimum)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      parts.push(t("trajectory.unitMilliseconds", { value }));
    }
  }
  const tools = new Map();
  for (const record of records) {
    if (record.kind !== "tool" || !record.toolName) continue;
    tools.set(record.toolName, (tools.get(record.toolName) ?? 0) + 1);
  }
  for (const name of [...tools.keys()].sort()) {
    const count = tools.get(name);
    parts.push(count > 1 ? `${name}×${count}` : name);
  }
  return parts.length ? parts.join(" ") : null;
}

/// 记录 → 轮次 section 列表。
export function buildTurns(snapshot) {
  const sorted = snapshot.records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const byOrder = layoutOrder(left.record) - layoutOrder(right.record);
      if (byOrder !== 0) return byOrder;
      const leftSeq = left.record.sourceSeq ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.record.sourceSeq ?? Number.MAX_SAFE_INTEGER;
      if (leftSeq !== rightSeq) return leftSeq - rightSeq;
      return left.index - right.index;
    })
    .map((entry) => entry.record);

  const sections = new Map();
  const order = [];
  let nextTurn = 1;
  for (const record of sorted) {
    let turn = record.turn ?? nextTurn;
    // Web 把 turn 0(孤儿子工具等)并入 Turn 1。
    if (turn === 0) turn = 1;
    if (record.kind === "user") nextTurn = Math.max(nextTurn, turn);
    if (record.kind === "assistant") nextTurn = Math.max(nextTurn, turn + 1);
    const standalone = record.kind === "compacted" && record.turn == null;
    const sectionKey = standalone ? `compaction:${record.id}` : `turn:${turn}`;
    if (!sections.has(sectionKey)) {
      order.push(sectionKey);
      sections.set(sectionKey, { id: sectionKey, turn: standalone ? null : turn, groups: [] });
    }
    const section = sections.get(sectionKey);
    const kind = groupKindFor(record);
    const stableKey = groupStableKey(kind);
    let group = section.groups.find((entry) => groupStableKey(entry.kind) === stableKey);
    if (!group) {
      group = { id: `${sectionKey}\0${stableKey}`, kind, description: null, records: [] };
      section.groups.push(group);
    }
    group.records.push(record);
  }
  const turns = order.map((key) => sections.get(key));
  for (const turn of turns) {
    for (const group of turn.groups) group.description = describeRecords(group.records);
  }
  return turns;
}

/// 台账顺序的全部记录(不过滤 —— 折叠判定的基准)。
export function flattenTurns(turns) {
  return turns.flatMap((turn) => turn.groups.flatMap((group) => group.records));
}

/// 有折叠控件的轮次(记录数 > 1)。
export function collapsibleTurns(turns) {
  const result = new Set();
  for (const turn of turns) {
    if (turn.turn == null) continue;
    // 只数内容记录(排除请求边界与系统行),对齐 Web。
    const count = turn.groups.reduce(
      (sum, group) => sum + group.records.filter((record) => record.requestOnly !== true && record.kind !== "system").length,
      0
    );
    if (count > 1) result.add(turn.turn);
  }
  return result;
}

/// 紧跟着工具/子工具调用的助手记录(唯一可折叠调用的行)。
export function assistantIdsWithCalls(turns) {
  const values = flattenTurns(turns);
  const result = new Set();
  for (let index = 0; index + 1 < values.length; index += 1) {
    const record = values[index];
    const next = values[index + 1];
    if (record.kind === "assistant" && (next.kind === "tool" || next.kind === "subtool")) {
      result.add(record.id);
    }
  }
  return result;
}

/// 台账的完整行列表(requestOnly 记录标记为请求边界)。
export function ledgerRows(turns) {
  const rows = [];
  let previousGroupId = null;
  for (const turn of turns) {
    for (const group of turn.groups) {
      let groupStart = group.id !== previousGroupId;
      previousGroupId = group.id;
      for (const record of group.records) {
        rows.push({
          id: record.id,
          turn: turn.turn,
          group: group.kind,
          groupId: group.id,
          groupDescription: group.description,
          groupStart,
          record,
          requestBoundary: record.requestOnly === true
        });
        groupStart = false;
      }
    }
  }
  return rows;
}

/// 每轮首个非 system 行的 id(Turn chip 的落点)。
export function turnStartRowIds(rows) {
  const result = new Set();
  const seen = new Set();
  for (const row of rows) {
    if (row.turn == null || seen.has(row.turn)) continue;
    if (row.record.kind === "system") continue;
    seen.add(row.turn);
    result.add(row.id);
  }
  return result;
}

/// 请求编号:按 startSeq 升序 1..N。
export function numberRequests(requests) {
  const map = new Map();
  [...requests]
    .sort((left, right) => (left.startSeq - right.startSeq) || left.id.localeCompare(right.id))
    .forEach((request, index) => map.set(request.id, index + 1));
  return map;
}

function summarizeTurnTail(turn, rows) {
  const own = rows.filter((row) => row.turn === turn
    && row.record.requestOnly !== true
    && row.record.kind !== "system");
  const tail = own.length > 1 ? own.slice(1) : own;
  const steps = new Set(tail.filter((row) => row.group.type === "step").map((row) => row.group.step)).size;
  const calls = tail.filter((row) => row.record.kind === "tool" || row.record.kind === "subtool").length;
  const stepText = t(steps === 1 ? "trajectory.foldedStepsOne" : "trajectory.foldedStepsOther", { n: String(steps) });
  const callText = t(calls === 1 ? "trajectory.foldedCallsOne" : "trajectory.foldedCallsOther", { n: String(calls) });
  return `${stepText} · ${callText}`;
}

/// 按折叠/搜索过滤台账行。
export function visibleRows(rows, turns, { collapsedTurns = new Set(), collapsedAssistants = new Set(), searchMatches = null } = {}) {
  if (searchMatches != null) return rows.filter((row) => searchMatches.has(row.id));
  const followingCalls = assistantIdsWithCalls(turns);
  const output = [];
  let foldingCalls = false;
  let foldedAssistant = null;
  const emittedTurns = new Set();
  const summarizedTurns = new Set();
  const flushAssistantSummary = () => {
    if (!foldedAssistant) return;
    output.push({
      ...foldedAssistant.row,
      id: `${foldedAssistant.row.id}-folded`,
      assistantSummary: foldedAssistant.summary()
    });
    foldedAssistant = null;
  };
  for (const row of rows) {
    if (foldingCalls) {
      if (row.record.kind === "tool" || row.record.kind === "subtool") {
        foldedAssistant.calls += 1;
        if (row.record.toolName) foldedAssistant.names.add(row.record.toolName);
        continue;
      }
      foldingCalls = false;
      flushAssistantSummary();
    }
    if (row.turn != null && collapsedTurns.has(row.turn)) {
      if (emittedTurns.has(row.turn)) {
        if (!summarizedTurns.has(row.turn)) {
          summarizedTurns.add(row.turn);
          output.push({ ...row, id: `${row.id}-folded`, turnSummary: summarizeTurnTail(row.turn, rows) });
        }
        continue;
      }
      emittedTurns.add(row.turn);
    }
    output.push(row);
    foldingCalls = row.record.kind === "assistant"
      && collapsedAssistants.has(row.id)
      && followingCalls.has(row.id);
    if (foldingCalls) {
      foldedAssistant = {
        row,
        calls: 0,
        names: new Set(),
        summary() {
          const names = [...this.names].join(", ");
          const callText = t(this.calls === 1 ? "trajectory.foldedCallsOne" : "trajectory.foldedCallsOther", { n: String(this.calls) });
          return names ? `${callText} · ${names}` : callText;
        }
      };
    } else {
      foldedAssistant = null;
    }
  }
  flushAssistantSummary();
  return output;
}
