// 会话停靠区:目标条、待办面板、上下文/统计行。
// 对齐 macos/.../Components/Conversation/Docks.swift(GoalBar / TodoPanel / StatsLine)。
// 全部读已有的 projections,不新增下行通道。
import { t } from "../../shared/i18n.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconBtn(className, label, glyph) {
  const b = el("button", className, glyph);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

// ---------- 目标条 ----------

/// 折叠"生效中的目标":complete 视为无目标(与 Mac 的 activeGoal 一致)。
export function activeGoal(goal) {
  if (!goal || !goal.id) return null;
  if (goal.phase === "complete") return null;
  return goal;
}

export function goalPhaseLabel(phase) {
  switch (phase) {
    case "paused": return t("goal.phasePaused");
    case "blocked": return t("goal.phaseBlocked");
    default: return t("goal.phaseActive");
  }
}

/// 目标条。active 显示暂停、paused 显示继续,两者都有编辑与清除。
/// 编辑时目标文本换成输入框 + 保存/取消。
export function mountGoalBar(container, { onPause, onResume, onEdit, onClear }) {
  let current = null;
  let editing = false;
  let pending = false;
  let error = null;

  function render() {
    container.replaceChildren();
    const goal = activeGoal(current);
    container.hidden = !goal;
    if (!goal) { editing = false; return; }

    const bar = el("div", `goal-bar phase-${goal.phase}`);
    bar.append(el("span", "goal-glyph", "◎"));
    bar.append(el("span", "goal-label", goalPhaseLabel(goal.phase)));

    if (editing) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "goal-edit-input";
      input.value = goal.objective;
      input.setAttribute("aria-label", t("goal.objective"));
      input.disabled = pending;
      const commit = () => {
        const value = input.value.trim();
        if (!value || pending) return;
        pending = true; render();
        Promise.resolve(onEdit(value)).finally(() => { pending = false; editing = false; render(); });
      };
      // Enter 提交、Escape 取消(对齐 Mac 的编辑器按键)。
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); editing = false; error = null; render(); }
      });
      const save = iconBtn("goal-btn", t("goal.save"), "✓");
      save.disabled = pending;
      save.addEventListener("click", commit);
      const cancel = iconBtn("goal-btn", t("goal.cancel"), "×");
      cancel.disabled = pending;
      cancel.addEventListener("click", () => { editing = false; error = null; render(); });
      bar.append(input, save, cancel);
      container.append(bar);
      queueMicrotask(() => input.focus());
    } else {
      const objective = el("span", "goal-objective", goal.objective);
      if (goal.phase === "blocked" && goal.blockedMessage) objective.title = goal.blockedMessage;
      bar.append(objective);
      const spacer = el("span", "goal-spacer");
      bar.append(spacer);

      if (goal.phase === "paused") {
        const resume = iconBtn("goal-btn", t("goal.resume"), "▶");
        resume.disabled = pending;
        resume.addEventListener("click", () => run(onResume));
        bar.append(resume);
      } else {
        const pause = iconBtn("goal-btn", t("goal.pause"), "⏸");
        pause.disabled = pending;
        pause.addEventListener("click", () => run(onPause));
        bar.append(pause);
      }
      const edit = iconBtn("goal-btn", t("goal.edit"), "✎");
      edit.disabled = pending;
      edit.addEventListener("click", () => { editing = true; error = null; render(); });
      const clear = iconBtn("goal-btn", t("goal.clear"), "🗑");
      clear.disabled = pending;
      clear.addEventListener("click", () => run(onClear));
      bar.append(edit, clear);
      container.append(bar);
    }
    if (error) container.append(el("div", "goal-error", error));
  }

  function run(action) {
    if (pending) return;
    pending = true; error = null; render();
    Promise.resolve(action())
      .catch((e) => { error = e?.message || String(e); })
      .finally(() => { pending = false; render(); });
  }

  return {
    set(goal) {
      // 目标身份变化(被清除/完成/外部替换)要作废本地编辑状态:
      // 残留的草稿一旦提交会覆盖到**新**目标上。
      if ((goal?.id ?? null) !== (current?.id ?? null)) { editing = false; error = null; }
      current = goal;
      render();
    }
  };
}

