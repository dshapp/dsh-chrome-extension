// 会话数据源:封装 session.* RPC,并把 mux/host 帧分发给 store。
// 断线重连后由 onGenerationReady 触发收敛重拉。
import { createSessionStore } from "./session-store.js";
import { createSessionListStore } from "./session-list-store.js";
import { SessionAwaitingKind } from "./session-row-trailing.js";
import { RPC, MUX, HOST } from "../../platform/dsh/rpc-methods.js";

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
  const store = createSessionStore();
  let currentSessionId = null;
  const runtimeListeners = new Set();
  // loadHistory 的竞态令牌:并发加载时只有最后一次真正落进 store。
  let loadToken = 0;
  // stream/error 帧触发的重连去重:突发错误帧合并成一次退避重连(见 handleMuxFrame)。
  let streamErrorReconnectTimer = null;
  function scheduleStreamErrorReconnect() {
    if (streamErrorReconnectTimer) return;
    streamErrorReconnectTimer = setTimeout(() => {
      streamErrorReconnectTimer = null;
      connection.forceReconnect?.();
    }, 100);
  }

  function notifyRuntime() {
    const snapshot = store.getSnapshot();
    for (const listener of runtimeListeners) listener(snapshot);
  }

  function ensureStore(sessionId) {
    if (currentSessionId !== sessionId) {
      currentSessionId = sessionId;
      store.reset(sessionId);
    }
  }

  /// 只有当前会话的帧才进 store;其他会话只更新列表里的运行状态。
  function isCurrent(sessionId) {
    return sessionId === currentSessionId;
  }

  const service = {
    listStore,
    store,
    getRuntimeSnapshot: () => store.getSnapshot(),
    onRuntimeChange(listener) {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    get currentSessionId() { return currentSessionId; },

    async refreshList() {
      const value = await connection.call(RPC.sessionList, {});
      listStore.replaceAll(value.items.filter((item) => !item.blank));
      return listStore.get();
    },

    async create(input = {}) {
      // 兜底:即使调用方两个都传了,这里也只发其中一个,不让整条请求被拒。
      const payload = { ...input, ...locationOf(input) };
      if (payload.workspaceId) delete payload.cwd;
      const value = await connection.call(RPC.sessionCreate, payload);
      listStore.upsertAndNotify({
        sessionId: value.sessionId, updatedAt: Date.now(), running: false, blank: true,
        ...(input.cwd ? { cwd: input.cwd } : {})
      });
      return value.sessionId;
    },

    async open(sessionId, { workspaceId, cwd } = {}) {
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
            await connection.call(RPC.sessionCreate, { sessionId, ...location });
          } catch (error) {
            // 归属参数与存档 cwd 不符:会话已存在,attach 不是必需的,继续读历史。
            if (error?.code !== "session-conflict") throw error;
          }
        }
      }
      const id = sessionId ?? await service.create(locationOf({ workspaceId, cwd }));
      ensureStore(id);
      await service.loadHistory(id);
      return id;
    },

    async loadHistory(sessionId) {
      const token = ++loadToken;
      const value = await connection.call(RPC.sessionHistory, { sessionId });
      // 等待期间用户又切换了会话:迟到的历史不得覆盖新会话的 store。
      if (token !== loadToken) return value;
      ensureStore(sessionId);
      store.reset(sessionId);
      for (const entry of value.events ?? []) {
        store.applyEvent(entry.event, entry.view);
      }
      for (const [key, projValue] of Object.entries(value.projections?.values ?? {})) {
        store.applyProjection(key, projValue, value.projections?.seqs?.[key]);
      }
      notifyRuntime();
      return value;
    },

    async prompt(sessionId, content, { mode = "queue" } = {}) {
      return connection.call(RPC.sessionPrompt, {
        sessionId, mode, content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
    },

    async cancel(sessionId) {
      return connection.call(RPC.sessionCancel, { sessionId });
    },

    async fork(sessionId, atSeq) {
      const value = await connection.call(RPC.sessionFork,
        atSeq === undefined ? { sessionId } : { sessionId, atSeq });
      listStore.upsertAndNotify({
        sessionId: value.sessionId, updatedAt: Date.now(), running: false,
        blank: false, parentSessionId: sessionId
      });
      return value.sessionId;
    },

    async rename(sessionId, title) {
      const value = await connection.call(RPC.sessionRename, { sessionId, title });
      store.applyProjection("title", value.title, Number.MAX_SAFE_INTEGER);
      notifyRuntime();
      await service.refreshList();
      return value.title;
    },

    async updateQueue(sessionId, itemId, action) {
      return connection.call(RPC.sessionUpdateQueue, { sessionId, itemId, action });
    },

    /// 全文搜索历史会话(标题 + 内容)。
    ///
    /// 部分部署会关闭 session-query 索引并回 internal 错误;那不是故障,
    /// 只是这台宿主没开这个能力。此时返回 null,调用方回退到本地标题过滤,
    /// 而不是把一个红色报错甩给用户。
    async search(query) {
      try {
        return await connection.call(RPC.sessionSearch, { query });
      } catch (error) {
        if (error?.code === "internal" && /search is disabled|SessionQueryError/i.test(error.message ?? "")) {
          return null;
        }
        throw error;
      }
    },

    /// 归档会话:从活动列表移出(非删除,宿主保留日志)。
    async archive(sessionId) {
      const value = await connection.call(RPC.workspaceArchiveSession, { sessionId });
      listStore.remove(sessionId);
      return value?.archivedSessionIds ?? [];
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
      const token = ++loadToken;
      const value = await connection.call(RPC.subagentHistory, address);
      if (token !== loadToken) return value;
      ensureStore(childId);
      store.reset(childId);
      for (const entry of value.events ?? []) {
        store.applyEvent(entry.event, entry.view);
      }
      for (const [key, projValue] of Object.entries(value.projections?.values ?? {})) {
        store.applyProjection(key, projValue, value.projections?.seqs?.[key]);
      }
      notifyRuntime();
      return value;
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
      const value = await connection.call(RPC.agentPresetSelect, { sessionId, agentPreset });
      store.setAgentPreset(value?.agentPreset ?? agentPreset);
      notifyRuntime();
      return value?.agentPreset ?? agentPreset;
    },

    /// 上传附件,换回宿主侧的 attachmentId(大图不走 base64 内联)。
    async uploadAttachment(sessionId, attachmentId) {
      return connection.call(RPC.sessionAttachment, { sessionId, attachmentId });
    },

    async models(sessionId) {
      return connection.call(RPC.sessionModels, { sessionId });
    },

    async selectModel(sessionId, provider, model, reasoningEffort) {
      return connection.call(RPC.sessionSelectModel, {
        sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {})
      });
    },

    // ---- mux 帧 ----
    handleMuxFrame(frame) {
      const payload = frame.payload;
      switch (payload.type) {
        case MUX.sessionEvent: {
          const event = payload.event;
          if (!isCurrent(payload.sessionId)) {
            // 别的会话:丢帧前偷看三样(帧反正已解码,偷看免费),事件本体不进 store。
            // 运行状态点亮/熄灭侧栏行;用户消息更新活跃排序;失败轮上报通知。
            if (event?.type === "turn/start") listStore.setStatus(payload.sessionId, true);
            if (event?.type === "turn/end") {
              listStore.setStatus(payload.sessionId, false);
              const reason = event?.data?.reason;
              if (reason?.kind === "error") {
                onBackgroundTurnFailure?.(payload.sessionId, reason.error?.message ?? "");
              }
            }
            if (event?.type === "user/message") listStore.recordActivity(payload.sessionId, event.time);
            return;
          }
          store.applyEvent(event, payload.view);
          if (store.windowTruncated) {
            // 窗口超限被截断:从历史重载恢复完整窗口。loadHistory 自带竞态令牌。
            store.clearWindowTruncated();
            void service.loadHistory(payload.sessionId).catch(() => {});
          }
          notifyRuntime();
          break;
        }
        case MUX.sessionQueue:
          if (isCurrent(payload.sessionId)) { store.setQueue(payload.items ?? []); notifyRuntime(); }
          break;
        case MUX.sessionJobs:
          if (isCurrent(payload.sessionId)) { store.setJobs(payload.jobs ?? []); notifyRuntime(); }
          break;
        // 挂起状态对**所有**会话都要记:侧栏徽章存在的意义就是提醒那些没打开的
        // 会话卡住了 —— 只在 isCurrent 时记录的话,后台会话永远不会亮起徽章。
        case MUX.approvalRequested:
          listStore.setAwaitingUser(payload.sessionId, SessionAwaitingKind.approval);
          if (isCurrent(payload.sessionId)) {
            store.setApproval({ ...payload, rpcId: payload.rpcId ?? frame.rpcId });
            notifyRuntime();
          }
          break;
        case MUX.approvalResolved:
          listStore.setAwaitingUser(payload.sessionId, null);
          if (isCurrent(payload.sessionId)) { store.setApproval(null); notifyRuntime(); }
          break;
        case MUX.questionRequested:
          listStore.setAwaitingUser(payload.sessionId, SessionAwaitingKind.question);
          if (isCurrent(payload.sessionId)) {
            store.setQuestion({ ...payload, rpcId: payload.rpcId ?? frame.rpcId });
            notifyRuntime();
          }
          break;
        case MUX.questionResolved:
          listStore.setAwaitingUser(payload.sessionId, null);
          if (isCurrent(payload.sessionId)) { store.setQuestion(null); notifyRuntime(); }
          break;
        case MUX.sessionProjection:
          if (isCurrent(payload.sessionId)) {
            store.applyProjection(payload.key, payload.value, payload.seq);
            notifyRuntime();
          } else if (payload.key === "title") {
            // 后台会话的标题(LLM 生成/重命名)只喂给列表行,不建 store;
            // 否则要等下次 refreshList 才能在侧栏看到新标题。
            listStore.setTitle(payload.sessionId, payload.value);
          }
          break;
        case MUX.sessionSubscribed:
          // 重连基线由 onGenerationReady 走 loadHistory 收敛,这里无需动作。
          break;
        case MUX.streamError:
          console.warn("[dsh] stream error", payload.error);
          scheduleStreamErrorReconnect();
          break;
        default:
          break;
      }
    },

    // ---- host 帧 ----
    handleHostFrame(frame) {
      const payload = frame.payload;
      switch (payload.type) {
        case HOST.sessionStatus:
          listStore.setStatus(payload.sessionId, payload.running);
          if (isCurrent(payload.sessionId)) { store.setRunning(payload.running); notifyRuntime(); }
          break;
        case HOST.sessionAdded: {
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
          }
          break;
        default:
          break;
      }
    },

    async resync() {
      await service.refreshList();
      if (currentSessionId) await service.loadHistory(currentSessionId).catch(() => {});
    }
  };
  return service;
}
