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
export function createSessionService(connection, { onBackgroundTurnFailure } = {}) {
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
  let remoteEventClientId = null;
  const pendingEventSessions = new Map();
  const pendingInteractions = new Map();
  const historyCursors = new Map();
  // 每会话已加载窗口的左边界与是否还有更早历史(session/page 的 beforeSeq/hasMore)。
  const historyBounds = new Map();
  const controlQueues = new Map();
  const controlJobs = new Map();
  const controlProjections = new Map();
  let archivedSessionIds = new Set();
  // 永久删除与归档都是 tombstone：同一代队列里迟到的 added 不能把行复活。
  // 会话 id 不复用，因此删除集合可以安全地保留到 service 生命周期结束。
  const removedSessionIds = new Set();
  // 同一会话连续重命名时只允许最后一次调用的回包落地；不同会话互不影响。
  const renameGenerations = new Map();
  // agentPresets/select 会重建 agent；同一会话的快速连续选择必须按点击顺序到宿主，
  // 否则较慢的旧请求可能最后落地。Promise 链只按 session 串行，互不阻塞。
  const presetApplyTails = new Map();
  let followedStreamId = null;
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
  // gap repair 等待 HTTP page 时继续缓存实时帧；切会话/新快照会使旧修复失效。
  let gapRepairGeneration = 0;
  let repairingGap = false;
  let gapRepairBuffer = [];
  function notifyRuntime() {
    const snapshot = store.getSnapshot();
    for (const listener of runtimeListeners) listener(snapshot);
  }

  function ensureStore(sessionId) {
    if (currentSessionId !== sessionId) {
      invalidateGapRepair();
      currentSessionId = sessionId;
      assistantExpectation = null;
      assistantRevision = 0;
      store.reset(sessionId);
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
    historyBounds.set(sessionId, {
      earliestSeq: first ? first.event.seq : -1,
      hasMore: value?.hasMore === true
    });
  }

  function applyHistoryValue(sessionId, value, buffered = []) {
    store.reset(sessionId);
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
  }

  /// 往前翻一页历史并 prepend 进窗口(follow 切点之前)。只向左扩展,绝不缩小
  /// 窗口右端 —— 右端是 follow 快照切点与随后追加的实时尾巴,代表当前阅读位置。
  /// 轨迹台账的「加载更早」与 turn rail 的跳页共用。迟到回包/边界不可用时返回 null。
  /// 返回 { prepended, earliestSeq, hasMore, value }。
  async function fetchEarlierPage(sessionId, token) {
    const bounds = historyBounds.get(sessionId);
    const cursor = historyCursors.get(sessionId);
    if (!bounds || bounds.hasMore !== true || !Number.isInteger(bounds.earliestSeq)
      || bounds.earliestSeq < 0 || !Number.isInteger(cursor)) {
      return null;
    }
    const value = await connection.call(RPC.sessionPage, {
      request: {
        address: { kind: "session", sessionId },
        throughSeq: cursor,
        beforeSeq: bounds.earliestSeq,
        maxMessages: 50
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
      request: { address, throughSeq, maxMessages: 50 }
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
    store.setQueue(controlQueues.get(sessionId) ?? []);
    store.setJobs(controlJobs.get(sessionId) ?? []);
    const projections = controlProjections.get(sessionId);
    for (const [key, value] of Object.entries(projections?.values ?? {})) {
      store.applyProjection(key, value, projections?.asOfSeq);
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

  function syncAwaitingUser(sessionId) {
    let approval = null;
    let question = null;
    for (const pending of pendingInteractions.values()) {
      if (pending.sessionId !== sessionId) continue;
      if (pending.kind === "approval") approval = pending.value;
      if (pending.kind === "question") question = pending.value;
    }
    // 与会话卡实际渲染同一分类器(web visiblePendingKind):plan-review 单独计徽标。
    const status = pendingInteractionStatus({ approval, question });
    listStore.setAwaitingUser(sessionId, status ? SessionAwaitingKind[status] : null);
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

  /// 重开当前 follow(同 address):新快照的 baseline 重新武装被丢的 attempt。
  function reopenFollow(reason) {
    assistantExpectation = null;
    assistantRevision = 0;
    // 丢帧后的旧代际帧(中段挂载、陈旧尾巴)在被清空的期望下不会再触发重开,静默等 settle 兜底。
    if (!followedStreamId || !currentFollowAddress) return;
    connection.unsubscribe?.(followedStreamId);
    connection.subscribe?.(followedStreamId, STREAM.follow, {
      request: { address: currentFollowAddress, maxMessages: 50, assistantStream: true }
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

    setArchivedSessionIds(ids) {
      archivedSessionIds = new Set(Array.isArray(ids) ? ids : []);
      listStore.replaceAll(listStore.get().filter((item) => !archivedSessionIds.has(item.sessionId)));
    },

    async refreshList() {
      const token = ++listRefreshToken;
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
      if (sessionId) {
        // 会话的 cwd 在创建时固定。attach 时若不带归属参数,宿主会回退到它的
        // 启动目录(dsh web 的 --cwd,常是 ~),与存档 cwd 一比即 session-conflict。
        // 所以只在**有**归属参数时才 attach;没有就直接用列表里记的 cwd 兜底,
        // 再没有就跳过 attach —— 后面的 loadHistory 本就不需要先 create。
        // (Mac 端同源策略:AppModel.createOrAdoptSession 在 cwd 可能不符时丢弃 id。)
        const known = listStore.get().find((item) => item.sessionId === sessionId);
        const location = locationOf({ workspaceId, cwd: cwd ?? known?.cwd });
        if (location.workspaceId || location.cwd) {
          try {
            await connection.call(RPC.sessionCreate, { request: { sessionId, ...location } });
          } catch (error) {
            // 归属参数与存档 cwd 不符:会话已存在,attach 不是必需的,继续读历史。
            if (error?.code !== "session-conflict") throw error;
          }
        }
      }
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
        request: { address: currentFollowAddress, maxMessages: 50, assistantStream: true }
      });
      return id;
    },

    async loadHistory(sessionId) {
      const token = ++loadToken;
      const throughSeq = historyCursors.get(sessionId);
      if (!Number.isInteger(throughSeq)) return null;
      const value = await connection.call(RPC.sessionPage, {
        request: { address: { kind: "session", sessionId }, throughSeq, maxMessages: 50 }
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
    /// Session.loadThrough 的 prepend 循环:单页只有 50 条消息时继续往前翻。
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
        const page = await fetchEarlierPage(sessionId, token);
        if (!page) break;
        if (page.prepended) changed = true;
        if (page.earliestSeq >= bounds.earliestSeq) break;
      }
      if (changed) notifyRuntime();
      return true;
    },

    async prompt(sessionId, content, { mode = "queue" } = {}) {
      return connection.call(RPC.sessionPrompt, { request: {
        requestId: crypto.randomUUID(), sessionId, mode, content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      } });
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

    /// 全文搜索历史会话(标题 + 内容)。
    ///
    /// 部分部署会关闭 session-query 索引并回 internal 错误;那不是故障,
    /// 只是这台宿主没开这个能力。此时返回 null,调用方回退到本地标题过滤,
    /// 而不是把一个红色报错甩给用户。
    async search(query) {
      try {
        return await connection.call(RPC.sessionSearch, { request: { query } });
      } catch (error) {
        // 0.1.2 网关会给领域错误码加命名空间（实机为 gateway/internal），
        // 不能只认裸 internal，否则关闭索引的标准部署会把可降级状态冒泡成红错。
        if (String(error?.code ?? "").split("/").at(-1) === "internal"
          && /search is disabled|SessionQueryError/i.test(error.message ?? "")) {
          return null;
        }
        throw error;
      }
    },

    /// 归档会话:从活动列表移出(非删除,宿主保留日志)。
    async archive(sessionId) {
      const value = await connection.call(RPC.workspaceArchiveSession, { request: { sessionId } });
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

    /// 子代理目录:parentSessionId 的直属子代理(healthy child / diagnostic)。
    async listSubagents(parentSessionId) {
      return connection.call(RPC.subagentList, { parentSessionId });
    },
    /// 子代理转录:按 SubagentAddress 读取并填进 store(含只读 subagent 投影)。
    /// 对齐 Mac 的 subagent.history —— continuable 子代理的 durable log 需要 parent + mode
    /// 上下文,不能走 session.history。返回值形状与 loadHistory 相同(SubagentHistoryValue
    /// 在 Mac 端就是 SessionHistoryValue 的 typealias)。
    async loadSubagentHistory(address) {
      const childId = address?.childSessionId;
      if (!childId) return null;
      openToken += 1;
      loadToken += 1;
      invalidateGapRepair();
      ensureStore(childId);
      currentFollowAddress = { kind: "subagent", ...address };
      if (followedStreamId) connection.unsubscribe?.(followedStreamId);
      followedStreamId = `follow:${childId}`;
      connection.subscribe?.(followedStreamId, STREAM.follow, {
        request: { address: currentFollowAddress, maxMessages: 50, assistantStream: true }
      });
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

    /// 按 attachmentId 读回历史图片的字节(web SessionFace.readAttachment)。
    /// 返回 { attachment, data },data 是 base64;失败返回 null 让渲染层落 failed 占位。
    async readAttachment(sessionId, attachmentId) {
      const id = sessionId ?? currentSessionId;
      if (!id || !attachmentId) return null;
      return connection.call(RPC.sessionAttachment, { request: { sessionId: id, attachmentId } });
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
          else if (event === "api-session/error") service.handleHostFrame({ payload: { type: "host/agent-error", sessionId: args[0], message: args[1] } });
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
            const question = { sessionId, eventId: payload.eventId, rpcId: payload.eventId,
              questions: payload.request?.questions ?? [] };
            pendingInteractions.set(payload.eventId, { kind: "question", sessionId, value: question });
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
          controlJobs.clear();
          controlProjections.clear();
          for (const [sid, items] of Object.entries(value.queues ?? {})) controlQueues.set(sid, items);
          for (const [sid, jobs] of Object.entries(value.jobs ?? {})) controlJobs.set(sid, jobs);
          for (const [sid, projections] of Object.entries(value.projections ?? {})) {
            controlProjections.set(sid, projections);
            for (const [key, val] of Object.entries(projections?.values ?? {})) {
              listStore.setProjection?.(sid, key, val, projections?.asOfSeq);
              if (key === "title") listStore.setTitle(sid, val);
            }
          }
          const sid = currentSessionId;
          if (sid) {
            applyCachedControl(sid);
            notifyRuntime();
          }
        } else {
          if (payload.type === "queue") controlQueues.set(payload.sessionId, payload.items ?? []);
          else if (payload.type === "jobs") controlJobs.set(payload.sessionId, payload.jobs ?? []);
          else if (payload.type === "projection") {
            const previous = controlProjections.get(payload.sessionId) ?? { values: {}, asOfSeq: -1 };
            controlProjections.set(payload.sessionId, {
              values: { ...previous.values, [payload.key]: payload.value },
              asOfSeq: Math.max(previous.asOfSeq ?? -1, payload.seq ?? -1)
            });
          }
          if (isCurrent(payload.sessionId)) {
            if (payload.type === "queue") store.setQueue(payload.items ?? []);
            else if (payload.type === "jobs") store.setJobs(payload.jobs ?? []);
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
              onBackgroundTurnFailure?.(sessionId, reason.error?.message ?? "");
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

    generationOpened() {
      loadToken += 1;
      invalidateGapRepair();
      remoteEventClientId = null;
      pendingEventSessions.clear();
      pendingInteractions.clear();
      for (const item of listStore.get()) listStore.setAwaitingUser(item.sessionId, null);
      store.setApproval(null); store.setQuestion(null); notifyRuntime();
    },

    // ---- host 帧 ----
    handleHostFrame(frame) {
      const payload = frame.payload;
      switch (payload.type) {
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
            onBackgroundTurnFailure?.(payload.sessionId, payload.message ?? "");
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
        request: { address: currentFollowAddress, throughSeq, maxMessages: 50 }
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
