// 子代理目录:状态机 + 纯函数。对齐 macOS SubagentCatalogAction / SubagentCatalogState。
// DOM 层只消费这里的值,自身不含渲染逻辑(便于 vitest 单测)。

/// 每 parent 一个 LoadState,对齐 Mac SubagentCatalogState.LoadState。
/// phase: "idle" | "loading" | "ready" | "failed";value 只在 ready 有,error 只在 failed 有。
export function createSubagentCatalogState() {
  const catalogs = new Map();   // parentSessionId -> { phase, value, error }
  const expanded = new Set();   // 已展开的 child sessionId 集合
  // 同一个 parent 可被手动重试与定时刷新同时拉取。旧响应不得覆盖后发结果。
  const loadGenerations = new Map();

  function stateFor(parentId) {
    return catalogs.get(parentId) ?? { phase: "idle", value: null, error: null };
  }

  /// loader: (parentId) => Promise<SubagentListValue>。
  /// force 重拉;loading/ready 时默认去重,失败后可 force 重试。
  async function load(parentId, loader, options = {}) {
    const force = options.force === true;
    const cur = stateFor(parentId);
    if (!force && (cur.phase === "loading" || cur.phase === "ready")) return;
    // ready 态 force 重拉时保留旧值,避免目录闪空。
    catalogs.set(parentId, {
      phase: "loading",
      value: cur.phase === "ready" ? cur.value : null,
      error: null
    });
    const generation = (loadGenerations.get(parentId) ?? 0) + 1;
    loadGenerations.set(parentId, generation);
    try {
      const value = await loader(parentId);
      if (loadGenerations.get(parentId) !== generation) return;
      catalogs.set(parentId, { phase: "ready", value, error: null });
    } catch (error) {
      if (loadGenerations.get(parentId) !== generation) return;
      catalogs.set(parentId, { phase: "failed", value: null, error: error?.message ?? String(error) });
    }
  }

  /// 展开/收起一个 child 树节点。loadChild(childId) 用于展开时就近拉取子树目录。
  function toggle(childId, loadChild) {
    if (expanded.has(childId)) {
      expanded.delete(childId);
      collapseDescendants(childId);
    } else {
      expanded.add(childId);
      if (loadChild) void loadChild(childId);
    }
  }

  function collapseDescendants(parentId) {
    const cur = stateFor(parentId);
    if (cur.phase !== "ready") return;
    for (const entry of cur.value?.entries ?? []) {
      if (entry.kind !== "child") continue;
      if (expanded.delete(entry.id)) collapseDescendants(entry.id);
    }
  }

  /// 关闭 popover 时清掉展开态,下次打开从折叠开始(对齐 Mac close)。
  function close() {
    expanded.clear();
  }

  return { stateFor, load, toggle, close, expanded };
}

/// ready 值里的 healthy child 数(诊断行不算 child)。
export function healthyCount(value) {
  return (value?.entries ?? []).reduce((n, e) => (e.kind === "child" ? n + 1 : n), 0);
}

/// 入口是否可见(对齐 Mac visible):failed 恒可见;ready 靠 entries 或名册后裔;
/// idle/loading 只靠名册后裔(目录尚未返回时也不至于入口消失)。
export function catalogVisible(rootState, descendants) {
  switch (rootState?.phase) {
    case "failed": return true;
    case "ready": return (rootState.value?.entries?.length ?? 0) > 0 || descendants.count > 0;
    default: return descendants.count > 0; // idle / loading
  }
}

/// 触发 chip 文案:有运行中先报运行数,否则报总数(取 healthy 与名册后裔的较大者)。
export function catalogTriggerLabel(rootState, descendants, t) {
  if (descendants.runningCount > 0) {
    const key = descendants.runningCount === 1 ? "statusSubagentsRunningOne" : "statusSubagentsRunningOther";
    return t(key, { n: String(descendants.runningCount) });
  }
  const count = Math.max(healthyCount(rootState?.value), descendants.count);
  const key = count === 1 ? "subagentCatalogCountOne" : "subagentCatalogCountOther";
  return t(key, { n: String(count) });
}