// ---------- 待办面板 ----------

/// 状态字形阶梯,对齐 Mac 的 TodoStatusGlyph:
/// completed=实心对勾环(绿)/ in_progress=缺口环(蓝、慢转)/ pending=虚线环(warn)。
/// 用 CSS 画环而不是字符,才能拿到虚线和旋转;这里只负责挂 class。
const TODO_STATUS = Object.freeze({
  completed: "completed", in_progress: "in_progress", "in-progress": "in_progress"
});
function todoStatus(status) { return TODO_STATUS[status] ?? "pending"; }

/// 待办面板。默认折叠成一行摘要,点击展开完整列表。
export function mountTodoPanel(container) {
  let todos = [];
  let expanded = false;

  function render() {
    container.replaceChildren();
    container.hidden = !todos.length;
    if (!todos.length) return;

    const done = todos.filter((x) => todoStatus(x.status) === "completed").length;
    const active = todos.filter((x) => todoStatus(x.status) === "in_progress");
    const pending = todos.length - done - active.length;

    const head = el("button", "todo-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(expanded));
    const glyph = el("span", "todo-glyph");
    // lucide: list-checks(对应 Mac 的 SF Symbol "checklist")
    glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>';
    head.append(glyph);

    // 分状态计数,顺序与配色对齐 Mac 的 progressLabel:已完成(绿)→ 待处理(warn)
    // → 进行中(蓝),只有分隔点用次级色。计数在标题**之前**。
    const counts = el("span", "todo-counts");
    const seg = [];
    if (done) seg.push(["done", t("todo.done", { n: String(done) })]);
    if (pending) seg.push(["pending", t("todo.pending", { n: String(pending) })]);
    if (active.length) seg.push(["active", t("todo.active", { n: String(active.length) })]);
    seg.forEach(([kind, text], i) => {
      if (i) counts.append(el("span", "todo-sep", " · "));
      counts.append(el("span", `todo-seg todo-seg-${kind}`, text));
    });
    head.append(counts);

    // 标题就是正在做的那条:折叠着也知道 agent 在忙什么(Mac headerTitle)。
    head.append(el("span", "todo-current", active[0]?.content ?? t("todo.title")));
    // Mac 的 chevron:展开时朝下,折叠时朝上。
    head.append(el("span", "todo-chevron", expanded ? "⌃" : "⌄"));
    head.addEventListener("click", () => { expanded = !expanded; render(); });
    container.append(head);

    if (expanded) {
      const list = el("ul", "todo-list");
      for (const todo of todos) {
        const li = el("li", `todo-item todo-${todoStatus(todo.status)}`);
        li.append(el("span", "todo-mark"));
        li.append(el("span", "todo-text", todo.content));
        list.append(li);
      }
      container.append(list);
    }
  }

  return {
    set(next) {
      const changed = (next ?? []).length !== todos.length;
      todos = next ?? [];
      // 首次出现待办时自动展开一次,之后尊重用户的折叠选择。
      if (changed && todos.length && !expanded && todos.length <= 8) expanded = true;
      render();
    }
  };
}

// ---------- 上下文 / 统计行 ----------

export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${Math.round(sec % 60) ? ` ${Math.round(sec % 60)}s` : ""}`;
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

/// 上下文占用比例(0..1)。projectedTokens 优先——它含尚未计入的预估。
export function contextRatio(pressure) {
  if (!pressure) return null;
  const window = pressure.contextWindow;
  if (!Number.isFinite(window) || window <= 0) return null;
  const used = pressure.projectedTokens ?? pressure.pressureTokens ?? 0;
  return Math.max(0, Math.min(1, used / window));
}

/// 统计行文案(对齐 Mac StatsLine 的分组顺序)。
export function statsText(stats, usage) {
  const sections = [];
  if (stats && stats.steps > 0) {
    sections.push(`${stats.turns} ${t("stats.turn")} · ${stats.steps} ${t("stats.step")}`);
    const durations = [];
    if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`);
    if (stats.toolMs > 0) durations.push(`${t("stats.tool")} ${formatDuration(stats.toolMs)}`);
    if (durations.length) sections.push(durations.join(" · "));
    const speeds = [];
    if (stats.ttftSteps > 0 && stats.ttftMs > 0) {
      speeds.push(`${t("stats.ttft")} ${formatDuration(stats.ttftMs / stats.ttftSteps)}`);
    }
    if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
      speeds.push(`${Math.round(stats.decodeTokens / (stats.decodeMs / 1000))} ${t("stats.tps")}`);
    }
    if (speeds.length) sections.push(speeds.join(" · "));
  }
  if (usage) {
    // 计费输入 = 未缓存 + 缓存读 + 缓存写(三个互斥的 prompt 侧桶)。
    const billed = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const output = usage.outputTokens ?? 0;
    if (billed > 0 || output > 0) {
      const parts = [];
      if (billed > 0) parts.push(`↑${formatTokens(billed)}`);
      if (output > 0) parts.push(`↓${formatTokens(output)}`);
      sections.push(parts.join(" "));
    }
  }
  return sections.join("  ·  ");
}

