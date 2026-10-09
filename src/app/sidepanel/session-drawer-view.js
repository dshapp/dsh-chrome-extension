// 左侧会话抽屉的列表渲染。
//
// 从 sidepanel-overlays.js 抽出来:那个文件负责的是抽屉的**行为**(开关、搜索、
// 键盘、行操作、拖拽接线),而这里只负责把 buildSidebarSections 算出来的分区
// 画成 DOM。两者的变更理由不同,合在一处也会把那个文件顶过 400 行的硬上限。
//
// 视觉与结构对齐 macOS 侧栏(SidebarRoot):
//   置顶区标题 → 置顶行 → 「工作区/会话」分区标题(带视图选项与添加目录)
//   → 分组标题(可折叠)→ 会话行 → 「展开其余 N 个会话」。
// 单列表模式没有分组标题,行直接跟在分区标题下面。
import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/md-to-html.js";
import { lucideIconSvg } from "../../features/chat/file-icons.js";
import {
  resolveSessionRowTrailing, formatRelativeTime,
  SessionRowTrailingKind, SessionAwaitingKind
} from "../../features/sessions/session-row-trailing.js";
import {
  resolveSessionRowStatus, shouldShowSessionRowStatus, SessionRowStatus
} from "../../features/sessions/session-row-status.js";
import { HISTORY_ACTION_ICONS } from "./history-icons.js";
import { SidebarGroupBy, FLAT_GROUP_ID } from "../../features/sessions/sidebar-sections.js";
import { sessionTitle } from "../../features/sessions/session-search.js";

// 行首状态灯的无障碍/tooltip 文案。warning 一档不会真的渲染
//(shouldShowSessionRowStatus 会挡掉它,因为 trailing 已经把话说了),
// 但表里留着它,保持与 SessionRowStatus 同形、日后不会漏。
const STATUS_HELP_KEY = Object.freeze({
  [SessionRowStatus.ongoing]: "session.stateOngoing",
  [SessionRowStatus.error]: "session.stateError",
  [SessionRowStatus.done]: "session.stateCompleted",
  [SessionRowStatus.warning]: "session.awaitingApprovalHelp"
});

/// 分区标题行的 id:视图选项与"添加目录"两颗常驻按钮每次重画后都被搬回它里面
///(搬而不是重建 —— popover 的锚点与事件绑定都挂在那两个节点上)。
export const SECTION_HEAD_ID = "history-section-head";

export function itemTitle(item) {
  // session.list 的标题在 projections.values.title;无标题显示本地化「未命名」
  //(web 0.2 Rows.tsx `result.title || t('session.untitled')`),不再拿短 id 充标题。
  return sessionTitle(item) || t("sessions.untitled");
}

/// 行尾内容。徽章用文字而不是警示三角:三角只会说「看这里」,用户仍得点开才
/// 知道是要回答还是要授权 —— 而「待审批」和「待回答」是两件不同的事。
function trailingHtml(trailing) {
  switch (trailing.kind) {
    case SessionRowTrailingKind.awaitingUser: {
      const keys = {
        [SessionAwaitingKind.approval]: ["session.awaitingApproval", "session.awaitingApprovalHelp"],
        [SessionAwaitingKind.planReview]: ["session.awaitingPlanReview", "session.awaitingPlanReviewHelp"],
        [SessionAwaitingKind.question]: ["session.awaitingQuestion", "session.awaitingQuestionHelp"]
      };
      const [labelKey, helpKey] = keys[trailing.awaiting] ?? keys[SessionAwaitingKind.question];
      const label = t(labelKey);
      const help = t(helpKey);
      return `<span class="h-badge h-badge-warn" title="${escapeHtml(help)}" aria-label="${escapeHtml(help)}">${escapeHtml(label)}</span>`;
    }
    case SessionRowTrailingKind.draft: {
      // 单独一个词,免得读成上面那类通知:这是用户自己没写完的句子,
      // 不是会话向他发出的请求。
      const help = t("session.hasDraftHelp");
      return `<span class="h-badge h-badge-warn" title="${escapeHtml(help)}" aria-label="${escapeHtml(help)}">${escapeHtml(t("session.hasDraft"))}</span>`;
    }
    case SessionRowTrailingKind.time:
      return `<span class="h-when">${escapeHtml(formatRelativeTime(trailing.updatedAt, t))}</span>`;
    default:
      return "";
  }
}