/// 行次级文案(mode · activity · summary title),对齐 Mac secondaryText。
export function childSecondaryText(mode, activity, summaryTitle, t) {
  const modeText = t(mode === "one-shot" ? "subagentModeOneShot" : "subagentModeContinuable");
  const activityText = t(activity === "running" ? "subagentActivityRunning" : "subagentActivityNotRunning");
  return [summaryTitle, modeText, activityText].filter(Boolean).join(" · ");
}

export function diagnosticReasonText(reason, t) {
  const key = {
    corrupt: "subagentDiagnosticCorrupt",
    unsupported: "subagentDiagnosticUnsupported",
    unavailable: "subagentDiagnosticUnavailable"
  }[reason];
  return t(key ?? "subagentDiagnosticUnavailable");
}

// ---------- 指标格式化(对齐 Mac SubagentMetrics)----------

/// 四桶 tokenUsage 相加(uncachedInput + output + cacheRead + cacheWrite);读不到返回 null。
export function subagentTokenTotal(summary) {
  const u = summary?.projections?.values?.tokenUsage;
  if (!u || typeof u !== "object") return null;
  const n = (v) => Number(v) || 0;
  const total = n(u.uncachedInputTokens) + n(u.outputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
  return total > 0 ? total : null;
}

/// 累计活跃时长:settledMs + max(0, 末刻 - 起始)。非运行态末刻取 through,否则 now。
export function subagentDurationMs(summary, now) {
  const timing = summary?.projections?.values?.subagentTiming;
  if (!timing || typeof timing !== "object") return null;
  const settled = Number(timing.settledMs) || 0;
  const active = timing.active;
  if (!active || typeof active !== "object") return settled > 0 ? settled : null;
  const since = Number(active.since) || 0;
  const through = Number(active.through) || 0;
  const end = through > 0 ? through : (Number(now) || since);
  return settled + Math.max(0, end - since);
}

/// 对齐 Mac SubagentMetrics.formatTokens:<1k 原样;K/M 段 >=100 取整、<100 保留一位。
export function formatSubagentTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const scaled = (next) => (next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10));
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return scaled(value / 1_000) + "K";
  return scaled(value / 1_000_000) + "M";
}

function splitDuration(ms) {
  const totalSeconds = Math.trunc(Math.max(0, ms) / 1000);
  const totalMinutes = Math.trunc(totalSeconds / 60);
  const totalHours = Math.trunc(totalMinutes / 60);
  const days = Math.trunc(totalHours / 24);
  return {
    seconds: totalSeconds % 60,
    minutes: totalMinutes % 60,
    hours: totalHours % 24,
    days,
    totalMinutes,
    totalHours
  };
}

function pad2(n) { return String(n).padStart(2, "0"); }

/// 对齐 Mac SubagentMetrics.formatDuration:尺度越大精度越低,最多两个相邻单位。
export function formatSubagentDuration(ms) {
  const p = splitDuration(ms);
  if (p.days >= 365) {
    const years = Math.trunc(p.days / 365);
    const months = Math.trunc((p.days % 365) / 30);
    return months === 0 ? "~" + years + "y" : "~" + years + "y " + months + "mo";
  }
  if (p.days >= 30) {
    const months = Math.trunc(p.days / 30);
    const d2 = p.days % 30;
    return d2 === 0 ? "~" + months + "mo" : "~" + months + "mo " + d2 + "d";
  }
  if (p.days > 0) return p.hours === 0 ? p.days + "d" : p.days + "d " + p.hours + "h";
  if (p.totalHours > 0) return p.totalHours + "h " + pad2(p.minutes) + "m " + pad2(p.seconds) + "s";
  if (p.totalMinutes > 0) return p.totalMinutes + "m " + pad2(p.seconds) + "s";
  return p.seconds + "s";
}

/// 精确到秒,供 hover/无障碍命名(对齐 Mac formatExactDuration)。
export function formatSubagentExactDuration(ms) {
  const p = splitDuration(ms);
  if (p.days > 0) return p.days + "d " + pad2(p.hours) + "h " + pad2(p.minutes) + "m " + pad2(p.seconds) + "s";
  return formatSubagentDuration(ms);
}
