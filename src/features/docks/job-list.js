// 后台任务入口:header chip + 明细浮层。
// 对齐 web ui-jobs JobListAction(同一位置:会话工具栏,紧挨子代理入口之后),
// Mac 的 JobListAction 也把它放这里。触发钮只报计数(有 running/stopping 时报
// 运行中数量并点一颗活动点,否则报总数),明细全在浮层里,不再混进上下文统计浮层。
//
// 0.1.7 补齐(对齐 web JobListAction / Mac Docks + CardDetailSheet):
// - 浮层分"进行中 / 已结束"两段,已结束可折叠、可清空(纯本地隐藏,与 web clearedKeys 一致,
//   宿主注册表照旧保留记录);
// - running 行与详情带停止键,原生 confirm 二次确认(与侧栏"归档运行中会话"同一交互)后调 job/kill;
// - 详情订阅 job/follow 看实时输出(保留尾部 128K),关闭详情即取消订阅;
// - 详情把宿主 detail 里的退出码 / 信号拆成独立字段,退出码非 0 标红。
import { t } from "../../shared/i18n.js";
import { RPC, STREAM } from "../../platform/dsh/rpc-methods.js";
import { openCardDetail } from "../chat/card-detail.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/// 渲染尾部上限(UTF-16 码元)。对齐 web RENDER_TAIL_LIMIT / Mac ObservedJobOutput.tailLimit。
export const JOB_OUTPUT_TAIL_LIMIT = 128 * 1024;

/// job/follow 的逻辑流 id 前缀。详情一次只开一个(与 Mac StreamID.jobOutput 同口径)。
const FOLLOW_PREFIX = "jobfollow:";

/// 无任务时的稳定空数组:set() 靠数组身份判断名册是否变了。
const NO_JOBS = Object.freeze([]);

/// 任务是否还开着(计时会走)。对齐 web isLive。
export function isLiveJob(job) {
  return job?.status === "running" || job?.status === "stopping";
}

/// 是否有输出可看:活着的任务(输出还可能来),或已结束但留下了保留输出。对齐 web isObservable。
export function isObservableJob(job) {
  return isLiveJob(job) || (Number(job?.output?.total) || 0) > 0;
}

