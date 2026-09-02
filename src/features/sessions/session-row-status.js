// 会话行**行首**状态点的判定 —— 从 macOS 的 SidebarRoot.swift
// (SessionRow.sessionStatus / showStatus,以及它们对齐的 web StateDot)照搬,
// 包括优先级与每条规则背后的理由,以便两端行为一致、日后能对着同一份语义改。
//
// 与 session-row-trailing.js 的分工:那边回答「这一行右端要说什么话」
// (待审批 / 待回答 / 草稿 / 时间),这边回答「这一行左端要点什么灯」
// (正在跑 / 失败未读 / 跑完未读 / 什么都不点)。两者都是纯判定、不碰 DOM,
// 所以能单独测,也能被别的列表(搜索结果行)复用同一套语义。

export const SessionRowStatus = Object.freeze({
  /// 有挂起请求(审批/提问)把这一轮卡住了。
  warning: "warning",
  /// 上一轮以错误收尾,且用户还没回去看。
  error: "error",
  /// 这个会话(或它的某个子代理后裔)正在跑。
  ongoing: "ongoing",
  /// 没在跑、没失败、没卡住。
  done: "done"
});

/// 这一行的主状态。优先级严格照 macOS SessionRow.sessionStatus:
/// 挂起 > 失败 > 自身正在跑 > 子代理后裔正在跑 > 空闲。
///
/// 为什么挂起排在最前:一个卡在审批上的会话哪怕技术上还"在跑",
/// 用户要做的事也是去批准它,而不是等它 —— 状态该报最能指导下一步动作的那个。
///
/// 为什么失败排在正在跑之前:失败是上一轮的结论,正在跑是这一轮的事实。
/// 两者同时为真只可能出现在"失败后立刻重跑"的瞬间,而那时 setErrored(false)
/// 已经把失败位清掉了(见 session-service 的 turn/start 分支),
/// 所以这条优先级实际只在丢帧/乱序时兜底,让红点不被一个陈旧的 running 位盖住。
///
/// @param awaitingUser          挂起请求类型;没有挂起时为 null。
/// @param running               会话自身是否正在跑。
/// @param errored               上一轮是否以错误收尾且未读。
/// @param runningSubagentRoot   是否有子代理后裔正在跑(自身可能 idle)。
export function resolveSessionRowStatus({
  awaitingUser = null,
  running = false,
  errored = false,
  runningSubagentRoot = false
} = {}) {
  if (awaitingUser) return SessionRowStatus.warning;
  if (errored) return SessionRowStatus.error;
  if (running) return SessionRowStatus.ongoing;
  // 自身 idle 但后裔在跑:这一行仍然"有事在发生",对齐 web sessionStatuses
  // 与 macOS 的 runningSubagentRoots 分支 —— 否则派完活的父会话看起来像空闲的,
  // 用户会以为整条任务已经停了。
  if (runningSubagentRoot) return SessionRowStatus.ongoing;
  return SessionRowStatus.done;
}

/// 行首那盏灯到底渲不渲染。照搬 macOS SessionRow.showStatus。
///
/// 三条规则,各有各的理由:
///
/// 1. 归档 / 尚未跑过的空白行不点灯 —— 它们的 trailing 也是 none,
///    整行本来就不该报任何状态。
/// 2. 右端已经报了"卡住"就不点灯:那会是同一个警示色在一行上出现两次,
///    而 trailing 那句话才说清了到底要你做什么(对齐 macOS 的取舍)。
///    注意草稿**不**享受这个豁免:会话在跑、失败还是空闲,与用户有没有
///    在输入框里留下半句话是两件正交的事,两个事实都该留在行上。
/// 3. 其余情况:非 done 就点(在跑/失败/卡住),done 则只在带着
///    "跑完了你还没看"的未读提醒时点那颗绿点 —— 普通空闲行不点灯。
///
/// @param status    resolveSessionRowStatus 的结果。
/// @param completed 是否带着"跑完但未读"的提醒。
/// @param trailing  同一行 resolveSessionRowTrailing 的结果,用来做规则 2。
/// @param isArchived 是否是已归档的会话行。
/// @param isBlank    是否是尚未运行过的临时「新会话」行。
export function shouldShowSessionRowStatus({
  status = SessionRowStatus.done,
  completed = false,
  trailing = null,
  isArchived = false,
  isBlank = false
} = {}) {
  if (isArchived || isBlank) return false;
  if (isAwaitingTrailing(trailing)) return false;
  return status !== SessionRowStatus.done || completed;
}

/// 本地判定 trailing 是否为"卡住"那一类。
///
/// 有意不从 session-row-trailing.js import isAwaitingUserTrailing:那样会让
/// 这个纯判定模块反向依赖另一个功能域的模块。这里只需要认一个字符串常量,
/// 复制它比拉一条依赖便宜 —— 而两边一旦要改,改的是同一个 wire 值。
function isAwaitingTrailing(trailing) {
  return trailing?.kind === "awaitingUser";
}