/// 行首状态槽位。永远渲染一个等宽的 span,即使不点灯 —— 有灯和没灯的行标题
/// 必须左对齐,否则列表会随状态变化左右跳动(对齐 macOS 用 Color.clear 占住
/// statusSlotWidth 的做法)。置顶行在不点灯时用一枚图钉占住同一个槽位。
function statusHtml(status, show, pinned) {
  if (show) {
    const help = t(STATUS_HELP_KEY[status] ?? "session.stateOngoing");
    const safe = escapeHtml(help);
    return `<span class="h-state h-state-${status}" role="img" title="${safe}" aria-label="${safe}"></span>`;
  }
  if (pinned) {
    const safe = escapeHtml(t("sessions.groupPinned"));
    return `<span class="h-state h-state-pin" role="img" title="${safe}" aria-label="${safe}">${lucideIconSvg("pin", { size: 10 })}</span>`;
  }
  return '<span class="h-state h-state-idle" aria-hidden="true"></span>';
}

/// 一行会话。ctx 提供实时状态(挂起/草稿/未读)与当前选中态。
/// grouped=true 时行会缩进一格,让"谁属于哪个组"一眼可见(Mac 靠 List 原生缩进)。
function rowHtml(item, { index, groupId, grouped = false, ctx }) {
  const { listStore, activeSessionId, selectedIndex, shortcutLabels, draggable, pinnedStore } = ctx;
  const hint = shortcutLabels && index < 9 ? shortcutLabels.historyItem(index + 1) : "";
  const trailing = resolveSessionRowTrailing({
    awaitingUser: listStore?.awaitingUser(item.sessionId) ?? null,
    isSelected: item.sessionId === activeSessionId,
    isArchived: Boolean(item.archived),
    isBlank: Boolean(item.blank),
    hasDraft: listStore?.hasDraft(item.sessionId) ?? false,
    updatedAt: item.updatedAt ?? Date.now()
  });
  // 行首状态灯的判定全在 session-row-status.js 里,与 macOS 同一份语义:
  // 挂起 > 失败 > 自身在跑 > 子代理在跑 > 空闲,且徽章已报「卡住」时不点灯。
  const status = resolveSessionRowStatus({
    awaitingUser: listStore?.awaitingUser(item.sessionId) ?? null,
    running: Boolean(item.running),
    errored: listStore?.isErrored?.(item.sessionId) ?? false,
    runningSubagentRoot: listStore?.isRunningSubagentRoot?.(item.sessionId) ?? false
  });
  const showStatus = shouldShowSessionRowStatus({
    status,
    completed: listStore?.isCompleted?.(item.sessionId) ?? false,
    trailing,
    isArchived: Boolean(item.archived),
    isBlank: Boolean(item.blank)
  });
  const pinned = Boolean(pinnedStore?.isPinned?.(item.sessionId));
  const title = itemTitle(item);
  // 空白(blank)行是"还什么都没发生"的临时行:分叉/重命名/归档都会作用在
  // 不存在的内容上,所以和 Mac 一样对它关掉整排行操作。
  const actions = item.blank ? "" : [
    `<span class="h-actions">`,
    actionButton("pin", pinned ? "sessions.unpin" : "sessions.pin", pinned ? "pin-off" : "pin"),
    `<button type="button" data-action="fork" title="${escapeHtml(t("fork"))}" aria-label="${escapeHtml(t("fork"))}">${HISTORY_ACTION_ICONS.fork}</button>`,
    `<button type="button" data-action="rename" title="${escapeHtml(t("rename"))}" aria-label="${escapeHtml(t("rename"))}">${HISTORY_ACTION_ICONS.rename}</button>`,
    `<button type="button" data-action="archive" title="${escapeHtml(t("session.archive"))}" aria-label="${escapeHtml(t("session.archive"))}">${HISTORY_ACTION_ICONS.archive}</button>`,
    `</span>`
  ].join("");
  return [
    `<li class="history-item${grouped ? " in-group" : ""}${item.sessionId === activeSessionId ? " active" : ""}${index === selectedIndex ? " selected" : ""}"`,
    ` data-session-id="${escapeHtml(item.sessionId)}" data-index="${index}" data-group-id="${escapeHtml(groupId)}"`,
    draggable ? ' draggable="true"' : "",
    `>`,
    statusHtml(status, showStatus, pinned),
    `<span class="h-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>`,
    `<span class="h-when-row"><kbd class="shortcut-hint hist-shortcut-hint" aria-hidden="true">${escapeHtml(hint)}</kbd>${trailingHtml(trailing)}</span>`,
    actions,
    `</li>`
  ].join("");
}