/// Mac StatsLine 专用的时长/token 格式(Docks.swift 的 formatStatsDuration /
/// StatsLine.formatTokens)。与上面的 formatDuration/formatTokens 有意分开:
/// 那两个服务于统计浮层,已有既定表现;这行小字要和 Mac 逐字一致 ——
/// 60s 以内保留一位小数、分秒之间不留空格、token 一律保留一位小数。
export function formatStatsDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  if (seconds < 60) {
    const tenths = Math.round(seconds * 10);
    return tenths % 10 === 0 ? `${tenths / 10}s` : `${Math.floor(tenths / 10)}.${tenths % 10}s`;
  }
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

export function formatStatsTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}
/// 统计明细的行数据(纯函数,便于单测)。popover 有纵向空间,
/// 所以不再把所有分组挤成一行,而是拆成"标签 / 值"的键值行。
export function statsRows(stats, usage) {
  const rows = [];
  if (stats && stats.steps > 0) {
    rows.push({ key: "turns", label: t("stats.turnsLabel"), value: `${stats.turns} ${t("stats.turn")} · ${stats.steps} ${t("stats.step")}` });
    if (stats.llmMs > 0) rows.push({ key: "llm", label: "LLM", value: formatDuration(stats.llmMs) });
    if (stats.toolMs > 0) rows.push({ key: "tool", label: t("stats.tool"), value: formatDuration(stats.toolMs) });
    if (stats.ttftSteps > 0 && stats.ttftMs > 0) {
      rows.push({ key: "ttft", label: t("stats.ttft"), value: formatDuration(stats.ttftMs / stats.ttftSteps) });
    }
    if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
      rows.push({ key: "tps", label: t("stats.speed"), value: `${Math.round(stats.decodeTokens / (stats.decodeMs / 1000))} ${t("stats.tps")}` });
    }
  }
  if (usage) {
    // 计费输入 = 未缓存 + 缓存读 + 缓存写(三个互斥的 prompt 侧桶)。
    const billed = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const output = usage.outputTokens ?? 0;
    if (billed > 0) {
      rows.push({ key: "input", label: t("stats.input"), value: `${formatTokens(billed)} tok` });
      const cacheRead = usage.cacheReadTokens ?? 0;
      // 缓存命中率只在有计费输入时才有意义(分母就是 billed)。
      rows.push({ key: "cache", label: t("stats.cache"), value: `${Math.round(Math.min(100, Math.max(0, cacheRead / billed * 100)))}%` });
    }
    if (output > 0) rows.push({ key: "output", label: t("stats.output"), value: `${formatTokens(output)} tok` });
  }
  return rows;
}

