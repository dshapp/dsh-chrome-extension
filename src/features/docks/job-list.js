// 后台任务入口:header chip + 明细浮层。
// 对齐 web ui-jobs JobListAction(同一位置:会话工具栏,紧挨子代理入口之后),
// Mac 的 JobListAction 也把它放这里。触发钮只报计数(有 running/stopping 时报
// 运行中数量并点一颗活动点,否则报总数),明细全在浮层里,不再混进上下文统计浮层。
import { t } from "../../shared/i18n.js";
import { openCardDetail } from "../chat/card-detail.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/// 任务是否还开着(计时会走)。对齐 web isLive。
export function isLiveJob(job) {
  return job?.status === "running" || job?.status === "stopping";
}

/// 状态点语义:stopping 与 killed 同色 —— 都是"按要求结束"。
export function jobDotState(status) {
  switch (status) {
    case "running": return "ongoing";
    case "stopping": return "warning";
    case "completed": return "done";
    case "killed": return "warning";
    case "failed": return "error";
    default: return "ongoing";
  }
}

/// 人读状态词。对齐 web statusLabel。
export function jobStatusLabel(status) {
  switch (status) {
    case "running": return t("jobs.running");
    case "stopping": return t("jobs.stopping");
    case "completed": return t("jobs.completed");
    case "killed": return t("jobs.killed");
    case "failed": return t("jobs.failed");
    default: return String(status ?? "");
  }
}

/// 计时文案:至多两级相邻单位,小时封顶。对齐 web formatDuration。
export function formatJobDuration(elapsedMs) {
  const total = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return t("jobs.durationHours", { h: String(hours), m: String(minutes) });
  if (minutes > 0) return t("jobs.durationMinutes", { m: String(minutes), s: String(seconds) });
  return t("jobs.durationSeconds", { s: String(seconds) });
}

/// 排序:进行中的按开始时间升序在前,已结束的按结束时间降序在后,
/// 同一毫秒结束的回退到开始时间。对齐 web ordered。
export function orderedJobs(jobs) {
  return [...(Array.isArray(jobs) ? jobs : [])].sort((left, right) => {
    const liveLeft = isLiveJob(left);
    if (liveLeft !== isLiveJob(right)) return liveLeft ? -1 : 1;
    if (liveLeft) return (left.startedAt ?? 0) - (right.startedAt ?? 0);
    const finished = (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0);
    // 必须返回 ±1,不能返回 boolean:false 会被当成 0(视为相等),
    // 这样比较器不再反对称,排序结果依赖输入顺序。
    return finished !== 0 ? (finished > 0 ? 1 : -1) : (left.startedAt ?? 0) - (right.startedAt ?? 0);
  });
}

/// 计数文案:有活动任务时只报活动数,否则报总数。对齐 web countKey/countLabel。
export function jobCountLabel(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const liveCount = list.filter(isLiveJob).length;
  const key = liveCount > 0
    ? (liveCount === 1 ? "jobs.countLiveOne" : "jobs.countLiveOther")
    : (list.length === 1 ? "jobs.countIdleOne" : "jobs.countIdleOther");
  return t(key, { n: String(liveCount > 0 ? liveCount : list.length) });
}

function elapsedOf(job, now) {
  return isLiveJob(job) ? now - (job.startedAt ?? now) : (job.finishedAt ?? job.startedAt ?? 0) - (job.startedAt ?? 0);
}

function formatClock(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString();
}

/// 任务详情弹窗正文:对齐 Mac CardDetailSheet 的 backgroundJob 字段表。
export function buildJobDetail(job, duration) {
  const rows = [
    [t("jobs.detailKind"), job.kind],
    [t("jobs.detailId"), job.id],
    [t("jobs.detailStatus"), jobStatusLabel(job.status)],
    [t("jobs.detailStarted"), Number.isFinite(job.startedAt) ? formatClock(job.startedAt) : null],
    [t("jobs.detailFinished"), Number.isFinite(job.finishedAt) ? formatClock(job.finishedAt) : null],
    [t("jobs.detailDuration"), duration],
    [t("jobs.detailDetail"), job.detail ?? t("jobs.detailUnavailable")]
  ];
  const list = el("dl", "jobs-detail");
  for (const [key, value] of rows) {
    if (value == null || value === "") continue;
    list.append(el("dt", "jobs-detail-label", key));
    list.append(el("dd", "jobs-detail-value", String(value)));
  }
  return list;
}

/// 打开一条任务的详情(点击浮层行)。对齐 Mac:点行进 CardDetailSheet。
export function openJobDetail(job, duration) {
  openCardDetail({
    title: job.label || job.kind || t("jobs.title"),
    build: () => buildJobDetail(job, duration),
    copyText: [job.kind, job.id, jobStatusLabel(job.status), duration].filter(Boolean).join("  ")
  });
}

/// 挂载后台任务入口。
/// @param trigger header 里的按钮(chip)
/// @param menu    popover 容器
export function mountJobList(trigger, menu) {
  let current = [];
  let timer = null;

  function stopTimer() {
    if (timer == null) return;
    clearInterval(timer);
    timer = null;
  }

  // 计时只在有活动任务时走:全结束的列表不需要每秒重画。
  function scheduleTimer() {
    const live = current.some(isLiveJob);
    if (!live) { stopTimer(); return; }
    if (timer != null) return;
    timer = setInterval(() => { render(); }, 1000);
  }

  function render() {
    menu.replaceChildren();
    if (!current.length) return;
    const listEl = el("div", "jobs-list");
    for (const job of orderedJobs(current)) {
      const live = isLiveJob(job);
      const duration = formatJobDuration(elapsedOf(job, Date.now()));
      const statusText = job.detail ?? jobStatusLabel(job.status);
      const row = el("button", live ? "jobs-row" : "jobs-row settled");
      row.type = "button";
      row.title = t("jobs.openHint");
      row.setAttribute("aria-label", [job.kind, job.label, statusText, duration].filter(Boolean).join(" "));
      row.append(el("span", "jobs-row-dot state-" + jobDotState(job.status)));
      row.append(el("span", "jobs-row-kind", job.kind ?? ""));
      row.append(el("span", "jobs-row-label", job.label ?? job.id ?? ""));
      row.append(el("span", "jobs-row-status", statusText));
      const time = el("span", "jobs-row-time", duration);
      time.title = t(live ? "jobs.durationTitleLive" : "jobs.durationTitleDone", { d: duration });
      row.append(time);
      row.addEventListener("click", () => {
        menu.hidePopover?.();
        openJobDetail(job, duration);
      });
      listEl.append(row);
    }
    menu.append(listEl);
  }

  // popover 由 popovertarget 打开,这里只在开合时补画/停表。
  menu.addEventListener?.("toggle", (event) => {
    if (event.newState === "open") { render(); scheduleTimer(); }
    else stopTimer();
  });

  return {
    set(jobs) {
      current = Array.isArray(jobs) ? jobs : [];
      trigger.hidden = current.length === 0;
      const label = jobCountLabel(current);
      const dot = trigger.querySelector(".jobs-dot");
      if (dot) dot.hidden = !current.some(isLiveJob);
      const text = trigger.querySelector(".jobs-label");
      if (text) text.textContent = label;
      trigger.setAttribute("aria-label", label || t("jobs.title"));
      if (trigger.hidden) {
        stopTimer();
        menu.replaceChildren();
        menu.hidePopover?.();
        return;
      }
      render();
      scheduleTimer();
    }
  };
}