function actionButton(action, labelKey, icon) {
  const label = escapeHtml(t(labelKey));
  return `<button type="button" data-action="${action}" title="${label}" aria-label="${label}">${lucideIconSvg(icon, { size: 13 })}</button>`;
}

/// 分区标题(置顶 / 工作区 / 会话)。工作区那一行右侧留一个常驻动作槽,
/// 由调用方把「视图选项」「添加目录」两颗按钮搬进去。
function sectionHeadHtml(label, { withActions = false } = {}) {
  return [
    `<li class="history-section"${withActions ? ` id="${SECTION_HEAD_ID}"` : ""}>`,
    `<span class="history-section-title">${escapeHtml(label)}</span>`,
    withActions ? '<span class="history-section-actions"></span>' : "",
    `</li>`
  ].join("");
}

/// 分组标题:整行可点折叠。组名靠左顶格(与下面的会话行同一条阅读起点),
/// 行数与随折叠态翻转的 chevron 都收在右端 —— 左边只留文字,扫读一列组名时
/// 不会被一排三角打断。
///
/// 真实 workspace 的标题可拖(ctx.groupDraggable),用来调整分组顺序 —— 置顶区与
/// 「未分组」不是 workspace,不参与。data-group-kind 给拖拽模块区分这三种。
function groupHeadHtml(section, { draggable = false } = {}) {
  const label = section.title ?? t("sessions.groupUngrouped");
  const chevron = lucideIconSvg(section.collapsed ? "chevron-right" : "chevron-down", { size: 12 });
  return [
    `<li class="history-group${section.collapsed ? " collapsed" : ""}" data-group-id="${escapeHtml(section.id)}"`,
    ` data-group-kind="${escapeHtml(section.kind)}"`,
    draggable && section.kind === "workspace" ? ' draggable="true"' : "",
    ` role="button" tabindex="-1" aria-expanded="${section.collapsed ? "false" : "true"}"`,
    section.hint ? ` title="${escapeHtml(section.hint)}"` : "",
    `>`,
    `<span class="history-group-title">${escapeHtml(label)}</span>`,
    `<span class="history-group-count">${section.total}</span>`,
    `<span class="history-group-chevron" aria-hidden="true">${chevron}</span>`,
    `</li>`
  ].join("");
}

/// 「展开其余 N 个会话」/「收起」。
function showMoreHtml(section) {
  const label = section.expanded
    ? t("sessions.collapse")
    : t("sessions.expand", { n: String(section.hiddenCount) });
  return `<li class="history-more-row" data-group-id="${escapeHtml(section.id)}" role="button" tabindex="-1">${escapeHtml(label)}</li>`;
}

