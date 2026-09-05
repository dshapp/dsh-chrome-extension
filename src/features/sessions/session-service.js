// 会话数据源:封装 session.* RPC,并把 mux/host 帧分发给 store。
// 断线重连后由 onGenerationReady 触发收敛重拉。
import { createSessionStore } from "./session-store.js";
import { createSessionListStore } from "./session-list-store.js";
import { createSessionOrderStore } from "./session-order-store.js";
import { SessionAwaitingKind } from "./session-row-trailing.js";
import { RPC, STREAM, HOST } from "../../platform/dsh/rpc-methods.js";

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

  function applyHistoryValue(sessionId, value, buffered = []) {
    store.reset(sessionId);
    for (const entry of value?.records ?? value?.events ?? []) {
      store.applyEvent(entry.event, entry.view);
    }
    for (const [key, projectionValue] of Object.entries(value?.projections?.values ?? {})) {
      store.applyProjection(key, projectionValue,
        value?.projections?.seqs?.[key] ?? value?.projections?.asOfSeq);
    }
    for (const entry of buffered) store.applyEvent(entry.event, entry.view);
    applyCachedControl(sessionId);
    applyCachedInteractions(sessionId);
  }

  function beginGapRepair(entry) {
    gapRepairBuffer.push(entry);
    if (repairingGap) return;
    const sessionId = currentSessionId;
    const address = currentFollowAddress;
    const throughSeq = historyCursors.get(sessionId);
    if (!sessionId || !address || !Number.isInteger(throughSeq)) {
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
    let hasQuestion = false;
    for (const pending of pendingInteractions.values()) {
      if (pending.sessionId !== sessionId) continue;
      if (pending.kind === "approval") {
        listStore.setAwaitingUser(sessionId, SessionAwaitingKind.approval);
        return;
      }
      if (pending.kind === "question") hasQuestion = true;
    }
    listStore.setAwaitingUser(sessionId, hasQuestion ? SessionAwaitingKind.question : null);
  }

  /// 只有当前会话的帧才进 store;其他会话只更新列表里的运行状态。
  function isCurrent(sessionId) {
    return sessionId === currentSessionId;
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
      const value = await connection.call(RPC.sessionList, { _request: {} });
      // 后发 refresh 或等待期间落地的实时 roster 更新都比这份 HTTP 快照新。
      // 直接 replaceAll 会让刚创建/删除/变更状态的会话倒退，等下次刷新才恢复。
      if (token !== listRefreshToken || rosterRevision !== listStore.revision) return listStore.get();
      // 与本文件其余各处解包一致地兜底。裸取的话,一个不带 items 的回包会抛
      // TypeError,而 resync() 的第一行就是它 —— 断线重连的收敛会整个失败,
      // 当前会话的 loadHistory 也跟着不执行。
      listStore.replaceAll((value?.items ?? []).filter(
        (item) => !item.blank
          && !archivedSessionIds.has(item.sessionId)
          && !removedSessionIds.has(item.sessionId)
      ));
      return listStore.get();
    },

    async create(input = {}) {
      // 兜底:即使调用方两个都传了,这里也只发其中一个,不让整条请求被拒。
      const payload = { ...input, ...locationOf(input) };
      if (payload.workspaceId) delete payload.cwd;
      const value = await connection.call(RPC.sessionCreate, { request: payload });
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
        request: { address: currentFollowAddress, maxMessages: 50 }
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
      listStore.upsertAndNotify({
        sessionId: value.sessionId, updatedAt: Date.now(), running: false,
        blank: false, parentSessionId: sessionId
      });
      return value.sessionId;
    },

    async rename(sessionId, title) {
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
        request: { address: currentFollowAddress, maxMessages: 50 }
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

    /// 上传附件,换回宿主侧的 attachmentId(大图不走 base64 内联)。
    async uploadAttachment(sessionId, attachmentId) {
      return connection.call(RPC.sessionAttachment, { request: { sessionId, attachmentId } });
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