/// 状态旁的一行说明:运行中报进度,结束后报终态原因。对齐 web jobDetail / Mac qualifier。
export function jobQualifier(job) {
  return job?.progress ?? job?.detail;
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

/// 分段:进行中全部保留;已结束的去掉用户清空过的。对齐 web liveRows / settledRows。
export function splitJobSections(jobs, cleared = new Set()) {
  const live = [];
  const settled = [];
  for (const job of orderedJobs(jobs)) {
    if (isLiveJob(job)) live.push(job);
    else if (!cleared.has(String(job.id))) settled.push(job);
  }
  return { live, settled };
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

/// 把宿主的终态原因(`exit code: 3`、`signal: SIGTERM; cancelled by the user`)拆成
/// 退出码、信号和剩余文字。对齐 Mac JobTermination(web 的字段来源同为 JobView.detail)。
export function parseJobTermination(detail) {
  let exitCode = null;
  let signal = null;
  const rest = [];
  for (const part of String(detail ?? "").split(";")) {
    const piece = part.trim();
    if (exitCode == null && piece.startsWith("exit code:")) {
      const value = piece.slice("exit code:".length).trim();
      if (/^-?\d+$/.test(value)) { exitCode = Number(value); continue; }
    }
    if (signal == null && piece.startsWith("signal:")) {
      const value = piece.slice("signal:".length).trim();
      if (value && value !== "null") signal = value;
      continue;
    }
    if (piece) rest.push(piece);
  }
  return { exitCode, signal, remainder: rest.length ? rest.join("; ") : null };
}

/// job/follow 观测的初始视图。对齐 web ObservedJob。
export function emptyJobOutput() {
  return { text: "", gapBefore: false, streaming: true, error: null };
}

/// 折叠一帧 job/follow。对齐 Mac StreamCoordinator.handleJobOutput:
/// - opened:重开(含断线重连)从最早保留字节重放,所以正文清零;锚点不在 0 或落在
///   earliest 之前 = 头部已被淘汰,记 gap;
/// - output:拼接 chunk,lossy / chunk.gapBefore 记 gap;超出 128K 只留尾部(不劈开代理对)并记 gap;
/// - status:终态,流随后正常关闭。
export function reduceJobOutput(state, frame) {
  switch (frame?.type) {
    case "opened": {
      const from = Number(frame.from) || 0;
      const earliest = Number(frame.job?.output?.earliest) || 0;
      return { text: "", gapBefore: from > 0 || from < earliest, streaming: true, error: null };
    }
    case "output": {
      const chunks = Array.isArray(frame.chunks) ? frame.chunks : [];
      let text = state.text + chunks.map((chunk) => chunk?.text ?? "").join("");
      let gapBefore = state.gapBefore || frame.lossy === true || chunks.some((chunk) => chunk?.gapBefore === true);
      if (text.length > JOB_OUTPUT_TAIL_LIMIT) {
        let cut = text.length - JOB_OUTPUT_TAIL_LIMIT;
        const unit = text.charCodeAt(cut);
        if (unit >= 0xDC00 && unit <= 0xDFFF) cut += 1;
        text = text.slice(cut);
        gapBefore = true;
      }
      return { ...state, text, gapBefore };
    }
    case "status":
      return { ...state, streaming: false };
    default:
      return state;
  }
}

function elapsedOf(job, now) {
  return isLiveJob(job) ? now - (job.startedAt ?? now) : (job.finishedAt ?? job.startedAt ?? 0) - (job.startedAt ?? 0);
}

function formatClock(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString();
}

/// 任务详情字段表:对齐 Mac CardDetailSheet 的 backgroundJob 字段表。
/// stop 是状态行尾的停止键(仅 running 时由调用方给出)。
export function buildJobDetail(job, duration, { stop = null } = {}) {
  // 运行中不拆:progress 覆盖 detail,与 Mac `JobTermination(job.progress == nil ? job.detail : nil)` 一致。
  const termination = parseJobTermination(job.progress == null ? job.detail : null);
  const remainder = job.progress ?? termination.remainder;
  const rows = [
    [t("jobs.detailKind"), job.kind],
    [t("jobs.detailId"), job.id],
    [t("jobs.detailStatus"), jobStatusLabel(job.status), stop],
    [t("jobs.detailStarted"), Number.isFinite(job.startedAt) ? formatClock(job.startedAt) : null],
    [t("jobs.detailFinished"), Number.isFinite(job.finishedAt) ? formatClock(job.finishedAt) : null],
    [t("jobs.detailDuration"), duration, null, "jobs-detail-duration"],
    [t("jobs.detailExitCode"), termination.exitCode, null, termination.exitCode ? "exit-nonzero" : ""],
    [t("jobs.detailSignal"), termination.signal],
    [t("jobs.detailDetail"), remainder ?? t("jobs.detailUnavailable")]
  ];
  const list = el("dl", "jobs-detail");
  for (const [key, value, extra, modifier] of rows) {
    if (value == null || value === "") continue;
    list.append(el("dt", "jobs-detail-label", key));
    const cell = el("dd", modifier ? `jobs-detail-value ${modifier}` : "jobs-detail-value", String(value));
    if (extra) cell.append(extra);
    list.append(cell);
  }
  return list;
}

/// 挂载后台任务入口。
/// @param trigger header 里的按钮(chip)
/// @param menu    popover 容器
/// @param options.connection   DSH 连接(call / subscribe / unsubscribe / onFrame),停止与实时输出用
/// @param options.getSessionId 当前会话 id(任务名册属于它)
/// @param options.notify       失败提示(toast)
export function mountJobList(trigger, menu, { connection = null, getSessionId = () => null, notify = () => {} } = {}) {
  let current = NO_JOBS;
  // 首个 set() 无论名册是否为空都要跑一遍 sync(把触发钮藏起来 / 写计数)。
  let synced = false;
  let timer = null;
  let menuOpen = false;
  // 用户清空过的已结束任务 id。任务 id 由宿主注册表进程内唯一发号,跨会话不会撞,
  // 所以一个集合就够(对齐 web clearedKeys:只在本地隐藏)。
  const cleared = new Set();
  // 已结束段的折叠:用户点过就听用户的;没点过时,有进行中任务才折叠。对齐 web settledOpen。
  let settledOpen;
  // 已获准的停止请求:按钮保持禁用,直到 job/list 把该行翻出 running(对齐 web pending 相)。
  const pendingKills = new Set();
  // 当前打开的详情:{ jobId, sessionId, job, root, fields, output, streamId, state, gone }。
  let detail = null;

  const visibleJobs = () => current.filter((job) => isLiveJob(job) || !cleared.has(String(job.id)));

  function stopTimer() {
    if (timer == null) return;
    clearInterval(timer);
    timer = null;
  }

  // 计时只在"有人看 + 有活动任务"时走:全结束的列表不需要每秒重画。
  function scheduleTimer() {
    const watching = (menuOpen && current.some(isLiveJob)) || (detail != null && isLiveJob(detail.job));
    if (!watching) { stopTimer(); return; }
    if (timer != null) return;
    timer = setInterval(tick, 1000);
  }

  // 每秒只改计时文字,不重建节点:重建会吞掉正按在停止键 / 行上的那次点击。
  function tick() {
    const now = Date.now();
    if (menuOpen) {
      const live = new Map(current.filter(isLiveJob).map((job) => [String(job.id), job]));
      for (const line of menu.querySelectorAll(".jobs-row-line")) {
        const job = live.get(line.dataset.jobId);
        const time = job && line.querySelector(".jobs-row-time");
        if (!time) continue;
        const duration = formatJobDuration(elapsedOf(job, now));
        time.textContent = duration;
        time.title = t("jobs.durationTitleLive", { d: duration });
      }
    }
    if (detail && isLiveJob(detail.job)) {
      const cell = detail.fields.querySelector(".jobs-detail-duration");
      if (cell) cell.textContent = formatJobDuration(elapsedOf(detail.job, now));
    }
  }

  // ---- 停止(job/kill) ----

  async function requestKill(job) {
    const sessionId = getSessionId();
    const jobId = String(job.id);
    if (!connection || !sessionId || pendingKills.has(jobId)) return;
    if (!window.confirm(t("jobs.stopConfirm", { label: job.label || jobId }))) return;
    pendingKills.add(jobId);
    repaint();
    try {
      // 回包 {outcome:"requested"|"already-finished"} 都算获准;行状态由 job/list 帧收敛。
      await connection.call(RPC.jobKill, { request: { sessionId, jobId } });
    } catch (error) {
      pendingKills.delete(jobId);
      repaint();
      notify(error?.code === "job/not-found"
        ? t("jobs.killNotFound")
        : t("jobs.killFailed", { error: error?.message || String(error) }));
    }
  }

  function stopButton(job) {
    const button = el("button", "jobs-stop act-btn");
    button.type = "button";
    const pending = pendingKills.has(String(job.id));
    button.disabled = pending;
    const label = pending ? jobStatusLabel("stopping") : t("jobs.stop", { label: job.label || job.id });
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(el("span", "jobs-stop-glyph"));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void requestKill(job);
    });
    return button;
  }

  // ---- 浮层 ----

  function row(job, now) {
    const live = isLiveJob(job);
    const duration = formatJobDuration(elapsedOf(job, now));
    const statusText = jobQualifier(job) ?? jobStatusLabel(job.status);
    const line = el("div", "jobs-row-line");
    line.dataset.jobId = String(job.id);
    const main = el("button", live ? "jobs-row" : "jobs-row settled");
    main.type = "button";
    main.title = t("jobs.openHint");
    main.setAttribute("aria-label", [job.kind, job.label, statusText, duration].filter(Boolean).join(" "));
    main.append(el("span", "jobs-row-dot state-" + jobDotState(job.status)));
    main.append(el("span", "jobs-row-kind", job.kind ?? ""));
    main.append(el("span", "jobs-row-label", job.label ?? job.id ?? ""));
    main.append(el("span", "jobs-row-status", statusText));
    const time = el("span", "jobs-row-time", duration);
    time.title = t(live ? "jobs.durationTitleLive" : "jobs.durationTitleDone", { d: duration });
    main.append(time);
    main.addEventListener("click", () => {
      menu.hidePopover?.();
      openDetail(job);
    });
    line.append(main);
    if (job.status === "running" && connection) line.append(stopButton(job));
    return line;
  }

  function render() {
    menu.replaceChildren();
    const { live, settled } = splitJobSections(current, cleared);
    if (!live.length && !settled.length) return;
    const now = Date.now();
    const listEl = el("div", "jobs-list");
    if (live.length) {
      listEl.append(el("div", "jobs-section-head", t("jobs.sectionLive")));
      for (const job of live) listEl.append(row(job, now));
    }
    if (settled.length) {
      const expanded = settledOpen ?? live.length === 0;
      const head = el("div", "jobs-section-head");
      const toggle = el("button", "jobs-section-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.append(el("span", expanded ? "jobs-section-chevron open" : "jobs-section-chevron"));
      toggle.append(document.createTextNode(t("jobs.sectionSettled", { n: String(settled.length) })));
      toggle.addEventListener("click", () => { settledOpen = !expanded; render(); });
      const clear = el("button", "jobs-section-clear", t("jobs.sectionClear"));
      clear.type = "button";
      clear.addEventListener("click", () => {
        for (const job of settled) cleared.add(String(job.id));
        sync();
      });
      head.append(toggle, clear);
      listEl.append(head);
      if (expanded) for (const job of settled) listEl.append(row(job, now));
    }
    menu.append(listEl);
  }

  // ---- 详情(字段 + 实时输出) ----

  function paintDetailFields() {
    if (!detail) return;
    const { job } = detail;
    const stop = job.status === "running" && connection && !detail.gone ? stopButton(job) : null;
    const fields = buildJobDetail(job, formatJobDuration(elapsedOf(job, Date.now())), { stop });
    detail.fields.replaceWith(fields);
    detail.fields = fields;
  }

  function paintDetailOutput() {
    const output = detail?.output;
    if (!output) return;
    const { state } = detail;
    output.live.hidden = !state.streaming;
    output.gap.hidden = !state.gapBefore;
    output.error.hidden = !state.error;
    if (state.error) output.error.textContent = t("jobs.outputError", { error: state.error });
    const pre = output.text;
    // 贴底跟随:用户往上翻看时不把他拽回底部。
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
    const empty = !state.text;
    pre.classList.toggle("empty", empty);
    pre.textContent = empty && !state.streaming ? t("jobs.outputNone") : state.text;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function buildOutputPanel() {
    const panel = el("section", "jobs-output");
    const head = el("div", "jobs-output-head");
    head.append(el("span", "jobs-output-title", t("jobs.outputTitle")));
    const live = el("span", "jobs-output-live");
    head.append(live);
    const gap = el("div", "jobs-output-note", t("jobs.outputGap"));
    const error = el("div", "jobs-output-note error");
    const text = el("pre", "jobs-output-text");
    panel.append(head, gap, error, text);
    return { panel, live, gap, error, text };
  }

  function closeDetail(target) {
    if (!target || detail !== target) return;
    if (target.streamId) connection?.unsubscribe?.(target.streamId);
    detail = null;
    scheduleTimer();
  }

  /// 打开一条任务的详情(点击浮层行)。对齐 Mac:点行进 CardDetailSheet;
  /// 可观测的任务在详情里订阅 job/follow,关详情即取消订阅(web:输出只在有人看时流动)。
  function openDetail(job) {
    closeDetail(detail);
    const sessionId = getSessionId();
    const root = el("div", "jobs-detail-view");
    const fields = el("dl", "jobs-detail");
    root.append(fields);
    const target = {
      jobId: String(job.id), sessionId, job, root, fields,
      output: null, streamId: null, state: emptyJobOutput(), gone: false
    };
    detail = target;
    paintDetailFields();
    if (connection && isObservableJob(job)) {
      target.output = buildOutputPanel();
      root.append(target.output.panel);
      target.streamId = FOLLOW_PREFIX + target.jobId;
      connection.subscribe?.(target.streamId, STREAM.jobFollow, {
        request: sessionId ? { sessionId, jobId: target.jobId } : { jobId: target.jobId }
      });
      paintDetailOutput();
    }
    const dialog = openCardDetail({
      title: job.label || job.kind || t("jobs.title"),
      build: () => root,
      // 复制键给命令本身(web TerminalBlock copyText=job.label / Mac "复制命令")。
      copyText: job.label || null
    });
    dialog?.addEventListener?.("close", () => closeDetail(target), { once: true });
    scheduleTimer();
  }

  function handleFrame(frame) {
    if (!detail?.streamId || frame?.streamId !== detail.streamId) return;
    if (frame.type === "item") detail.state = reduceJobOutput(detail.state, frame.value);
    else if (frame.type === "error") {
      detail.state = { ...detail.state, streaming: false, error: frame.error?.message || String(frame.error ?? "") };
    } else if (frame.type === "end") detail.state = { ...detail.state, streaming: false };
    else return;
    paintDetailOutput();
  }
  connection?.onFrame?.(handleFrame);

  // ---- 名册同步 ----

  /// 浮层 + 详情按当前状态重画(停止请求的 pending 翻转也走这里)。
  function repaint() {
    if (menuOpen) render();
    if (detail) paintDetailFields();
  }

  function sync() {
    const visible = visibleJobs();
    trigger.hidden = visible.length === 0;
    const label = jobCountLabel(visible);
    const dot = trigger.querySelector(".jobs-dot");
    if (dot) dot.hidden = !visible.some(isLiveJob);
    const text = trigger.querySelector(".jobs-label");
    if (text) text.textContent = label;
    trigger.setAttribute("aria-label", label || t("jobs.title"));
    if (trigger.hidden) {
      menu.replaceChildren();
      menu.hidePopover?.();
    } else if (menuOpen) {
      render();
    }
    scheduleTimer();
  }

  // popover 由 popovertarget 打开,这里只在开合时补画/停表。
  menu.addEventListener?.("toggle", (event) => {
    menuOpen = event.newState === "open";
    if (menuOpen) render();
    scheduleTimer();
  });

  return {
    set(jobs) {
      const next = Array.isArray(jobs) ? jobs : NO_JOBS;
      // 每次运行时快照(含流式 token)都会走到这里;名册数组没换就什么都不用做。
      if (synced && next === current) return;
      synced = true;
      current = next;
      // 行已翻出 running(stopping / 结束 / 被移除)的停止请求退场。
      for (const jobId of pendingKills) {
        if (!current.some((job) => String(job.id) === jobId && job.status === "running")) pendingKills.delete(jobId);
      }
      if (detail) {
        const fresh = current.find((job) => String(job.id) === detail.jobId);
        // 行离开名册(拥有者 teardown)时保留最后一次投影,只是不再给停止键。
        if (fresh) detail.job = fresh;
        detail.gone = !fresh;
        paintDetailFields();
      }
      sync();
    }
  };
}