/// 图例用的紧凑 token 数,对齐 Mac 的 ContextBreakdownPanel.formatTokens:
/// 小于 100 的档保留一位小数(13.1K),100 以上取整(154K),末尾 .0 去掉;
/// 单位是大写 K/M。与 formatTokens 的区别:后者 ≥10k 就丢掉小数,
/// 用在这里会把 13.1K 压成 13k,和 Mac 对不上。
export function formatBreakdownTokens(count) {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  const value = count < 1_000_000 ? count / 1000 : count / 1_000_000;
  const suffix = count < 1_000_000 ? "K" : "M";
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${suffix}`;
}

/// 分段条各段占比(对齐 Mac ContextBreakdownPanel.segments):
/// 三段合起来只铺满"实际占用比例"——breakdown 是启发式估算,故意不等于
/// provider 精确占用,所以它只决定各段的相对比例,不决定整条的长度。
/// 没有 breakdown 时退化成一整段无色条;零宽段丢弃,否则 0% 也会画出一条。
export function contextSegments(ratio, breakdown) {
  const fraction = Math.max(0, Math.min(1, ratio ?? 0));
  const system = Number(breakdown?.systemTokens) || 0;
  const tools = Number(breakdown?.toolsTokens) || 0;
  const messages = Number(breakdown?.messageTokens) || 0;
  const total = system + tools + messages;
  if (!breakdown || total <= 0) {
    return fraction > 0 ? [{ kind: "total", fraction }] : [];
  }
  return [
    { kind: "system", fraction: fraction * system / total },
    { kind: "tools", fraction: fraction * tools / total },
    { kind: "messages", fraction: fraction * messages / total }
  ].filter((part) => part.fraction > 0);
}

/// 后台任务状态 → 人读文案。对齐 Mac BackgroundJobPresentation.statusLabel。
function jobStatusLabel(status) {
  switch (status) {
    case "running": return t("jobs.running");
    case "stopping": return t("jobs.stopping");
    case "completed": return t("jobs.completed");
    case "killed": return t("jobs.killed");
    case "failed": return t("jobs.failed");
    default: return String(status ?? "");
  }
}

/// 上下文 + 统计 + 后台任务:底栏一颗药丸(上下文占比),点击弹出详情 popover。
/// 对齐 Mac 的 JobListAction —— 触发钮只给一个最小摘要,明细都在浮层里。
export function mountStatsBar(trigger, menu, { onCompact } = {}) {
  const ring = trigger.querySelector(".stats-ring");

  return {
    set({ contextPressure, sessionStats, tokenUsage, contextBreakdown, presetName, jobs }) {
      const ratio = contextRatio(contextPressure);
      const rows = statsRows(sessionStats, tokenUsage);
      const jobList = Array.isArray(jobs) ? jobs : [];
      // 上下文、统计、后台任务都没有时整颗药丸消失,底栏不留空位。
      trigger.hidden = ratio == null && rows.length === 0 && jobList.length === 0;
      if (trigger.hidden) {
        menu.replaceChildren();
        menu.hidePopover?.();
        return;
      }

      // ── 触发钮:只剩一枚圆环,读数全部移进详情浮层 ──
      const pct = ratio == null ? null : Math.round(ratio * 100);
      trigger.classList.toggle("warn", ratio != null && ratio >= 0.75 && ratio < 0.9);
      trigger.classList.toggle("critical", ratio != null && ratio >= 0.9);
      if (ring) {
        // 环常驻:没有上下文读数时(只有统计行)画一圈空槽,
        // 否则按钮会变成一颗没有任何内容的空药丸。
        ring.style.setProperty("--stats-pct", `${pct ?? 0}%`);
      }
      // 不挂 title:hover 气泡与点开的浮层内容重复。读数只留给浮层,
      // aria-label 仍带上摘要,读屏用户不点开也知道当前占用。
      const summary = statsText(sessionStats, tokenUsage);
      const label = [pct != null ? t("context.used", { percent: String(pct) }) : null, summary]
        .filter(Boolean).join("  ·  ");
      trigger.setAttribute("aria-label", label || t("stats.title"));

      // ── 详情浮层 ──
      menu.replaceChildren();
      if (ratio != null) {
        const wrap = el("div", "context-meter");
        if (ratio >= 0.9) wrap.classList.add("critical");
        else if (ratio >= 0.75) wrap.classList.add("warn");
        const head = el("div", "stats-menu-head");
        head.append(el("span", "stats-menu-title", t("context.used", { percent: String(pct) })));
        head.append(el("span", "stats-menu-sub", t("context.detail", {
          used: formatBreakdownTokens(contextPressure.projectedTokens ?? contextPressure.pressureTokens ?? 0),
          total: formatBreakdownTokens(contextPressure.contextWindow)
        })));
        wrap.append(head);
        // 当前 agent 预设名(原来挂在输入卡下方的统计行,那行已撤掉)。
        if (presetName) wrap.append(el("div", "stats-menu-preset", presetName));
        // 分段条:按 system/tools/messages 的比例分色(对齐 Mac 的三色段)。
        const bar = el("div", "context-meter-bar");
        for (const part of contextSegments(ratio, contextBreakdown)) {
          const seg = el("div", `context-seg context-seg-${part.kind}`);
          seg.style.inlineSize = `${part.fraction * 100}%`;
          bar.append(seg);
        }
        wrap.append(bar);
        // 图例:三行"色块 + 名称 + 估算 token 数"。
        if (contextBreakdown) {
          const legend = el("div", "context-legend");
          const rows = [
            ["system", t("context.system"), contextBreakdown.systemTokens],
            ["tools", t("context.tools"), contextBreakdown.toolsTokens],
            ["messages", t("context.messages"), contextBreakdown.messageTokens]
          ];
          for (const [kind, name, tokens] of rows) {
            const row = el("div", "context-legend-row");
            row.append(el("span", `context-dot context-seg-${kind}`));
            row.append(el("span", "context-legend-label", name));
            row.append(el("span", "context-legend-value", `~${formatBreakdownTokens(Number(tokens) || 0)}`));
            legend.append(row);
          }
          wrap.append(legend);
        }
        // 高占用才把"压缩上下文"放在手边,低占用不打扰。
        if (ratio >= 0.75 && onCompact) {
          const compact = el("button", "context-compact", t("context.compact"));
          compact.type = "button";
          compact.addEventListener("click", () => { menu.hidePopover?.(); onCompact(); });
          wrap.append(compact);
        }
        menu.append(wrap);
      }
      // 没有上下文读数时上面那段不会渲染,预设名在这里补一个落点。
      if (ratio == null && presetName) menu.append(el("div", "stats-menu-preset", presetName));
      if (rows.length) {
        const list = el("dl", "stats-rows");
        for (const row of rows) {
          const dt = el("dt", "stats-row-label", row.label);
          const dd = el("dd", "stats-row-value", row.value);
          dd.dataset.key = row.key;
          list.append(dt, dd);
        }
        menu.append(list);
      }
      // ── 后台任务(对齐 Mac JobListAction 的明细列表)──
      if (jobList.length) {
        const section = el("div", "stats-jobs");
        section.append(el("div", "stats-menu-title", t("jobs.title")));
        for (const job of jobList) {
          const row = el("div", "stats-job-row");
          const live = job.status === "running" || job.status === "stopping";
          row.classList.toggle("live", live);
          row.append(el("span", "stats-job-label", job.label || job.kind || job.id || ""));
          const status = el("span", "stats-job-status status-" + (job.status ?? "unknown"));
          status.textContent = jobStatusLabel(job.status);
          row.append(status);
          section.append(row);
        }
        menu.append(section);
      }
    }
  };
}
