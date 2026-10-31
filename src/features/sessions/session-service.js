// 会话数据源:封装 session.* RPC,并把 mux/host 帧分发给 store。
// 断线重连后由 onGenerationReady 触发收敛重拉。
import { createSessionStore } from "./session-store.js";
import { createSessionListStore } from "./session-list-store.js";
import { createSessionOrderStore } from "./session-order-store.js";
import { SessionAwaitingKind } from "./session-row-trailing.js";
import { RPC, STREAM, HOST } from "../../platform/dsh/rpc-methods.js";
import { t } from "../../shared/i18n.js";
import { expandHistoryEntry } from "./chunk-rows.js";
import { pendingInteractionStatus } from "../interactions/interaction-flow.js";
import { questionWait, questionWaitStreamId, eventIdOfQuestionWait, timedOutOutcome } from "../interactions/timed-questions.js";

/// 历史窗口按轮次对齐(对齐 web session-controller HISTORY_PAGE_OPTIONS):
/// 一页至少 50 条消息且含两个轮次起点,绝不从轮中间切开,上限 500 条。
/// follow 开流、session/page 首载/翻页/缺口修复都用它(web 缺口修复沿用开流时的窗口)。
export const HISTORY_PAGE_OPTIONS = Object.freeze({
  maxMessages: 500, turnWindow: Object.freeze({ minMessages: 50, minTurns: 2 })
});
/// turn rail 跳页的向前翻页窗口(对齐 web JUMP_PAGE_OPTIONS):每页至少 200 条。
export const JUMP_PAGE_OPTIONS = Object.freeze({
  ...HISTORY_PAGE_OPTIONS, turnWindow: Object.freeze({ minMessages: 200, minTurns: 2 })
});

/// session.create 的归属参数:workspaceId 与 cwd **互斥**,同时给会被宿主判
/// bad-request 整体拒绝(真实后端验证过)。workspaceId 优先——它是宿主认的归属标识,
/// cwd 只是它的显示路径。集中在这里,避免各调用点各自拼错。
export function locationOf({ workspaceId, cwd } = {}) {
  if (workspaceId) return { workspaceId };
  if (cwd) return { cwd };
  return {};
}

