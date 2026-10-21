// 会话列表 store:session.list 基线 + host 帧(host/session-added、host/session-status、
// host/workspace-changed)增量维护。
import { rankSession, sortByStatus } from "./session-status-order.js";

/// 三种排序模式,对齐 macOS 的 sidebarOrderBy。
/// updated 是默认档 —— 它就是本 store 一直以来的行为。
export const SessionOrderBy = Object.freeze({
  manual: "manual",
  updated: "updated",
  status: "status"
});

export function createSessionListStore() {
  let summaries = [];
  // 只跟踪会话摘要本身的写入，供异步 session/list 判断等待期间是否已有
  // 更新的实时帧落地；草稿/未读徽章变化不应让一次基线刷新无故作废。
  let revision = 0;
  const listeners = new Set();
  // 挂起请求与草稿按会话单独记,而不是塞进 summary:
  // 这两样的权威来源是实时帧和输入框,不是 session.list 的基线快照 ——
  // 一次 replaceAll 不该把它们冲掉(对齐 macOS 的 listStore)。
  //
  // 集合负责「有没有卡住」,kind 表负责「叫什么名字」:早于 kind 表写入的
  // 标记(或丢了细节的重放帧)仍按 approval 上报 —— 那是阻塞最硬的一种。
  const awaitingKinds = new Map();
  const draftSessionIds = new Set();
  // 行首状态点的三份权威状态,理由与上面两样相同:权威来源是实时帧,
  // 不是 session.list 的基线快照,一次 replaceAll 不该把它们冲掉。
  //
  // completedSessionIds:「跑完了但你还没看」的绿点。只由 running true→false 的
  // 边沿产生,所以必须记住上一次观察到的 running 位 —— 见 previousRunning。
  const completedSessionIds = new Set();
  // erroredSessionIds:「上一轮失败了但你还没看」的红点。
  const erroredSessionIds = new Set();
  // previousRunning:上次观察到的 running 位。首次观察只记录、不产生未读 ——
  // 否则启动时拉到的一批本来就 idle 的会话会集体亮绿点(对齐 macOS 的
  // reconcileCompletedNotification:没有 previous 就只记 running 位然后返回)。
  const previousRunning = new Map();
  // ranSessionIds:本客户端**亲眼看到跑过**的会话。它是"后台任务失败"系统通知的
  // 闸门 —— 与完成通知里那个 running 集合(background-notifier)是同一条规矩:
  // 没见它跑起来过,它结束/出错就不是"用户的后台任务"出了事。
  //
  // 没有这道闸门时,宿主的 api-session/error 是**进程级全局广播**(任何客户端
  // 激活任何会话失败都会发给所有人),于是别的客户端打开一个再也起不来的旧会话
  // (典型:header 钉着一个已被删掉的 agentPreset,resume 永远失败)时,
  // 这边会凭空弹出一条"后台任务失败:resume failed for session ...",
  // 标题还是那个早就做完的任务名。
  const ranSessionIds = new Set();
  // persistedUnread:service worker 记的未读(工具栏圆点那一份,见 notifications/task-unread.js),
  // sessionId → { success, failure }。上面两个集合只活在这个侧栏实例里、只看得到侧栏开着时
  // 发生的边沿;这一份跨侧栏开关、会过期。行上的点取两者之并,所以:
  //   - 侧栏关着时跑完的会话,打开侧栏后行上同样亮着(和工具栏上的点对得上);
  //   - SW 那一份过期 / 被看过撤掉时,本地集合里的同一条也一起撤掉,行上的点不会比图标挂得久。
  let persistedUnread = new Map();
  // 哪个会话是当前打开的那个。未读提醒只发给**不在眼前**的会话:
  // 用户正看着的那个会话跑完了,他自己就看见了,再点一个绿点是噪声。
  let selectedSessionId = null;
  // sessionId → summary 索引表。侧栏行状态/标题/活跃排序是每帧事件驱动的,
  // 之前都用 summaries.find(...) 线性查找,会话一多就成了 O(n²) 热点。
  const byId = new Map();
  // projection block 的 asOfSeq 只是整块快照切点；实时 key 会乱序到达，
  // 因此必须逐 key 记版本，不能让 usage@20 挡掉 title@15。
  const projectionSeqBySession = new Map();
  // 子代理名册缓存:每次写 summaries 都换新数组引用,用引用判断失效,名册变化才重建。
  let subagentCache = null;
  let subagentCacheFor = null;
  // 「有子代理后裔正在跑」的祖先集合,同样按 summaries 引用失效。
  // 侧栏每行都要问一次这个问题,而按行去 walk 一遍后裔是 O(N) 重建 ——
  // 会话一多就成了渲染热点(macOS 上实测过这条路径吃满 CPU)。
  // 一次共享的上溯把每行的问题变成 O(1) 的 Set.has。
  let runningRootsCache = null;
  let runningRootsCacheFor = null;

  // 手动顺序账本(可选注入)。没有它时 manual 档退化为 updated ——
  // 账本是浏览器本地的、异步加载的,store 本身不该因为它没就位而失效。
  let orderStore = null;

  function notify() {
    for (const listener of listeners) listener(summaries);
  }

  /// 单行的未读完成对账:记下这一行的 running 位,并在
  /// running→idle 的边沿上给**非当前**会话点亮绿点。
  /// 照搬 macOS Stores.swift 的 reconcileCompletedNotification。
  /// @returns 是否真的改动了未读集合(调用方据此决定要不要 notify)。
  function reconcileCompleted(summary) {
    const id = summary.sessionId;
    const running = Boolean(summary.running);
    // "跑过"要记在首次观察之前:冷启动基线里本来就在跑的会话(别的客户端
    // 刚启动的任务)不产生绿点,但它确确实实在跑,之后失败了该通知。
    if (running && id) ranSessionIds.add(id);
    if (!previousRunning.has(id)) {
      // 首次观察:只登记,不产生提醒。
      previousRunning.set(id, running);
      return false;
    }
    const previous = previousRunning.get(id);
    previousRunning.set(id, running);
    if (previous && !running) {
      if (id === selectedSessionId) return false;
      if (completedSessionIds.has(id)) return false;
      completedSessionIds.add(id);
      return true;
    }
    if (running) return completedSessionIds.delete(id);
    return false;
  }

  /// 全量替换后剪掉已不在名单里的 id。对齐 macOS syncCompletedNotifications 的
  /// prune:留着已消失会话的标记会让集合随进程生命期无限增长。
  function pruneToRoster() {
    const seen = new Set(summaries.map((item) => item.sessionId));
    for (const id of [...previousRunning.keys()]) if (!seen.has(id)) previousRunning.delete(id);
    for (const id of [...completedSessionIds]) if (!seen.has(id)) completedSessionIds.delete(id);
    for (const id of [...erroredSessionIds]) if (!seen.has(id)) erroredSessionIds.delete(id);
    // 挂起请求与草稿同样要剪。它们能扛住一次普通的 replaceAll(那是刷新,会话还在),
    // 但会话真的离开名单后就该跟着走 —— remove() 清的正是这五样。留着的话集合会
    // 随进程无限增长,而且该会话一旦重新出现,行上会升起一个并不存在的徽章。
    for (const id of [...awaitingKinds.keys()]) if (!seen.has(id)) awaitingKinds.delete(id);
    for (const id of [...draftSessionIds]) if (!seen.has(id)) draftSessionIds.delete(id);
    for (const id of [...ranSessionIds]) if (!seen.has(id)) ranSessionIds.delete(id);
  }

  function upsert(summary) {
    const existing = byId.get(summary.sessionId);
    if (!existing) {
      summaries = [...summaries, summary];
      byId.set(summary.sessionId, summary);
      revision += 1;
      return;
    }
    const merged = { ...existing, ...summary };
    const index = summaries.indexOf(existing);
    const next = summaries.slice();
    next[index] = merged;
    summaries = next;
    byId.set(summary.sessionId, merged);
    revision += 1;
  }

  /// 单行的状态档位。事实全部取自本 store 已经维护着的那几个集合 ——
  /// 这正是状态排序对**从没打开过**的会话也成立的原因:它们没有 SessionStore,
  /// 但它们的运行位、挂起请求、草稿都在这里。
  function persistedOf(id) {
    return id === selectedSessionId ? null : persistedUnread.get(id) ?? null;
  }
  function isCompleted(id) {
    const persisted = persistedOf(id);
    return completedSessionIds.has(id) || Boolean(persisted?.success || persisted?.failure);
  }
  function isErrored(id) {
    return erroredSessionIds.has(id) || Boolean(persistedOf(id)?.failure);
  }

  function rankOf(summary, subagentRoots) {
    const id = summary.sessionId;
    return rankSession({
      isRunning: Boolean(summary.running) || subagentRoots.has(id),
      isUnread: isCompleted(id),
      didFail: isErrored(id),
      awaiting: awaitingKinds.get(id) ?? null,
      hasDraft: draftSessionIds.has(id)
    });
  }

  return {
    get revision() { return revision; },
    /// 注入手动顺序账本。由 app 层组合(store 不自己去碰 storage)。
    attachOrderStore(store) { orderStore = store ?? null; },

    /**
     * 按指定模式排序一个可见子集。列表视图拿到的顺序都从这里来。
     *
     * @param {Array} visible 可见行。
     * @param {string} orderBy SessionOrderBy 之一。
     * @returns {Array} 排好序的新数组。
     */
    sortBy(visible, orderBy, workspaceSessionIds = null) {
      const rows = [...(visible ?? [])];
      // 排序控制器还没就绪时(首帧)按默认档,而不是抛错或给出空列表。
      if (!orderBy) return rows.sort(byUpdatedDesc);
      if (orderBy === SessionOrderBy.status) {
        // 子代理根集合提前算一次:它要走一遍整个名册的父链,
        // 每行都问一次就退化成 O(n²)(macOS 那边记过这一笔)。
        const subagentRoots = computeRunningSubagentRoots(summaries);
        return sortByStatus(rows, (summary) => rankOf(summary, subagentRoots));
      }
      if (orderBy === SessionOrderBy.manual && Array.isArray(workspaceSessionIds)) {
        // 选中 workspace 后，手动序的权威是宿主 workspace.sessionIds；本地账本
        // 只属于「全部」/临时目录。未列入权威数组的 cwd 兜底行按最近更新追加。
        const positions = new Map(workspaceSessionIds.map((id, index) => [id, index]));
        return rows.sort((left, right) => {
          const a = positions.get(left.sessionId);
          const b = positions.get(right.sessionId);
          if (a !== undefined && b !== undefined) return a - b;
          if (a !== undefined) return -1;
          if (b !== undefined) return 1;
          return byUpdatedDesc(left, right);
        });
      }
      if (orderBy === SessionOrderBy.manual && orderStore) return orderStore.sort(rows);
      return rows.sort(byUpdatedDesc);
    },

    replaceAll(items) {
      summaries = [...(items ?? [])].sort(byUpdatedDesc);
      revision += 1;
      byId.clear();
      projectionSeqBySession.clear();
      for (const item of summaries) {
        byId.set(item.sessionId, item);
        const block = item.projections;
        if (block?.values && Number.isInteger(block.asOfSeq)) {
          projectionSeqBySession.set(item.sessionId,
            new Map(Object.keys(block.values).map((key) => [key, block.asOfSeq])));
        }
      }
      // 基线快照也要过一遍边沿判定:另一个客户端在我们离线时跑完的会话,
      // 只有靠这里的 true→false 才会被发现。首次观察不产生提醒的规则
      // 保证冷启动不会把一屏 idle 会话全点亮。
      //
      // 读 item.running 本身而不是 byId:全量替换时基线就是权威。
      for (const item of summaries) reconcileCompleted(item);
      pruneToRoster();
      notify();
    },
    upsertAndNotify(summary) {
      // 对账要用**合并后**的 running 位,而不是传入的那份:局部更新
      // (host/session-added 只带 cwd/parentSessionId,或标题投影)不带 running,
      // 直接拿 summary 去对账会把它读成 false,于是一个仍在跑的会话被误判成
      // "刚刚跑完",凭空亮起未读绿点。这里显式沿用已有行的 running。
      //
      // 仍在 upsert **之前**对账:reconcileCompleted 要的是 previousRunning 里
      // 那个旧值,先落盘会抹平 true→false 的边沿。
      const existingRow = byId.get(summary.sessionId);
      const running = summary.running ?? existingRow?.running ?? false;
      reconcileCompleted({ sessionId: summary.sessionId, running });
      upsert(summary);
      notify();
    },
    setStatus(sessionId, running) {
      // 先记"跑过"再看行在不在:host/session-status 可能早于 host/session-added
      // (别的客户端刚建的会话),名单还没收到这一行,但运行这件事已经发生了。
      if (running && sessionId) ranSessionIds.add(sessionId);
      const target = byId.get(sessionId);
      if (target && target.running !== running) {
        // 对账必须在写入**之前**:reconcileCompleted 靠 previousRunning 里那个
        // 旧的 running 位去认 true→false 的边沿。先 upsert 会把 previousRunning
        // 更新成新值,边沿就被抹平了,绿点永远不亮。
        reconcileCompleted({ sessionId, running });
        upsert({ ...target, running });
        notify();
      }
    },
    /// 记录上一轮是否以错误收尾。重跑(turn/start)时传 false 消错,
    /// 对齐 macOS SessionStore.lastTurnErrored 的重置点。
    /// 当前打开的会话不记:错误就摆在他眼前的对话里,行上再点一个红点是重复。
    setErrored(sessionId, errored) {
      if (!sessionId) return;
      if (errored && sessionId === selectedSessionId) return;
      const changed = errored
        ? !erroredSessionIds.has(sessionId) && Boolean(erroredSessionIds.add(sessionId))
        : erroredSessionIds.delete(sessionId);
      if (changed) notify();
    },
    /// 切换当前会话:新的当前会话就地清掉自己的未读提醒(用户已经在看了),
    /// 对齐 macOS select 里的 selection-clear + clearCompleted。
    setSelected(sessionId) {
      selectedSessionId = sessionId ?? null;
      if (!sessionId) return;
      // 两个 delete 都必须执行:用 || 会短路,第一个删成功时第二个就不跑了,
      // 于是"打开会话"只清掉未读绿点、把失败红点留在了行上。
      const clearedCompleted = completedSessionIds.delete(sessionId);
      const clearedErrored = erroredSessionIds.delete(sessionId);
      // SW 那一份由侧栏的在场上报去清(看着这条会话即已读);本地先摘掉,行上不用等一个来回。
      const clearedPersisted = persistedUnread.delete(sessionId);
      if (clearedCompleted || clearedErrored || clearedPersisted) notify();
    },
    /// 用 SW 的未读(unread-policy.unreadBySession 的形状)整体替换本地镜像。
    /// 镜像里消失的(过期 / 在别处看过 / 点了通知)同时从本地集合里摘掉。
    setPersistedUnread(bySession) {
      const next = new Map();
      for (const [id, entry] of Object.entries(bySession ?? {})) {
        if (!id || !entry) continue;
        next.set(id, { success: Boolean(entry.success), failure: Boolean(entry.failure) });
      }
      let changed = next.size !== persistedUnread.size;
      for (const [id, previous] of persistedUnread) {
        const current = next.get(id);
        if (current?.success !== previous.success || current?.failure !== previous.failure) changed = true;
        if (previous.success && !current?.success && !current?.failure) completedSessionIds.delete(id);
        if (previous.failure && !current?.failure) {
          erroredSessionIds.delete(id);
          completedSessionIds.delete(id);
        }
      }
      persistedUnread = next;
      if (changed) notify();
    },
    isCompleted,
    isErrored,
    /// 该会话是否有子代理后裔正在跑(自身可能是 idle 的)。
    isRunningSubagentRoot(sessionId) {
      if (runningRootsCacheFor !== summaries) {
        runningRootsCache = computeRunningSubagentRoots(summaries);
        runningRootsCacheFor = summaries;
      }
      return runningRootsCache.has(sessionId);
    },
    /// 后台会话来了新的用户消息:更新活跃时间并重排,让列表顺序与
    /// 「谁最近在动」一致(对齐 macOS 丢帧修复保留的 recordActivity 偷看)。
    /// 不在列表里的会话忽略 —— host/session-added 或下次 refreshList 会补上。
    recordActivity(sessionId, updatedAt = Date.now()) {
      const target = byId.get(sessionId);
      if (!target) return;
      if ((target.updatedAt ?? 0) >= updatedAt) return;
      upsert({ ...target, updatedAt });
      summaries = [...summaries].sort(byUpdatedDesc);
      notify();
    },
    /// 后台会话的标题投影:写进 summary 的 projections.values.title ——
    /// 与 session.list 基线同形状,列表行读的就是这个位置。
    setTitle(sessionId, title) {
      const target = byId.get(sessionId);
      if (!target) return;
      if (target.projections?.values?.title === title) return;
      upsert({
        ...target,
        projections: {
          ...target.projections,
          values: { ...target.projections?.values, title }
        }
      });
      notify();
    },
    setProjection(sessionId, key, value, seq) {
      const target = byId.get(sessionId);
      if (!target || !key) return;
      const versions = projectionSeqBySession.get(sessionId) ?? new Map();
      const nextSeq = Number.isInteger(seq) ? seq : (target.projections?.asOfSeq ?? 0);
      if (nextSeq <= (versions.get(key) ?? -1)) return;
      versions.set(key, nextSeq);
      projectionSeqBySession.set(sessionId, versions);
      upsert({
        ...target,
        projections: {
          ...target.projections,
          asOfSeq: Math.max(target.projections?.asOfSeq ?? 0, nextSeq),
          values: { ...target.projections?.values, [key]: value }
        }
      });
      notify();
    },
    remove(sessionId) {
      const existed = byId.has(sessionId);
      summaries = summaries.filter((item) => item.sessionId !== sessionId);
      byId.delete(sessionId);
      projectionSeqBySession.delete(sessionId);
      awaitingKinds.delete(sessionId);
      draftSessionIds.delete(sessionId);
      completedSessionIds.delete(sessionId);
      erroredSessionIds.delete(sessionId);
      persistedUnread.delete(sessionId);
      previousRunning.delete(sessionId);
      ranSessionIds.delete(sessionId);
      if (existed) revision += 1;
      notify();
    },
    /// 记录/清除某个会话的挂起请求。kind 传 null 表示已解决。
    setAwaitingUser(sessionId, kind) {
      if (!sessionId) return;
      const previous = awaitingKinds.get(sessionId) ?? null;
      if (previous === (kind ?? null)) return;
      if (kind) awaitingKinds.set(sessionId, kind);
      else awaitingKinds.delete(sessionId);
      notify();
    },
    awaitingUser: (sessionId) => awaitingKinds.get(sessionId) ?? null,
    /// 记录某个会话的输入框是否有未发送文字。
    setDraft(sessionId, hasDraft) {
      if (!sessionId) return;
      const had = draftSessionIds.has(sessionId);
      if (had === Boolean(hasDraft)) return;
      if (hasDraft) draftSessionIds.add(sessionId);
      else draftSessionIds.delete(sessionId);
      notify();
    },
    hasDraft: (sessionId) => draftSessionIds.has(sessionId),
    get: () => summaries,
    /// origin == "subagent" 的边,按 parentSessionId 分组(对齐 Mac subagentChildren)。
    subagentChildren() {
      if (subagentCacheFor !== summaries) {
        subagentCache = indexSubagentChildren(summaries);
        subagentCacheFor = summaries;
      }
      return subagentCache;
    },
    /// rootId 的整条子代理后裔统计(count + runningCount),visited 防环、普通 fork 停下。
    subagentDescendants(rootId) {
      if (subagentCacheFor !== summaries) {
        subagentCache = indexSubagentChildren(summaries);
        subagentCacheFor = summaries;
      }
      return walkSubagentChildren(subagentCache, rootId);
    },
    /// 会话标题(具体任务内容)。宿主标题投影的落点与列表行一致;还没有标题
    /// 时返回 null,调用方据此回退通用文案。
    titleOf: (sessionId) => (sessionId ? byId.get(sessionId)?.projections?.values?.title || null : null),
    /// 这个 id 是不是子代理会话。origin == "subagent" 是名单里的权威判定
    /// (与会话头部的 origin 同源,见 host 的 listFields)。通知这条路上要用它
    /// 挡掉子代理:子代理跑完只是父轮里的一个步骤,不是用户的task结束。
    isSubagent: (sessionId) => Boolean(sessionId) && byId.get(sessionId)?.origin === "subagent",
    /// 本客户端有没有见过这个会话真的在跑(session.list 基线的 running 位,
    /// 或 host/session-status、turn/start 的实时帧)。失败通知的闸门用它:
    /// 从没跑起来过的会话,它的 agent-error 是"打不开",不是"任务失败"。
    hasRunHere: (sessionId) => Boolean(sessionId) && ranSessionIds.has(sessionId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function byUpdatedDesc(a, b) {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

// ---------- 子代理名册派生 ----------

/// 仅保留 origin == "subagent" 的边(对齐 Mac SubagentChildren 的 stop-at-fork 规则)。
/// @returns Map<parentSessionId, SessionSummary[]>
export function indexSubagentChildren(summaries) {
  const byParent = new Map();
  for (const s of summaries ?? []) {
    if (s.origin !== "subagent") continue;
    const parent = s.parentSessionId;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(s);
  }
  return byParent;
}

/// 从已分组的父映射 walk 出 count/runningCount。visited 防环、子代理在普通 fork 边处停下。
/// @param byParent Map<parentSessionId, SessionSummary[]>
export function walkSubagentChildren(byParent, rootId) {
  const result = { count: 0, runningCount: 0 };
  if (!rootId || !byParent) return result;
  const visited = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.pop();
    for (const child of byParent.get(parent) ?? []) {
      if (visited.has(child.sessionId)) continue;
      visited.add(child.sessionId);
      result.count += 1;
      if (child.running) result.runningCount += 1;
      queue.push(child.sessionId);
    }
  }
  return result;
}

/// 一次性索引 + walk 的组合入口(单测/无缓存的调用方直接从这里拿)。
export function indexSubagentDescendants(summaries, rootId) {
  return walkSubagentChildren(indexSubagentChildren(summaries), rootId);
}

/// 每个「有子代理后裔正在跑」的祖先会话 id。
///
/// 方向与 walkSubagentChildren 相反:从每个正在跑的子代理往上溯到根,而不是
/// 从每个根往下 walk 一遍后裔 —— 前者的总代价是"正在跑的子代理数",
/// 后者是"行数 × 后裔数"。侧栏每行都要问这个问题,所以走上溯。
///
/// 与 indexSubagentChildren 同样只认 origin == "subagent" 的边:普通 fork
/// 不是子代理关系,链条在那里断开。visited 防环,与 walkSubagentChildren 一致。
export function computeRunningSubagentRoots(summaries) {
  const parentOf = new Map();
  for (const s of summaries ?? []) {
    if (s.origin !== "subagent") continue;
    if (s.parentSessionId) parentOf.set(s.sessionId, s.parentSessionId);
  }
  const roots = new Set();
  for (const s of summaries ?? []) {
    if (!s.running || s.origin !== "subagent") continue;
    let current = s.sessionId;
    const seen = new Set([current]);
    while (parentOf.has(current)) {
      const parent = parentOf.get(current);
      if (seen.has(parent)) break;
      seen.add(parent);
      roots.add(parent);
      current = parent;
    }
  }
  return roots;
}
