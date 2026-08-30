// 会话行尾部内容的判定 —— 从 macOS 的 Models/SessionRowTrailing.swift 照搬,
// 包括优先级与每条规则背后的理由,以便两端行为一致、日后能对着同一份语义改。
//
// 每一个警示徽章都在回答同一个问题:哪个**不在屏幕上**的会话需要你处理?
// 已打开的那个会话,它的审批卡和草稿本身就完整地摆在眼前、就地可操作 ——
// 在行上再复述一遍等于把用户正看着的东西又说一次。所以选中行永远不出警示,
// 只保留时间戳;只有未选中的行才会升起徽章。

/// 是哪一类阻塞请求把这个会话的当前轮卡住了。
///
/// 之所以分成两种而不是合并成一个「需要你」标志:行上是以文字呈现的,
/// 「回答问题」和「批准操作」是两件不同的事,用户扫一眼侧栏就是靠这个差别
/// 决定先开哪一行。
export const SessionAwaitingKind = Object.freeze({
  /// 某个工具调用正在等待用户批准。
  approval: "approval",
  /// agent 提了问题,正在等用户回答。
  question: "question"
});

export const SessionRowTrailingKind = Object.freeze({
  awaitingUser: "awaitingUser",
  draft: "draft",
  time: "time",
  none: "none"
});

/// 判定一行尾部应该渲染什么。
///
/// @param awaitingUser 把该会话当前轮卡住的请求类型;没有挂起时为 null。
/// @param isSelected   这一行是否就是当前打开的会话。打开着的会话本身就直接展示
///                     所有挂起请求与自己的草稿,所以它不升起任何警示、保留时间戳。
/// @param isArchived   是否是已归档的会话行。
/// @param isBlank      是否是尚未运行过的临时「新会话」行。
/// @param hasDraft     该会话输入框里是否有未发送的文字。
/// @param updatedAt    会话最后变更时间(毫秒)。
/// @returns {{kind: string, awaiting?: string, updatedAt?: number}}
export function resolveSessionRowTrailing({
  awaitingUser = null,
  isSelected = false,
  isArchived = false,
  isBlank = false,
  hasDraft = false,
  updatedAt = 0
} = {}) {
  if (isArchived || isBlank) return { kind: SessionRowTrailingKind.none };
  // 用一道统一的闸门,而不是在每个分支里各写一次 !isSelected:
  // 打开着的会话已经把徽章想说的内容显示出来了,那里的警示纯属重复 ——
  // 而且以后新增的警示会自动继承这条规则,不必再去记得加判断。
  if (isSelected) return { kind: SessionRowTrailingKind.time, updatedAt };
  // 卡住的轮次优先于草稿:在用户回应之前会话根本无法前进,
  // 而草稿只是等用户把话说完。
  if (awaitingUser) return { kind: SessionRowTrailingKind.awaitingUser, awaiting: awaitingUser };
  if (hasDraft) return { kind: SessionRowTrailingKind.draft };
  return { kind: SessionRowTrailingKind.time, updatedAt };
}

/// 这一行是否正在报告一个被卡住的轮次(不论是哪一类请求)。
/// 只关心「尾部是否已经带了警示」的调用方(比如状态点的抑制)问这个,
/// 而不用去逐一匹配类型、日后也不必记得补新增的那一种。
export function isAwaitingUserTrailing(trailing) {
  return trailing?.kind === SessionRowTrailingKind.awaitingUser;
}

// 相对时间分档与 macOS SidebarRoot.relativeTime 一致。
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/// 把毫秒时间戳格式化成侧栏那种短相对时间。
/// @param tFn 取文案的函数(key, params) => string。
export function formatRelativeTime(ms, tFn, now = Date.now()) {
  const diff = Math.max(0, now - (Number(ms) || 0));
  if (diff < MINUTE) return tFn("time.now");
  // 饱和取整:摘要里如果带了非有限或离谱的 updatedAt,会落到最后一档,
  // 这里统一走 displayInt 语义,避免出现 NaN/Infinity 这样的显示。
  if (diff < HOUR) return tFn("time.minutes", { n: displayInt(diff / MINUTE) });
  if (diff < DAY) return tFn("time.hours", { n: displayInt(diff / HOUR) });
  if (diff < 30 * DAY) return tFn("time.days", { n: displayInt(diff / DAY) });
  if (diff < 365 * DAY) return tFn("time.months", { n: displayInt(diff / (30 * DAY)) });
  return tFn("time.years", { n: displayInt(diff / (365 * DAY)) });
}

/// 对齐 macOS WireNumbers.displayInt:NaN → 0,超界饱和,其余取整。
function displayInt(value) {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 0 : Number.MAX_SAFE_INTEGER;
  return Math.trunc(value);
}