/// options.onBackgroundTurnFailure(sessionId, message):非当前会话的轮以错误
/// 结束时回调。丢帧策略下这是失败信息唯一的出口 —— 用户切走后最需要的提醒
/// (对齐 macOS 丢帧修复特意保留的 liveTurnFailureMessage 例外)。
/// options.onAwaitingChange(sessionId, kind, eventId):某个会话开始 / 不再卡在用户
/// (授权、提问、计划确认)上。kind 为 null 表示已结算。工具栏黄点由它喂。
export function createSessionService(connection, { onBackgroundTurnFailure, onAwaitingChange } = {}) {
  const listStore = createSessionListStore();
  // 手动顺序账本(浏览器本地)。listStore 只认得"排序结果",
  // 账本的存取由它自己负责 —— 所以在这里组合,而不是让 listStore 去碰 storage。
  const orderStore = createSessionOrderStore();
  listStore.attachOrderStore(orderStore);
  const store = createSessionStore();
  let currentSessionId = null;
  const runtimeListeners = new Set();
  // loadHistory 的竞态令牌:并发加载时只有最后一次真正落进 store。
  let loadToken = 0;
  // open 自己也会等待 session/create attach；UI 层的令牌只能阻止迟到渲染，
  // 阻止不了 service 内部把 currentSessionId/follow 抢回旧目标。
  let openToken = 0;
  let listRefreshToken = 0;
  // 在途全量拉取的 promise。启动(startConnection)、重连(onGenerationReady)
  // 与打开浮层会几乎同时各触发一次 refreshList,不去重就会叠出多个约 700KB 的
  // session/list 并互相排队(实测把单个 300ms 拖到 850ms+)。对齐 Web 端
  // SessionManager.refreshList 的 single-flight:在途调用直接复用。
  let listInflight = null;
  let remoteEventClientId = null;
  const pendingEventSessions = new Map();
  const pendingInteractions = new Map();
  // 限时提问(0.2)的认领与倒计时,按 waterfall eventId。倒计时放在 service 而不是卡片里
  // (同 Mac StreamCoordinator / web PendingQuestion):卡片不在屏幕上(切到别的会话)也必须
  // 按时超时,否则认领会把 agent 一直卡在等待里。
  const questionTimers = new Map();
  const questionWaitStreams = new Set();
  const historyCursors = new Map();
  // 每会话已加载窗口的左边界与是否还有更早历史(session/page 的 beforeSeq/hasMore)。
  const historyBounds = new Map();
  // 0.1.5 的待发队列快照(session/control 基线的 queues 块与 queue 帧)。
  // 0.1.6 删掉了这两者,队列改走 projections 里的 inbox 投影;这里保留缓存只为
  // 老宿主,0.1.6 上它永远是空的 —— 所以恢复时必须以"有没有这一项"为条件,
  // 不能用 ?? [] 把投影折出来的队列清掉。
  const controlQueues = new Map();
  const controlJobs = new Map();
  const controlProjections = new Map();
  const goalActivations = new Map();
  const goalActivationEpochs = new Map();
  let goalActivationGeneration = 0;
  let archivedSessionIds = new Set();
  /// 已归档会话的摘要。活动列表(listStore)把它们滤掉了,但会话抽屉的「筛选会话」
  /// 切到显示已归档时要把它们画回列表 —— 所以滤掉之前先存一份在这里。来源两处:
  /// session/list 的全量回包(宿主照样返回归档行),以及归档那一刻从 listStore
  /// 挪出来的行。
  const archivedSummaries = new Map();
  const archivedListeners = new Set();
  const notifyArchived = () => { for (const listener of archivedListeners) listener(); };
  // 永久删除与归档都是 tombstone：同一代队列里迟到的 added 不能把行复活。
  // 会话 id 不复用，因此删除集合可以安全地保留到 service 生命周期结束。
  const removedSessionIds = new Set();
  // 同一会话连续重命名时只允许最后一次调用的回包落地；不同会话互不影响。
  const renameGenerations = new Map();
  // agentPresets/select 会重建 agent；同一会话的快速连续选择必须按点击顺序到宿主，
  // 否则较慢的旧请求可能最后落地。Promise 链只按 session 串行，互不阻塞。
  const presetApplyTails = new Map();
  let followedStreamId = null;
  // 0.1.7 把后台任务列表从 session/control 基线里拆成了每会话一条的 job/list 流
  // (帧 {type:"rows", jobs},整组替换)。跟着当前 follow 的会话走:换会话就换流。
  let jobsStreamId = null;
  // 当前 follow 的完整 durable address。子代理分页不能退化成普通 session 地址。
  let currentFollowAddress = null;
  // live 旁路(assistant-stream)的连续性期望:正在流式的 attempt 与下一条帧必须携带的
  // 稠密位置(web ClientAssistantStream.nextIndex)。丢帧/失序时重开一次 follow,新快照的
  // baseline 用它恢复被丢掉的正文 —— 否则 start 丢失会让整段 token 静默空白到 settlement。
  let assistantExpectation = null; // null | { attemptId, nextIndex }
  /// 已采纳的 live 旁路代际(web ClientAssistantStream.revision)。帧携带 revision 时必须
  /// 严格 +1;start 的 revision===1 表示宿主重置了代际,先清空再采纳。缺字段的旧宿主
  /// 退化为只做 index 稠密校验。
  let assistantRevision = 0;
  /// reopenFollow 之后、新快照武装 baseline 之前:这段时间到达的都是旧代际的尾巴帧,
  /// 只静默丢弃,不能再触发下一次重开 —— 否则丢帧瞬间的尾巴有多长,就会
  /// unsubscribe+subscribe 多少次。快照重新武装 baseline 时清除。
  let assistantResyncing = false;
  // gap repair 等待 HTTP page 时继续缓存实时帧；切会话/新快照会使旧修复失效。
  let gapRepairGeneration = 0;
  let repairingGap = false;
  let gapRepairBuffer = [];
  function notifyRuntime() {
    const snapshot = store.getSnapshot();
    for (const listener of runtimeListeners) listener(snapshot);
  }

  // ---- 权限目录(0.1.6) ----
  //
  // 0.1.6 起 permissions 投影只带 currentValue,可选预设改由进程级
  // permissionPresets/catalog 发布,并在变化时发一条无 payload 的
  // permission-presets/catalog-changed。0.1.5 没有这个命名空间(RPC 以
  // endpoint-unknown 失败),那时保留 null,由投影自带的 options 兜底 ——
  // 所以失败必须静默,不能把权限入口整块弄没。
  let permissionCatalogGeneration = 0;

  function refreshPermissionCatalog() {
    const generation = ++permissionCatalogGeneration;
    return connection.call(RPC.permissionPresetsCatalog, {}).then((value) => {
      // 迟到的回包不能覆盖新一次读取;断线期间发出的请求尤其容易乱序。
      if (generation !== permissionCatalogGeneration) return null;
      // 目录的唯一持有者是 store:它按进程存活,不随会话 reset 清掉。
      store.setPermissionCatalog(value);
      notifyRuntime();
      return value;
    }).catch(() => null);
  }

  // 插件启停/装载变更(0.1.6 plugin-manager/changed)。设置页的插件市场与清单
  // 都是实时视图 —— 变更事件到达时必须重读,否则页面停在旧状态直到用户手动
  // 切走再回来。订阅方自行决定要不要拉。
  const pluginManagerListeners = new Set();
  // 安装进度(plugin-manager/install-state 与 install-log)。带 requestId 的流式
  // 事件:只有发起了那次安装的界面认这个 id,别的订阅者直接丢弃。
  const pluginInstallListeners = new Set();

  function isObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function notifyPluginManagerChanged() {
    for (const listener of pluginManagerListeners) {
      try { listener(); } catch { /* 订阅方自己处理失败,不拖垮帧分发 */ }
    }
  }

  function notifyPluginInstall(channel, payload) {
    for (const listener of pluginInstallListeners) {
      try { listener(channel, payload); } catch { /* 同上 */ }
    }
  }

  function ensureStore(sessionId) {
    if (currentSessionId !== sessionId) {
      invalidateGapRepair();
      currentSessionId = sessionId;
      assistantExpectation = null;
      assistantRevision = 0;
      assistantResyncing = false;
      store.reset(sessionId);
      store.setCwd(listStore.get().find((row) => row.sessionId === sessionId)?.cwd);
      applyCachedControl(sessionId);
      applyCachedInteractions(sessionId);
    }
  }

  function invalidateGapRepair() {
    gapRepairGeneration += 1;
    repairingGap = false;
    gapRepairBuffer = [];
  }

  /// 记录窗口左边界:更早分页的游标与"是否还有更早"。
  function recordHistoryBounds(sessionId, value) {
    if (!sessionId) return;
    const entries = value?.records ?? value?.events ?? [];
    const first = entries.find((entry) => Number.isInteger(entry?.event?.seq));
    const bounds = {
      earliestSeq: first ? first.event.seq : -1,
      hasMore: value?.hasMore === true
    };
    historyBounds.set(sessionId, bounds);
    syncStoreHasMore(bounds);
  }

  /// 把"窗口之前还有更早历史"同步给 store:它决定 turn process 能否折叠(对齐 Mac hasMore)。
  /// 调用方都已确认 store 正承载该会话(applyHistoryValue 刚 reset 到它;翻页已校验 currentSessionId)。
  function syncStoreHasMore(bounds) {
    store.setHasMore(bounds?.hasMore === true && Number.isInteger(bounds.earliestSeq) && bounds.earliestSeq >= 0);
  }

  function applyHistoryValue(sessionId, value, buffered = []) {
    store.reset(sessionId);
    store.setCwd(value?.header?.cwd ?? listStore.get().find((row) => row.sessionId === sessionId)?.cwd);
    recordHistoryBounds(sessionId, value);
    // 历史(session/page 与 follow snapshot 两条路径)可能带 chunkrow 打包记录:
    // 一条记录代表连续多条 assistant/chunk,必须先展开再入 store,否则整段流式
    // 内容丢失,且 lastSeq 只到 seq0 会让后续每条实时帧都被误判成缺口。
    for (const entry of value?.records ?? value?.events ?? []) {
      for (const expanded of expandHistoryEntry(entry)) {
        store.applyEvent(expanded.event, expanded.view);
      }
    }
    for (const [key, projectionValue] of Object.entries(value?.projections?.values ?? {})) {
      store.applyProjection(key, projectionValue,
        value?.projections?.seqs?.[key] ?? value?.projections?.asOfSeq);
    }
    for (const entry of buffered) store.applyEvent(entry.event, entry.view);
    applyCachedControl(sessionId);
    applyCachedInteractions(sessionId);
    store.markHistoryLoaded();
  }

  /// 往前翻一页历史并 prepend 进窗口(follow 切点之前)。只向左扩展,绝不缩小
  /// 窗口右端 —— 右端是 follow 快照切点与随后追加的实时尾巴,代表当前阅读位置。
  /// 轨迹台账的「加载更早」与 turn rail 的跳页共用。迟到回包/边界不可用时返回 null。
  /// 返回 { prepended, earliestSeq, hasMore, value }。
  async function fetchEarlierPage(sessionId, token, pageOptions = HISTORY_PAGE_OPTIONS) {
    const bounds = historyBounds.get(sessionId);
    const cursor = historyCursors.get(sessionId);
    if (!bounds || bounds.hasMore !== true || !Number.isInteger(bounds.earliestSeq)
      || bounds.earliestSeq < 0 || !Number.isInteger(cursor)) {
      return null;
    }
    const value = await connection.call(RPC.sessionPage, {
      request: {
        address: currentFollowAddress ?? { kind: "session", sessionId },
        throughSeq: cursor,
        beforeSeq: bounds.earliestSeq,
        ...pageOptions
      }
    });
    if (token !== loadToken || sessionId !== currentSessionId) return null;
    const entries = [];
    for (const entry of value?.records ?? value?.events ?? []) {
      for (const expanded of expandHistoryEntry(entry)) entries.push(expanded);
    }
    const prepended = store.prependEntries(entries);
    const next = {
      earliestSeq: entries.length ? entries[0].event.seq : bounds.earliestSeq,
      hasMore: value?.hasMore === true
    };
    historyBounds.set(sessionId, next);
    syncStoreHasMore(next);
    return { prepended, earliestSeq: next.earliestSeq, hasMore: next.hasMore, value };
  }

  function beginGapRepair(entry) {
    gapRepairBuffer.push(entry);
    if (repairingGap) return;
    const sessionId = currentSessionId;
    const address = currentFollowAddress;
    const snapshotCursor = historyCursors.get(sessionId);
    const incomingSeq = entry?.event?.seq;
    // cursor 是 follow 打开时的固定切点。流在此后可能已连续推进很久才丢帧，
    // 此时仍用旧 cursor 分页只会重读快照，永远取不到真正缺失的事件。
    const throughSeq = Number.isInteger(snapshotCursor) && Number.isInteger(incomingSeq)
      ? Math.max(snapshotCursor ?? -1, incomingSeq - 1)
      : snapshotCursor;
    if (!sessionId || !address || !Number.isInteger(snapshotCursor) || !Number.isInteger(throughSeq)) {
      const buffered = gapRepairBuffer;
      gapRepairBuffer = [];
      for (const pending of buffered) store.applyEvent(pending.event, pending.view);
      notifyRuntime();
      return;
    }
    repairingGap = true;
    const generation = ++gapRepairGeneration;
    void connection.call(RPC.sessionPage, {
      request: { address, throughSeq, ...HISTORY_PAGE_OPTIONS }
    }).then((value) => {
      if (generation !== gapRepairGeneration || sessionId !== currentSessionId) return;
      const buffered = gapRepairBuffer;
      gapRepairBuffer = [];
      repairingGap = false;
      applyHistoryValue(sessionId, value, buffered);
      notifyRuntime();
    }).catch(() => {
      if (generation !== gapRepairGeneration || sessionId !== currentSessionId) return;
      // 保留已缓存帧；下一条实时事件会重试，不把缺口后的半截状态画到 UI。
      repairingGap = false;
    });
  }

  function applyCachedControl(sessionId) {
    if (goalActivations.has(sessionId)) store.setGoalActivation(goalActivations.get(sessionId));
    // 只在宿主真的给过队列快照(0.1.5 基线/queue 帧)时覆盖。0.1.6 上没有这一项,
    // 用 ?? [] 会把 follow 快照里 inbox 投影折出的队列又清空 —— 那正是排队面板
    // 在 0.1.6 上恒为空的根因。
    const cachedQueue = controlQueues.get(sessionId);
    if (cachedQueue !== undefined) store.setQueue(cachedQueue);
    store.setJobs(controlJobs.get(sessionId) ?? []);
    const projections = controlProjections.get(sessionId);
    for (const [key, value] of Object.entries(projections?.values ?? {})) {
      // 逐 key 的版本,和 applyHistoryValue 同一套规则:块级 asOfSeq 只是整块的快照
      // 切点。拿它给块内所有 key 盖同一个版本,会让 title@10 被同块的 usage@20 顶到
      // 20,此后真正更新的 title@15 反被判为陈旧丢弃 —— 标题永远停在旧值。
      store.applyProjection(key, value, projections?.seqs?.[key] ?? projections?.asOfSeq);
    }
  }

  function applyCachedInteractions(sessionId) {
    let approval = null;
    let question = null;
    for (const pending of pendingInteractions.values()) {
      if (pending.sessionId !== sessionId) continue;
      if (pending.kind === "approval") approval = pending.value;
      if (pending.kind === "question") question = pending.value;
    }
    store.setApproval(approval);
    store.setQuestion(question);
  }

  // ---- 限时提问(0.2 timed ask_user_question) ----

  /// 改写一条挂起提问并同步到 store(仅当前会话的问题在 store 里)。
  function patchPendingQuestion(eventId, patch) {
    const pending = pendingInteractions.get(eventId);
    if (pending?.kind !== "question") return null;
    const value = { ...pending.value, ...patch };
    pendingInteractions.set(eventId, { ...pending, value });
    if (isCurrent(pending.sessionId)) {
      store.setQuestion(value);
      notifyRuntime();
    }
    return value;
  }

  /// attachWait 的第一帧:宿主算出的剩余时长。从这一刻起由本端时钟倒数。
  function startQuestionCountdown(eventId, remainingMs) {
    const pending = pendingInteractions.get(eventId);
    if (pending?.kind !== "question" || pending.value.held) return;
    const delay = Math.max(0, remainingMs);
    clearTimeout(questionTimers.get(eventId));
    patchPendingQuestion(eventId, { deadline: Date.now() + delay });
    questionTimers.set(eventId, setTimeout(() => { void expireQuestion(eventId); }, delay));
  }

  /// 倒数到 0 且没人动过卡片:以 ASK_TIMED_OUT 结算 waterfall。宿主把它映射成 pending
  /// 结果让 agent 继续,问题随后以 continued 身份出现在 userQuestions 投影里。
  async function expireQuestion(eventId) {
    questionTimers.delete(eventId);
    const pending = pendingInteractions.get(eventId);
    if (pending?.kind !== "question" || pending.value.held || !remoteEventClientId) return;
    try {
      await connection.settleRemoteEvent(remoteEventClientId, eventId, timedOutOutcome());
    } catch (error) {
      console.warn("[dsh] timed question settle failed", error);
    }
    // 结算方自己收不到这一单的 cancel 帧:本地退场,否则卡片停在 0 秒。
    service.retireInteraction(eventId);
  }

  /// 释放一条提问的认领与倒计时。
  function endQuestionWait(eventId) {
    clearTimeout(questionTimers.get(eventId));
    questionTimers.delete(eventId);
    const streamId = questionWaitStreamId(eventId);
    if (questionWaitStreams.delete(streamId)) connection.unsubscribe?.(streamId);
  }

  function syncAwaitingUser(sessionId) {
    let approval = null;
    let question = null;
    let eventId = null;
    for (const [id, pending] of pendingInteractions) {
      if (pending.sessionId !== sessionId) continue;
      if (pending.kind === "approval") approval = pending.value;
      if (pending.kind === "question") question = pending.value;
      eventId ??= id;
    }
    // 与会话卡实际渲染同一分类器(web visiblePendingKind):plan-review 单独计徽标。
    const status = pendingInteractionStatus({ approval, question });
    const before = listStore.awaitingUser(sessionId);
    listStore.setAwaitingUser(sessionId, status ? SessionAwaitingKind[status] : null);
    const after = listStore.awaitingUser(sessionId);
    if (before !== after) {
      try {
        onAwaitingChange?.(sessionId, after, after ? eventId : null);
      } catch { /* 上报失败只是少一个黄点 */ }
    }
  }

  /// 只有当前会话的帧才进 store;其他会话只更新列表里的运行状态。
  function isCurrent(sessionId) {
    return sessionId === currentSessionId;
  }
  /// live 旁路连续性闸门(web ClientAssistantStream.acceptFrame / mac foldAssistantStreamFrame)。
  /// chunk/end 的 index 是 attempt 内的稠密位置,必须与期望的 nextIndex 连续;start 不得叠加在
  /// 未结束的 attempt 上。任一失序丢帧并重开一次 follow —— 新快照的 baseline 重新武装 attempt,
  /// 恢复被丢的正文(否则 start 丢失会让整段 token 静默空白到 settlement)。返回是否可交给 store。
  function foldAssistantStreamFrame(frame) {
    if (!frame || typeof frame.type !== "string" || typeof frame.attemptId !== "string") return false;
    // 重开之后、baseline 重新武装之前,到达的都是旧代际的尾巴帧:静默丢弃。
    // 这里必须早于 revision 校验 —— 尾巴帧的 revision 一定对不上(重置后期望 1),
    // 若让它走到 revision 分支,每个尾巴帧都会再 reopenFollow 一次,形成
    // unsubscribe/subscribe 风暴,正好和 reopenFollow 注释里"静默等 settle"的意图相反。
    if (assistantResyncing) return false;
    // revision 存在时必须与已采纳代际 +1(web transport.ts / assistant-stream.ts)。
    // 不嵌在这里对 chunk/end 各自判断:start 允许 revision===1 重置代际。
    const revision = Number.isInteger(frame.revision) ? frame.revision : null;
    if (revision != null && frame.type === "start") {
      if (revision === 1 && assistantRevision !== 0) {
        assistantRevision = 0;
        assistantExpectation = null;
      } else if (revision !== assistantRevision + 1) {
        reopenFollow(`start revision ${revision}, expected ${assistantRevision + 1}`);
        return false;
      }
      assistantRevision = revision;
    } else if (revision != null && frame.type !== "start") {
      // 每一帧(含 chunk/end)都推进一代,期望严格 +1。
      if (revision !== assistantRevision + 1) {
        reopenFollow(`${frame.type} revision ${revision}, expected ${assistantRevision + 1}`);
        return false;
      }
      assistantRevision = revision;
    }
    switch (frame.type) {
      case "start":
        if (assistantExpectation != null) {
          reopenFollow("start over an open attempt");
          return false;
        }
        assistantExpectation = { attemptId: frame.attemptId, nextIndex: 0 };
        return true;
      case "chunk":
        if (assistantExpectation == null || assistantExpectation.attemptId !== frame.attemptId) return false;
        if (!Number.isInteger(frame.index) || frame.index !== assistantExpectation.nextIndex) {
          reopenFollow(`chunk index ${frame.index}, expected ${assistantExpectation.nextIndex}`);
          return false;
        }
        assistantExpectation.nextIndex += 1;
        return true;
      case "end":
        if (assistantExpectation == null || assistantExpectation.attemptId !== frame.attemptId) return false;
        if (!Number.isInteger(frame.index) || frame.index !== assistantExpectation.nextIndex) {
          reopenFollow(`end index ${frame.index}, expected ${assistantExpectation.nextIndex}`);
          return false;
        }
        assistantExpectation = null;
        return true;
      default:
        return true;
    }
  }

  /// 订阅某会话的 job/list 流(0.1.7)。同一会话重复调用不重开:流的首帧就是全量。
  function followJobs(sessionId) {
    const next = sessionId ? `jobs:${sessionId}` : null;
    if (next === jobsStreamId) return;
    if (jobsStreamId) connection.unsubscribe?.(jobsStreamId);
    jobsStreamId = next;
    if (next) connection.subscribe?.(next, STREAM.jobs, { request: { sessionId } });
  }

  /// 重开当前 follow(同 address):新快照的 baseline 重新武装被丢的 attempt。
  function reopenFollow(reason) {
    assistantExpectation = null;
    assistantRevision = 0;
    assistantResyncing = true;
    // 丢帧后的旧代际帧(中段挂载、陈旧尾巴)在被清空的期望下不会再触发重开,静默等 settle 兜底。
    if (!followedStreamId || !currentFollowAddress) return;
    connection.unsubscribe?.(followedStreamId);
    connection.subscribe?.(followedStreamId, STREAM.follow, {
      request: { address: currentFollowAddress, ...HISTORY_PAGE_OPTIONS, assistantStream: true, activate: true }
    });
  }

  const service = {
    listStore,
    orderStore,
    store,
    getRuntimeSnapshot: () => store.getSnapshot(),
    get hostHome() { return service._hostHome ?? null; },
    onRuntimeChange(listener) {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    get currentSessionId() { return currentSessionId; },

    /// 订阅插件启停/装载变更(0.1.6 plugin-manager/changed)。返回退订函数。
    onPluginManagerChanged(listener) {
      pluginManagerListeners.add(listener);
      return () => pluginManagerListeners.delete(listener);
    },

    /// 订阅插件安装进度。listener(channel, payload):channel 为 "state" 时的
    /// payload 是 {requestId, phase},为 "log" 时是 {requestId, chunk}。
    onPluginInstallProgress(listener) {
      pluginInstallListeners.add(listener);
      return () => pluginInstallListeners.delete(listener);
    },

    setArchivedSessionIds(ids) {
      archivedSessionIds = new Set(Array.isArray(ids) ? ids : []);
      const kept = [];
      for (const item of listStore.get()) {
        if (archivedSessionIds.has(item.sessionId)) archivedSummaries.set(item.sessionId, item);
        else kept.push(item);
      }
      listStore.replaceAll(kept);
      notifyArchived();
    },

    /// 权威归档集合,按归档先后(宿主注册表的写入顺序)。
    archivedSessionIds() { return [...archivedSessionIds]; },

    /// 归档集合里仍有摘要可寻址的会话,最近归档的在前(摘要已不存在的成员直接跳过,
    /// 不留一个点不动的取消归档按钮)。
    archivedItems() {
      return [...archivedSessionIds].reverse()
        .map((id) => archivedSummaries.get(id))
        .filter(Boolean);
    },

    /// 归档集合或归档摘要变了。返回退订函数。
    onArchivedChange(listener) {
      archivedListeners.add(listener);
      return () => archivedListeners.delete(listener);
    },

    /// 取消归档(workspace/unarchiveSession,宿主 0.1.6+)。
    ///
    /// 回包就是完整的归档集合,立即应用(对齐 Mac unarchiveSession →
    /// handleSessionsArchived);随后重拉一次列表,让这一行回到活动列表 ——
    /// 它的摘要在归档时被 listStore 滤掉了,光改集合它不会自己回来。
    async unarchive(sessionId) {
      const value = await connection.call(RPC.workspaceUnarchiveSession, { request: { sessionId } });
      const ids = Array.isArray(value?.archivedSessionIds)
        ? value.archivedSessionIds
        : [...archivedSessionIds].filter((id) => id !== sessionId);
      const summary = archivedSummaries.get(sessionId);
      service.setArchivedSessionIds(ids);
      // 先把手上的摘要放回去,列表立刻有它;refreshList 再用权威数据覆盖。
      if (summary && !archivedSessionIds.has(sessionId)
        && !listStore.get().some((item) => item.sessionId === sessionId)) {
        listStore.replaceAll([...listStore.get(), { ...summary, archived: false }]);
      }
      try { await service.refreshList(); } catch { /* 列表下次刷新时再补 */ }
      return ids;
    },

    refreshList() {
      // 单飞:在途拉取直接复用。对齐 Web 端 SessionManager.refreshList 的
      // single-flight —— 启动/重连/打开浮层几乎同时触发,不去重就会叠出多个
      // 全量 session/list 并互相排队(实测单个请求从 300ms 拖到 850ms+)。
      if (listInflight) return listInflight;
      const token = ++listRefreshToken;
      listInflight = (async () => {
        try {
          const rosterRevision = listStore.revision;
          // 保留请求发出时的对象引用。listStore 的单行更新是 immutable 的，因此回包
          // 时可精确识别等待期间新增/变化/删除了哪些 id，而不必因任意一条实时帧就
          // 丢弃整份基线快照。
          const before = new Map(listStore.get().map((item) => [item.sessionId, item]));
          const value = await connection.call(RPC.sessionList, { _request: {} });
          // 后发 refresh 的结果更权威；旧请求绝不能覆盖它。
          if (token !== listRefreshToken) return listStore.get();
          // 与本文件其余各处解包一致地兜底。裸取的话,一个不带 items 的回包会抛
          // TypeError,而 resync() 的第一行就是它 —— 断线重连的收敛会整个失败,
          // 当前会话的 loadHistory 也跟着不执行。
          for (const item of value?.items ?? []) {
            if (archivedSessionIds.has(item.sessionId)) archivedSummaries.set(item.sessionId, item);
          }
          notifyArchived();
          let items = (value?.items ?? []).filter(
            (item) => !item.blank
              && !archivedSessionIds.has(item.sessionId)
              && !removedSessionIds.has(item.sessionId)
          );
          if (rosterRevision !== listStore.revision) {
            const current = listStore.get();
            const currentById = new Map(current.map((item) => [item.sessionId, item]));
            // 请求期间从本地名单消失的 id 不能被旧 HTTP 回包复活。
            const removedDuringRequest = new Set(
              [...before.keys()].filter((sessionId) => !currentById.has(sessionId))
            );
            const merged = new Map(items
              .filter((item) => !removedDuringRequest.has(item.sessionId))
              .map((item) => [item.sessionId, item]));
            // 新增或对象引用变化的行来自实时通道，比请求发出时的基线更新。
            for (const item of current) {
              if (before.get(item.sessionId) !== item) merged.set(item.sessionId, item);
            }
            items = [...merged.values()];
          }
          listStore.replaceAll(items);
          return listStore.get();
        } finally {
          // 结算后才允许下一次新拉取:在途期间所有调用者都拿到同一个 promise。
          listInflight = null;
        }
      })();
      return listInflight;
    },

    async create(input = {}) {
      // 兜底:即使调用方两个都传了,这里也只发其中一个,不让整条请求被拒。
      const payload = { ...input, ...locationOf(input) };
      if (payload.workspaceId) delete payload.cwd;
      const value = await connection.call(RPC.sessionCreate, { request: payload });
      // 在途请求无法真正取消,墓碑负责挡住它的回包:等待期间这个 id 若已被
      // host/session-removed 删除,这里再 upsert 就会复活一行幽灵会话。
      if (removedSessionIds.has(value.sessionId)) return value.sessionId;
      listStore.upsertAndNotify({
        sessionId: value.sessionId, updatedAt: Date.now(), running: false, blank: true,
        ...(input.cwd ? { cwd: input.cwd } : {})
      });
      return value.sessionId;
    },

    async open(sessionId, { workspaceId, cwd } = {}) {
      const token = ++openToken;
      // 切换目标本身就使旧分页失效；不能等新会话也调用 loadHistory 才递增。
      // 否则旧请求在 follow 切换后返回，会通过 ensureStore 把当前会话切回去。
      loadToken += 1;
      // 打开已有会话不再先 session/create 认领(attach)。宿主的 create 对具名会话走
      // claim → 同步 resume 整个 agent,实测每次 200~280ms,而且它排在 follow 前面串行
      // 等待 —— 切会话的一半时间都耗在这里。DSH Web(Session.doOpen)打开会话只开
      // session/follow{activate:true}:快照直接读 observation 返回,agent 由宿主在后台
      // promote;随后的 session/prompt 也会自己解析/恢复 agent。这里对齐 Web。
      const id = sessionId ?? await service.create(locationOf({ workspaceId, cwd }));
      // 等 attach/create 时又打开了别的会话：旧调用只把自己的 id 交还给调用方，
      // 不再触碰当前 store，也不替换较新调用刚开的 follow 流。
      if (token !== openToken) return id;
      invalidateGapRepair();
      ensureStore(id);
      currentFollowAddress = { kind: "session", sessionId: id };
      if (followedStreamId) connection.unsubscribe?.(followedStreamId);
      followedStreamId = `follow:${id}`;
      connection.subscribe?.(followedStreamId, STREAM.follow, {
        request: { address: currentFollowAddress, ...HISTORY_PAGE_OPTIONS, assistantStream: true, activate: true }
      });
      followJobs(id);
      return id;
    },

    async loadHistory(sessionId) {
      const token = ++loadToken;
      const throughSeq = historyCursors.get(sessionId);
      if (!Number.isInteger(throughSeq)) return null;
      const value = await connection.call(RPC.sessionPage, {
        request: { address: currentFollowAddress?.sessionId === sessionId || currentFollowAddress?.childSessionId === sessionId
          ? currentFollowAddress : { kind: "session", sessionId }, throughSeq, ...HISTORY_PAGE_OPTIONS }
      });
      // 等待期间用户又切换了会话:迟到的历史不得覆盖新会话的 store。
      if (token !== loadToken) return value;
      ensureStore(sessionId);
      invalidateGapRepair();
      applyHistoryValue(sessionId, value);
      notifyRuntime();
      return value;
    },

    /// 是否还有比当前窗口更早的历史(轨迹台账的「加载更早」入口据此显隐)。
    hasMoreHistory(sessionId) {
      const bounds = historyBounds.get(sessionId);
      return bounds?.hasMore === true && Number.isInteger(bounds.earliestSeq) && bounds.earliestSeq >= 0;
    },

    /// 轨迹台账往前翻页:取当前窗口左边界之前的一页,归并进 store 后只重折一次。
    /// 与 loadHistory 同一条 session/page 路,只是多带 beforeSeq;迟到回包按 loadToken 丢弃。
    async loadEarlier(sessionId) {
      const token = ++loadToken;
      const page = await fetchEarlierPage(sessionId, token);
      if (!page) return null;
      if (page.prepended) notifyRuntime();
      return page.value;
    },

    /// turn rail 的跳页:向左翻页直到窗口左边界跨过 seq,让投影命名、但尚未加载的
    /// 轮次进入窗口。绝不能走 throughSeq=seq —— 那会把窗口右端砍到该 seq,目标轮
    /// 自己的内容随之被丢出窗口,锚点行不存在,自然滚不过去。对齐 web
    /// Session.loadThrough 的 prepend 循环(每页用 JUMP_PAGE_OPTIONS 取更大窗口)。
    async loadThrough(sessionId, seq) {
      if (!Number.isInteger(seq) || seq < 0) return null;
      const token = ++loadToken;
      let changed = false;
      // guard 兜底宿主始终 hasMore=true 的情况;真正的收手条件是边界不再前移。
      for (let guard = 0; guard < 200; guard += 1) {
        const bounds = historyBounds.get(sessionId);
        if (!bounds || bounds.hasMore !== true || !Number.isInteger(bounds.earliestSeq)
          || bounds.earliestSeq < 0 || bounds.earliestSeq <= seq) {
          break;
        }
        const page = await fetchEarlierPage(sessionId, token, JUMP_PAGE_OPTIONS);
        if (!page) break;
        if (page.prepended) changed = true;
        if (page.earliestSeq >= bounds.earliestSeq) break;
      }
      if (changed) notifyRuntime();
      return true;
    },

    async prompt(sessionId, content, { mode = "queue" } = {}) {
      const requestId = crypto.randomUUID();
      // 空闲会话里的普通发送直接进本轮记录:先贴本端回显,durable user/message
      // (source.rpcId === requestId)到达时由 store 替换掉(对齐 web 的 transcript 回显)。
      // 运行中的排队/插队各有自己的投影(队列面板 / pendingSteering),不在这里回显。
      const echoed = mode === "queue" && isCurrent(sessionId) && !store.getSnapshot().running
        && store.addLocalEcho(sessionId, requestId, content);
      if (echoed) notifyRuntime();
      try {
        return await connection.call(RPC.sessionPrompt, { request: {
          requestId, sessionId, mode, content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        } });
      } catch (error) {
        if (echoed) {
          store.retireLocalEcho(sessionId, requestId);
          if (isCurrent(sessionId)) notifyRuntime();
        }
        throw error;
      }
    },

    async cancel(sessionId) {
      return connection.call(RPC.sessionCancel, { request: { sessionId } });
    },

    async fork(sessionId, atSeq) {
      const value = await connection.call(RPC.sessionFork, { request:
        atSeq === undefined ? { sessionId } : { sessionId, atSeq } });
      // 同 create:等待期间被删除的 id 不能由迟到的回包复活。
      if (removedSessionIds.has(value.sessionId)) return value.sessionId;
      listStore.upsertAndNotify({
        sessionId: value.sessionId, updatedAt: Date.now(), running: false,
        blank: false, parentSessionId: sessionId
      });
      return value.sessionId;
    },

    async rename(sessionId, title) {
      // 标题两端的空白不属于内容。归一化放在 service 入口而不是某个 UI 调用点:
      // 这里是所有重命名入口的收敛处,将来新增入口也自动受保护。
      // 裁完为空等于没给标题 —— 不向宿主发一个视觉上为空的标题(对齐 Mac
      // RenameSheet 的 trimmedTitle 门槛)。
      const trimmed = String(title ?? "").trim();
      if (!trimmed) return null;
      title = trimmed;
      const generation = (renameGenerations.get(sessionId) ?? 0) + 1;
      renameGenerations.set(sessionId, generation);
      const value = await connection.call(RPC.sessionRename, { request: { sessionId, title } });
      if (removedSessionIds.has(sessionId) || renameGenerations.get(sessionId) !== generation) {
        return value.title;
      }
      listStore.setTitle(sessionId, value.title);
      if (isCurrent(sessionId)) {
        store.setTitle(value.title);
        notifyRuntime();
      }
      await service.refreshList();
      return value.title;
    },

    async updateQueue(sessionId, itemId, action) {
      return connection.call(RPC.sessionUpdateQueue, { request: { sessionId, itemId, action } });
    },

    /// 宿主内容搜索(session/search):{ items: [{sessionId, snippet}], hasMore }。
    /// 部署可能关闭它(openAt: never);失败由调用方当作没有内容命中处理。
    async search(query) {
      return connection.call(RPC.sessionSearch, { request: { query } });
    },

    /// 归档会话:从活动列表移出(非删除,宿主保留日志)。
    ///
    /// 0.1.7:会话还有活在跑(本轮、子代理、后台任务、定时)时宿主拒成
    /// workspace/session-active。传了 confirmStop 就问一次,同意后带
    /// stopActivity:true 重试(宿主先停再归档);不同意返回 null,调用方据此当作取消。
    async archive(sessionId, { confirmStop } = {}) {
      let value;
      try {
        value = await connection.call(RPC.workspaceArchiveSession, { request: { sessionId } });
      } catch (error) {
        if (error?.code !== "workspace/session-active" || typeof confirmStop !== "function") throw error;
        if (!await confirmStop(error.details?.activity ?? [])) return null;
        value = await connection.call(RPC.workspaceArchiveSession, { request: { sessionId, stopActivity: true } });
      }
      const archived = value?.archivedSessionIds ?? [];
      // archive 是只增操作；并发请求的回包可能各自只含自己观察到的快照。
      // 用并集结算，避免迟到的旧回包抹掉另一条已完成的归档。真正的取消归档
      // 由 workspace/follow 的 archived 全量事件走 setArchivedSessionIds 覆盖。
      //
      // 并集必须以**回包时**的 archivedSessionIds 为基准。等待期间那个全量事件
      // 可能刚把某个 id 取消归档;若沿用请求发出前读到的旧集合,这里会把它
      // 原样并回去,等于用陈旧快照覆盖更新的权威状态。读取延后到此处即可。
      service.setArchivedSessionIds([...new Set([
        ...archivedSessionIds, ...archived, sessionId
      ])]);
      return archived;
    },

    /// 子代理目录:parentSessionId 的直属子代理。
    ///
    /// 0.1.7 删掉了 subagents/list,目录改由父会话的 subagentCatalog 投影发布
    /// ([{id, mode, label?, createdAt}]),经 session/projections 读 —— 不激活父
    /// agent。投影里没有运行态与"有没有孙代",这两样从名册(session/list 行的
    /// running / parentSessionId)补。返回形状保持旧 SubagentListValue
    /// ({entries:[{kind:"child", id, mode, activity, label, hasChildren}]}),
    /// 目录视图因此不用分两版。
    async listSubagents(parentSessionId) {
      const value = await connection.call(RPC.sessionProjections, { request: { sessionId: parentSessionId } });
      const catalog = Array.isArray(value?.values?.subagentCatalog) ? value.values.subagentCatalog : [];
      const rows = listStore.get();
      const byId = new Map(rows.map((row) => [row.sessionId, row]));
      const parents = new Set();
      for (const row of rows) if (row.origin === "subagent" && row.parentSessionId) parents.add(row.parentSessionId);
      const entries = catalog
        .filter((entry) => entry && typeof entry.id === "string")
        .map((entry) => {
          const summary = byId.get(entry.id);
          const nested = summary?.projections?.values?.subagentCatalog;
          return {
            kind: "child",
            id: entry.id,
            mode: ["one-shot", "continuable", "external"].includes(entry.mode) ? entry.mode : "unknown",
            label: typeof entry.label === "string" && entry.label ? entry.label : undefined,
            activity: summary?.running ? "running" : "not-running",
            hasChildren: entry.mode !== "external" && (parents.has(entry.id) || (Array.isArray(nested) && nested.length > 0))
          };
        });
      return { entries };
    },
    /// 子代理转录:按 SubagentAddress 读取并填进 store(含只读 subagent 投影)。
    /// 对齐 Mac 的 subagent.history —— continuable 子代理的 durable log 需要 parent + mode
    /// 上下文,不能走 session.history。返回值形状与 loadHistory 相同(SubagentHistoryValue
    /// 在 Mac 端就是 SessionHistoryValue 的 typealias)。
    async loadSubagentHistory(address) {
      const childId = address?.childSessionId;
      if (!childId || address?.mode === "external") return null;
      openToken += 1;
      loadToken += 1;
      invalidateGapRepair();
      ensureStore(childId);
      currentFollowAddress = { kind: "subagent", ...address };
      if (followedStreamId) connection.unsubscribe?.(followedStreamId);
      followedStreamId = `follow:${childId}`;
      connection.subscribe?.(followedStreamId, STREAM.follow, {
        request: { address: currentFollowAddress, ...HISTORY_PAGE_OPTIONS, assistantStream: true, activate: true }
      });
      followJobs(childId);
      return null;
    },
    /// 中断一个子代理。address = { parentSessionId, childSessionId, mode }。
    async interruptSubagent(address) {
      return connection.call(RPC.subagentInterrupt, address);
    },
    /// 可选的 agent 预设列表与切换。
    async listAgentPresets() {
      return connection.call(RPC.agentPresetList, {});
    },
    async selectAgentPreset(sessionId, agentPreset) {
      const previous = presetApplyTails.get(sessionId) ?? Promise.resolve();
      let apply;
      apply = previous.catch(() => {}).then(async () => {
        if (removedSessionIds.has(sessionId)) return null;
        const value = await connection.call(RPC.agentPresetSelect, { agentId: sessionId, agentPreset });
        if (removedSessionIds.has(sessionId)) return null;
        const applied = typeof value === "string" ? value : agentPreset;
        listStore.upsertAndNotify({ sessionId, agentPreset: applied });
        if (isCurrent(sessionId)) {
          store.setAgentPreset(applied);
          notifyRuntime();
        }
        return applied;
      });
      presetApplyTails.set(sessionId, apply);
      try {
        return await apply;
      } finally {
        if (presetApplyTails.get(sessionId) === apply) presetApplyTails.delete(sessionId);
      }
    },

    /// 按转录里的图片引用读回历史图片的字节(web SessionFace.readAttachment)。
    /// dsh 0.2.2 要整份 ImageAttachmentRef 且 schema 严格(多余字段、name:null 都会被拒),
    /// 所以只挑这几个字段,没有 name 就不带。
    /// 返回 { attachment, data },data 是 base64;失败返回 null 让渲染层落 failed 占位。
    async readAttachment(sessionId, attachment) {
      const id = sessionId ?? currentSessionId;
      if (!id || !attachment?.attachmentId) return null;
      const { attachmentId, mediaType, bytes, width, height, name } = attachment;
      return connection.call(RPC.sessionAttachment, { request: { sessionId: id, attachment: {
        attachmentId, mediaType, bytes, width, height, ...(typeof name === "string" ? { name } : {})
      } } });
    },

    async models(sessionId) {
      const value = await connection.call(RPC.sessionModels, {});
      const selection = store.getSnapshot().modelSelection;
      return { ...value, current: selection?.next ?? selection?.lastUsed ?? value.default ?? null };
    },

    async selectModel(sessionId, provider, model, reasoningEffort) {
      return connection.call(RPC.sessionSelectModel, { request: {
        sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {})
      } });
    },

    // ---- DSH 0.1.2 mux ----
    handleMuxFrame(frame) {
      const waitEventId = eventIdOfQuestionWait(frame.streamId);
      if (waitEventId) {
        // 认领流:只认 {remainingMs};流结束/出错说明前台等待已经结束,交给 waterfall 的
        // cancel/结算去收尾,这里不动卡片。
        const remainingMs = frame.value?.remainingMs;
        if (frame.type === "item" && typeof remainingMs === "number") startQuestionCountdown(waitEventId, remainingMs);
        return;
      }
      if (frame.type === "error") {
        console.warn("[dsh] logical stream error", frame.streamId, frame.error);
        // follow 流的错误是终态,必须落进 store。宿主 resume 失败(典型:会话记
        // 录的 agent preset 已被删除,host 严格解析该 id 且不回退默认值)只会以
        // 这一帧的形式到达 —— 仅打日志会让 UI 永远停在"正在加载对话…":无历史、
        // 无报错,若此前已有 turn/start 还会一直转圈。对齐 Mac 的 failEventStream。
        //
        // 这里不能加 historyLoaded 之类的守卫:空白会话的历史页合法返回 0 条事
        // 件,带守卫会把恰恰最需要报出来的这种错吞掉。
        if (frame.streamId?.startsWith("follow:")) {
          const sessionId = frame.streamId.slice("follow:".length);
          if (isCurrent(sessionId)) {
            store.setHistoryError(frame.error?.message || t("sessions.streamFailed"));
            notifyRuntime();
          }
          listStore.setStatus(sessionId, false);
        }
        return;
      }
      if (frame.type !== "item") return;
      const payload = frame.value ?? {};
      if (frame.streamId === "events") {
        if (payload.type === "ready") {
          const previousHome = service._hostHome;
          remoteEventClientId = payload.clientId ?? null;
          service._hostHome = payload.host?.home ?? service._hostHome ?? null;
          // 0.1.2 删除了 host.describe，home 改由 $events ready 异步带回。
          // ready 常晚于启动 UI，必须主动推一帧让路径缩写上下文更新。
          if (service._hostHome !== previousHome) notifyRuntime();
        }
        else if (payload.type === "emit") {
          const args = payload.args ?? [];
          const event = payload.event;
          if (event === "api-session/added") service.handleHostFrame({ payload: { type: "host/session-added", ...(args[0] ?? {}) } });
          else if (event === "api-session/removed") service.handleHostFrame({ payload: { type: "host/session-removed", sessionId: args[0] } });
          else if (event === "api-session/status") service.handleHostFrame({ payload: { type: "host/session-status", sessionId: args[0], running: args[1] } });
          else if (event === "api-session/activity") listStore.recordActivity(args[0], args[1]);
          else if (event === "goal/activation-changed") {
            const changed = args[0];
            if (changed?.sessionId) {
              service.applyGoalActivation(changed.sessionId, changed);
            }
          }
          else if (event === "api-session/error") service.handleHostFrame({ payload: { type: "host/agent-error", sessionId: args[0], message: args[1] } });
          // 0.1.6 新增的两条转发事件。都不带状态:一条只是让客户端重读完整
          // 快照(catalog / 插件清单),所以这里只把它折算成本地通知往下传,
          // 由持有那两处界面的模块决定拉什么。
          else if (event === "permission-presets/catalog-changed") {
            service.handleHostFrame({ payload: { type: HOST.permissionCatalogChanged } });
          } else if (event === "plugin-manager/changed") {
            service.handleHostFrame({ payload: { type: HOST.pluginManagerChanged } });
          }
          // 安装进度是流式的,但**不是**状态:它只在一次 installBundle 的往返期间
          // 有意义,所以不进 store,直接按 requestId 转给那次安装的发起方(设置页的
          // 添加插件弹窗)。落在这里而不是默认分支,是为了把"接但不过 store"记在代码里。
          else if (event === "plugin-manager/install-state") {
            notifyPluginInstall("state", args[0] ?? null);
          } else if (event === "plugin-manager/install-log") {
            notifyPluginInstall("log", args[0] ?? null);
          }
        } else if (payload.type === "waterfall") {
          const sessionId = payload.agentId;
          pendingEventSessions.set(payload.eventId, sessionId);
          if (payload.event === "approval/request") {
            const approval = { sessionId, eventId: payload.eventId, rpcId: payload.eventId,
              approvalId: payload.request?.approvalId ?? payload.eventId,
              toolName: payload.request?.toolName ?? "", callId: payload.request?.callId,
              reason: payload.request?.reason };
            pendingInteractions.set(payload.eventId, { kind: "approval", sessionId, value: approval });
            syncAwaitingUser(sessionId);
            if (isCurrent(sessionId)) {
              store.setApproval(approval);
              notifyRuntime();
            }
          } else if (payload.event === "user-questions/request") {
            // 0.2:wait.callId 是这次 ask_user_question 调用;wait.timed 表示前台等待有时限。
            const wait = questionWait(payload.request);
            const question = { sessionId, eventId: payload.eventId, rpcId: payload.eventId,
              questions: payload.request?.questions ?? [], callId: wait.callId, timed: wait.timed,
              deadline: null, held: false };
            pendingInteractions.set(payload.eventId, { kind: "question", sessionId, value: question });
            // 先认领再倒数(web answerQuestion):认领流的第一帧才是剩余时长,持有认领
            // 期间宿主不自己计时 —— 什么时候算超时由本端决定。
            if (wait.timed) {
              const streamId = questionWaitStreamId(payload.eventId);
              questionWaitStreams.add(streamId);
              connection.subscribe?.(streamId, STREAM.userQuestionsAttachWait, { agentId: sessionId, callId: wait.callId });
            }
            syncAwaitingUser(sessionId);
            if (isCurrent(sessionId)) {
              store.setQuestion(question);
              notifyRuntime();
            }
          } else pendingEventSessions.delete(payload.eventId);
        } else if (payload.type === "cancel") service.retireInteraction(payload.eventId);
        return;
      }
      if (frame.streamId === "control") {
        if (payload.type === "baseline") {
          const value = payload.value ?? {};
          controlQueues.clear();
          controlProjections.clear();
          for (const [sid, items] of Object.entries(value.queues ?? {})) controlQueues.set(sid, items);
          for (const [sid, projections] of Object.entries(value.projections ?? {})) {
            controlProjections.set(sid, projections);
            for (const [key, val] of Object.entries(projections?.values ?? {})) {
              listStore.setProjection?.(sid, key, val, projections?.seqs?.[key] ?? projections?.asOfSeq);
              if (key === "title") listStore.setTitle(sid, val);
            }
          }
          const sid = currentSessionId;
          if (sid) {
            applyCachedControl(sid);
            notifyRuntime();
          }
        } else {
          // 0.1.6 不再发布 queue 帧(队列改走 inbox 投影);0.1.5 仍以它为权威的
          // 瞬时队列,所以两条路都留着 —— 帧里的 item 形状与投影折出的一致。
          if (payload.type === "queue") controlQueues.set(payload.sessionId, payload.items ?? []);
          else if (payload.type === "projection") {
            const previous = controlProjections.get(payload.sessionId) ?? { values: {}, seqs: {}, asOfSeq: -1 };
            // 版本必须逐 key 记:一个会话的 asOfSeq 是所有 key 的最大值,只能当
            // 快照切点用,不能代表某一个 key 的版本。
            const seqs = { ...(previous.seqs ?? {}) };
            if (Number.isInteger(payload.seq)) seqs[payload.key] = Math.max(seqs[payload.key] ?? -1, payload.seq);
            controlProjections.set(payload.sessionId, {
              values: { ...previous.values, [payload.key]: payload.value },
              seqs,
              asOfSeq: Math.max(previous.asOfSeq ?? -1, payload.seq ?? -1)
            });
          }
          if (isCurrent(payload.sessionId)) {
            if (payload.type === "queue") store.setQueue(payload.items ?? []);
            else if (payload.type === "projection") store.applyProjection(payload.key, payload.value, payload.seq);
          }
          if (payload.type === "projection") {
            listStore.setProjection?.(payload.sessionId, payload.key, payload.value, payload.seq);
            if (payload.key === "title") listStore.setTitle(payload.sessionId, payload.value);
          }
          if (isCurrent(payload.sessionId)) notifyRuntime();
        }
        return;
      }
      if (frame.streamId.startsWith("jobs:")) {
        // job/list:该会话可见任务的全量替换。只认当前那条流,切走后迟到的帧丢掉。
        if (frame.streamId !== jobsStreamId || payload.type !== "rows") return;
        const sessionId = frame.streamId.slice("jobs:".length);
        const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        controlJobs.set(sessionId, jobs);
        if (isCurrent(sessionId)) {
          store.setJobs(jobs);
          notifyRuntime();
        }
        return;
      }
      if (frame.streamId.startsWith("follow:")) {
        const sessionId = frame.streamId.slice("follow:".length);
        if (payload.type === "snapshot") {
          historyCursors.set(sessionId, payload.cursor);
          if (!isCurrent(sessionId)) return;
          // follow snapshot 比任何在途 HTTP page 新，且定义了这一代的权威窗口。
          loadToken += 1;
          invalidateGapRepair();
          applyHistoryValue(sessionId, payload);
          // DSH 1.5 live 旁路:重连后从 baseline 恢复 stream 到一半的 attempt,
          // 用户看到一半的回答不至于一直空白到 settlement。
          store.applyAssistantStreamBaseline(payload.assistantStream ?? null);
          // baseline 是 live 旁路继续的权威:采纳(或清空)它携带的 attempt 期望。
          const activeAttempt = payload.assistantStream?.activeAttempt;
          assistantExpectation = activeAttempt
            ? { attemptId: activeAttempt.attemptId, nextIndex: Number.isInteger(activeAttempt.nextIndex) ? activeAttempt.nextIndex : 0 }
            : null;
          assistantRevision = Number.isInteger(payload.assistantStream?.revision)
            ? payload.assistantStream.revision
            : 0;
          // 新快照已重新武装 baseline,重开窗口结束:之后的帧照常按代际校验。
          assistantResyncing = false;
          notifyRuntime();
          return;
        }
        if (payload.type === "assistant-stream") {
          // presentation-only 帧,不推进 durable cursor;非当前会话直接丢弃。
          if (!isCurrent(sessionId)) return;
          // 连续性闸门:失序丢帧,并在需要时重开一次 follow。
          if (!foldAssistantStreamFrame(payload.frame)) return;
          store.applyAssistantStreamFrame(payload.frame);
          notifyRuntime();
          return;
        }
        const entry = payload;
        const event = entry.event;
        if (!event) return;
        if (!isCurrent(sessionId)) {
          if (event.type === "turn/start") listStore.setStatus(sessionId, true);
          if (event.type === "turn/end") {
            listStore.setStatus(sessionId, false);
            const reason = event.data?.reason;
            if (reason?.kind === "error") {
              listStore.setErrored(sessionId, true);
              // 子代理的失败是父轮里的一个步骤,不是用户的后台任务:不进系统通知。
              // 行上的红点照旧(它仍然是"你没看过的一次失败"),只是不弹卡片。
              if (!listStore.isSubagent(sessionId)) {
                // 带上具体任务标题,完成/失败通知都展示"哪个任务",而不是通用文案。
                onBackgroundTurnFailure?.(
                  sessionId, reason.error?.message ?? "", listStore.titleOf(sessionId)
                );
              }
            }
          }
          if (event.type === "user/message") listStore.recordActivity(sessionId, event.time);
          return;
        }
        if (repairingGap || (Number.isInteger(event.seq)
          && event.seq > store.getSnapshot().lastSeq + 1)) {
          beginGapRepair(entry);
        } else {
          store.applyEvent(event, entry.view);
          notifyRuntime();
        }
      }
    },

    retireInteraction(eventId) {
      endQuestionWait(eventId);
      const sessionId = pendingEventSessions.get(eventId);
      if (!sessionId) return;
      pendingEventSessions.delete(eventId);
      const pending = pendingInteractions.get(eventId);
      pendingInteractions.delete(eventId);
      syncAwaitingUser(sessionId);
      if (isCurrent(sessionId)) {
        if (pending?.kind === "approval" && store.getSnapshot().pendingApproval?.eventId === eventId) store.setApproval(null);
        if (pending?.kind === "question" && store.getSnapshot().pendingQuestion?.eventId === eventId) store.setQuestion(null);
        applyCachedInteractions(sessionId);
        notifyRuntime();
      }
    },

    /// 用户开始作答或点了「慢慢回答」:停表并一直持有认领,直到提交或取消(web engage/takeTime)。
    holdQuestion(eventId) {
      const pending = pendingInteractions.get(eventId);
      if (pending?.kind !== "question" || !pending.value.timed || pending.value.held) return;
      clearTimeout(questionTimers.get(eventId));
      questionTimers.delete(eventId);
      patchPendingQuestion(eventId, { held: true, deadline: null });
    },

    /// continued 提问的应答:没有 waterfall 了。取消 = 只收起面板(什么都不发);
    /// 提交 = userQuestions/answer,宿主把它排进 inbox 成为一条 user-question-reply 消息。
    async respondContinuedQuestion(question, result) {
      const { sessionId, callId } = question ?? {};
      if (!sessionId || !callId) return { accepted: false };
      if (result?.ok === false) {
        store.hideQuestion(sessionId, callId);
        notifyRuntime();
        return { accepted: true };
      }
      const answers = result?.value?.answer?.answers ?? [];
      try {
        const accepted = await connection.call(RPC.userQuestionsAnswer, { agentId: sessionId, callId, answer: { answers } });
        // false = 这个问题已经不是 continued(被别的客户端答掉、或已结算)。
        if (accepted !== true) return { accepted: false };
      } catch (error) {
        // REPLY_QUEUED:已有一条回复在排队(多半是另一个客户端刚答的),当作已送达。
        const code = error?.details?.code ?? error?.code;
        if (code !== "REPLY_QUEUED") throw error;
      }
      store.markQuestionReplied(sessionId, callId);
      notifyRuntime();
      return { accepted: true };
    },

    /// 重新打开被收起的 continued 提问面板。
    reopenQuestion(sessionId, callId) {
      store.reopenQuestion(sessionId, callId);
      notifyRuntime();
    },

    async respondInteraction(eventId, result) {
      if (!remoteEventClientId || !eventId) return { accepted: false };
      const value = result?.value;
      let outcome;
      if (result?.ok === false) outcome = { kind: "next" };
      else if (value && Object.hasOwn(value, "outcome")) outcome = { kind: "result", value: value.outcome };
      else if (value?.answer) outcome = { kind: "result", value: value.answer };
      else outcome = { kind: "result", ...(value === undefined ? {} : { value }) };
      const accepted = await connection.settleRemoteEvent(remoteEventClientId, eventId, outcome);
      if (accepted) service.retireInteraction(eventId);
      return { accepted };
    },

    applyGoalActivation(sessionId, value) {
      if (!sessionId) return;
      const goal = value?.goal ?? null;
      goalActivationEpochs.set(sessionId, (goalActivationEpochs.get(sessionId) ?? 0) + 1);
      goalActivations.set(sessionId, goal);
      if (isCurrent(sessionId)) { store.setGoalActivation(goal); notifyRuntime(); }
    },

    async refreshGoalActivation(sessionId = currentSessionId) {
      if (!sessionId) return null;
      const generation = goalActivationGeneration;
      const epoch = (goalActivationEpochs.get(sessionId) ?? 0) + 1;
      goalActivationEpochs.set(sessionId, epoch);
      try {
        const value = await connection.call(RPC.goalGet ?? "goals/get", { agentId: sessionId });
        if (generation !== goalActivationGeneration || goalActivationEpochs.get(sessionId) !== epoch) return null;
        service.applyGoalActivation(sessionId, value);
        return value;
      } catch { return null; } // old deployments may not have goals/get
    },

    generationOpened() {
      goalActivationGeneration += 1;
      goalActivations.clear();
      goalActivationEpochs.clear();
      store.setGoalActivation(null);
      loadToken += 1;
      invalidateGapRepair();
      remoteEventClientId = null;
      for (const eventId of pendingInteractions.keys()) endQuestionWait(eventId);
      pendingEventSessions.clear();
      pendingInteractions.clear();
      for (const item of listStore.get()) listStore.setAwaitingUser(item.sessionId, null);
      store.setApproval(null); store.setQuestion(null); notifyRuntime();
      // 进程级目录不随会话走,但可能随进程换过(重启、热装)。重连后重读一次,
      // 失败无所谓:0.1.5 没有这个命名空间,投影自带的 options 仍然可用。
      void refreshPermissionCatalog();
    },

    // ---- host 帧 ----
    handleHostFrame(frame) {
      const payload = frame.payload;
      switch (payload.type) {
        // 两条 0.1.6 转发事件的落点(见上面 $events 的 emit 分支)。
        case HOST.permissionCatalogChanged:
          void refreshPermissionCatalog();
          break;
        case HOST.pluginManagerChanged:
          notifyPluginManagerChanged();
          break;
        case HOST.sessionStatus:
          listStore.setStatus(payload.sessionId, payload.running);
          // 当前时间线的运行态只由 durable turn/start、turn/end 驱动。
          // `$events` 的 status=false 可能先于 follow 流里的末尾事件到达；若在这里
          // 提前清零，UI 会短暂解锁发送按钮，消费者也会读到尚未结算的 step/tail。
          // 列表行仍可消费这个轻量状态，后台会话无需物化完整事件流。
          break;
        case HOST.sessionAdded: {
          if (removedSessionIds.has(payload.sessionId) || archivedSessionIds.has(payload.sessionId)) break;
          // 子代理名册缓存靠 origin 区分子代理边与普通 fork,host 帧带 origin 时才写入;
          // 不带就不覆盖 session.list 已有的 origin(避免 upsert 用 undefined 抹掉它)。
          const added = {
            sessionId: payload.sessionId, updatedAt: Date.now(), running: false,
            blank: payload.blank, cwd: payload.cwd, parentSessionId: payload.parentSessionId
          };
          if (payload.origin) added.origin = payload.origin;
          listStore.upsertAndNotify(added);
          break;
        }
        case HOST.sessionRemoved:
          removedSessionIds.add(payload.sessionId);
          // 在途 fetch 不能强制取消，但 tombstone 会阻止其回包落状态；排队请求
          // 在真正发出前也会看到 tombstone 并退出。
          presetApplyTails.delete(payload.sessionId);
          renameGenerations.delete(payload.sessionId);
          listStore.remove(payload.sessionId);
          break;
        case HOST.agentError:
          if (isCurrent(payload.sessionId)) {
            // agent 级错误没有 seq,合成一个 turnError 行让它可见。
            store.applyEvent({
              type: "turn/end", seq: -1, time: Date.now(),
              data: { turn: 0, reason: { kind: "error", error: { message: payload.message } } }
            });
            notifyRuntime();
          } else {
            listStore.setErrored(payload.sessionId, true);
            // host 的 api-session/error 是全局事件:任何 agent 出错都会广播(含子
            // 代理,见 host 的 ctx.on("agent/error"))。子代理不是用户的任务,系统
            // 通知必须跳过它 —— 对齐 Mac AgentNotificationCenter 的
            // "guard !subject.isSubagent else return"(AppModel 用
            // summary.origin == "subagent" 喂那个 subject)。
            //
            // 第二道闸门:这个会话本客户端见过它在跑吗?api-session/error 还兼着
            // "激活失败"的出口 —— 宿主在任何客户端打开一个冷会话时后台 resume
            // (SessionHistoryController.promote),失败就全局广播
            // "resume failed for session ...: RemoteError: agent-presets:
            // preset \"x\" not found"。那既不是这边的任务,也根本没有任务:会话
            // 连 agent 都没起来。没有这道闸门时,别人(Mac app、另一个侧栏)每打开
            // 一次那个再也起不来的旧会话,这边就弹一条顶着旧任务标题的
            // "后台任务失败",而用户这边什么都没做。
            // 判据与完成通知同源(见 background-notifier 的 running 集合):
            // 没见它跑起来过,就不是"用户的后台任务"结束了。
            if (!listStore.isSubagent(payload.sessionId) && listStore.hasRunHere(payload.sessionId)) {
              onBackgroundTurnFailure?.(
                payload.sessionId, payload.message ?? "", listStore.titleOf(payload.sessionId)
              );
            }
          }
          break;
        default:
          break;
      }
    },

    async resync() {
      await service.refreshList();
      if (!currentSessionId || !currentFollowAddress) return;
      const token = ++loadToken;
      const sessionId = currentSessionId;
      const throughSeq = historyCursors.get(sessionId);
      if (!Number.isInteger(throughSeq)) return;
      const value = await connection.call(RPC.sessionPage, {
        request: { address: currentFollowAddress, throughSeq, ...HISTORY_PAGE_OPTIONS }
      }).catch(() => null);
      if (!value || token !== loadToken || sessionId !== currentSessionId) return;
      invalidateGapRepair();
      applyHistoryValue(sessionId, value);
      notifyRuntime();
    }
  };
  connection.subscribe?.("events", STREAM.events, {});
  connection.subscribe?.("control", STREAM.control, {});
  return service;
}
