// 侧栏会话行的「状态优先」排序(orderBy: "status")。
//
// 从 macOS 的 SessionStatusOrder.swift 照搬,包括层级顺序与每一档背后的理由,
// 以便两端行为一致、日后能对着同一份语义改。
//
// 另外两种排序回答的是「用户把它放哪了」(manual)与「什么最近变过」(updated);
// 这一种回答的是「什么最需要我」:行按"在做什么/在等什么"分档,只有同档之内
// 才由时间决定先后。
//
// 排序规则住在这里而不是列表视图里,理由有三:档位顺序是**产品规则**,值得一个
// 有名字的家;不止一个界面要复现它;纯函数不需要 DOM 就能测。

/// 一个会话在等什么/在做什么,按"多想要用户注意"排序。数值即排序键,小的在前。
///
/// 声明顺序**就是**产品规则 —— 从上到下就是侧栏里从上到下的顺序。
export const SessionStatusRank = Object.freeze({
  /// 有一轮正在跑 —— 自己的,或某个子代理后裔的。
  running: 0,
  /// 用户不在时跑完了,而且是以错误收尾。
  failedUnread: 1,
  /// 用户不在时跑完了。
  doneUnread: 2,
  /// 一个工具调用卡在用户的审批上。
  approval: 3,
  /// 一个提问卡在用户的回答上。
  question: 4,
  /// 输入框里有用户打了但没发出去的字。
  ///
  /// 排在上面每一档之下:那些都是**别人**(agent,或一个只有用户能做的决定)
  /// 被挡住了在等;没发出的草稿谁也没挡,是用户自己没写完的事 ——
  /// 但仍高于"无事可报",所以还在 idle 之上。
  draft: 5,
  /// 没什么好报的,纯按时间排。
  idle: 6
});

/**
 * 一个会话属于哪一档。
 *
 * 入参全是调用方手上已有的普通值,所以本函数不碰任何 store:
 * 事实从哪来由调用方决定,这里只决定这些事实**合起来是什么意思**。
 * 第一个命中的档位胜出 —— 一个会话同时是好几件事时(比如既在跑又带着未读完成),
 * 报最紧急的那一个。
 *
 * @param isRunning 自身或子代理后裔正在跑。
 * @param isUnread  用户不在时跑完了,且此后没再打开过。
 * @param didFail   那一轮以错误收尾(只在 isUnread 为真时有意义)。
 * @param awaiting  卡住这一轮的挂起请求类型;没有则为 null。
 * @param hasDraft  输入框有未发送文字。
 * @returns {number} SessionStatusRank 中的一档。
 */
export function rankSession({
  isRunning = false,
  isUnread = false,
  didFail = false,
  awaiting = null,
  hasDraft = false
} = {}) {
  if (isRunning) return SessionStatusRank.running;
  if (isUnread) return didFail ? SessionStatusRank.failedUnread : SessionStatusRank.doneUnread;
  // 集合是"有没有卡住"的权威,kind 表只负责起名 —— 所以没名字的标记仍按
  // approval 处理,与行首状态灯、行尾徽章用的是同一条兜底。
  if (awaiting === "question") return SessionStatusRank.question;
  if (awaiting) return SessionStatusRank.approval;
  if (hasDraft) return SessionStatusRank.draft;
  return SessionStatusRank.idle;
}

/**
 * 把可见子集按档位排序,同档之内按最近更新倒序。
 *
 * 每个会话的档位**预先算一次**,而不是在比较函数里算:一次排序会调用比较函数
 * O(n log n) 次,而 rank 的输入来自四次集合/字典查找。这个函数在每一帧名册更新时
 * 都会跑,所以这个差别是持续付出的(macOS 那边实测过这条路径吃满 CPU)。
 *
 * @param {Array} visible 待排序的行。
 * @param {(summary: any) => number} rankOf 解析单行的档位。
 * @returns {Array} 排好序的新数组(不改原数组)。
 */
export function sortByStatus(visible, rankOf) {
  return [...(visible ?? [])]
    .map((summary) => ({ rank: rankOf(summary), summary }))
    .sort((a, b) => (a.rank - b.rank) || ((b.summary.updatedAt ?? 0) - (a.summary.updatedAt ?? 0)))
    .map((entry) => entry.summary);
}