/**
 * 画出整份分区列表。
 *
 * @param {Element} list `<ul>` 容器。
 * @param {object} options
 * @param {Array} options.sections buildSidebarSections 的产物。
 * @param {string} options.groupBy 当前分组轴(决定分区标题叫「工作区」还是「会话」)。
 * @param {object} options.ctx 行渲染上下文(见 rowHtml)。
 * @returns {Array} 实际画出来的行(按渲染顺序),供键盘导航与拖拽使用。
 */
export function renderSections(list, { sections, groupBy, ctx }) {
  const rendered = [];
  const html = [];
  let sectionHeadWritten = false;
  for (const section of sections) {
    if (section.kind === "pinned") {
      html.push(sectionHeadHtml(t("sessions.groupPinned")));
    } else if (!sectionHeadWritten) {
      // 「工作区 / 会话」这一行只出现一次,且必须排在置顶区之后(Mac 的顺序:
      // 置顶是用户的安排,排在分组轴之上)。
      html.push(sectionHeadHtml(
        groupBy === SidebarGroupBy.flat ? t("sessions.sectionSessions") : t("sessions.sectionWorkspaces"),
        { withActions: true }
      ));
      sectionHeadWritten = true;
    }
    if (section.kind === "workspace" || section.kind === "ungrouped") {
      html.push(groupHeadHtml(section, { draggable: Boolean(ctx?.groupDraggable) }));
    }
    const grouped = section.kind === "workspace" || section.kind === "ungrouped";
    for (const item of section.rows) {
      html.push(rowHtml(item, { index: rendered.length, groupId: section.id, grouped, ctx }));
      rendered.push(item);
    }
    if (section.hiddenCount > 0) {
      // 单列表的截断不是"折起来了",而是"太多了":它没有展开按钮,只提示
      // 继续输入以筛选(与搜索结果的溢出提示同一句)。
      html.push(section.kind === "flat"
        ? `<li class="history-more">${escapeHtml(t("sessions.more", { n: String(section.hiddenCount) }))}</li>`
        : showMoreHtml(section));
    }
  }
  if (!sectionHeadWritten) {
    html.push(sectionHeadHtml(
      groupBy === SidebarGroupBy.flat ? t("sessions.sectionSessions") : t("sessions.sectionWorkspaces"),
      { withActions: true }
    ));
  }
  if (!rendered.length) html.push(`<li class="history-empty">${escapeHtml(t("sessions.empty"))}</li>`);
  list.innerHTML = html.join("");
  return rendered;
}

/**
 * 画搜索结果(平铺 —— 结果集取代名册,Mac 也是这样)。对齐 web SearchResults:
 * 宿主结果未到时是 pending(不说「无匹配」),到了且为空才说;hasMore 提示缩小范围。
 *
 * @param {Element} list `<ul>` 容器。
 * @param {object} options
 * @param {Array} options.items 结果行(已截断)。
 * @param {boolean} options.pending 宿主内容搜索是否还在路上。
 * @param {boolean} options.hasMore 是否还有未显示的命中。
 * @param {number} options.limit 结果上限(提示文案用)。
 * @param {object} options.ctx 行渲染上下文。
 * @returns {Array} 实际画出来的行。
 */
export function renderResultRows(list, { items, pending = false, hasMore = false, limit = 0, ctx }) {
  let html = items.map((item, index) => rowHtml(item, { index, groupId: FLAT_GROUP_ID, ctx })).join("");
  if (pending) html += loadingHtml(t("sessions.searchPending"));
  else if (!items.length) html += `<li class="history-empty">${escapeHtml(t("sessions.noMatches"))}</li>`;
  if (hasMore) html += `<li class="history-more">${escapeHtml(t("sessions.searchHasMore", { n: String(limit) }))}</li>`;
  list.innerHTML = html;
  return [...items];
}

/// 冷启动还没有任何基线时的加载态。
export function renderLoading(list) {
  list.innerHTML = loadingHtml(t("sessions.loading"));
}

function loadingHtml(label) {
  return `<li class="history-loading" role="status" aria-live="polite"><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>${escapeHtml(label)}</li>`;
}
