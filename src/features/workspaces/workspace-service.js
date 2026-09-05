// 工作区由 workspace/follow 的 baseline + 增量维护。
import { RPC, STREAM } from "../../platform/dsh/rpc-methods.js";

export function createWorkspaceService(connection, { onArchivedChange } = {}) {
  let workspaces = [];
  let archivedSessionIds = [];
  // workspace id 不复用。移除后保留 tombstone，防止同一 mux 队列里迟到的
  // upsert 或旧 baseline 把已经删除的目录复活（与 session tombstone 同理）。
  const removedWorkspaceIds = new Set();
  const listeners = new Set();
  let baselineResolve;
  let baselineReady = new Promise((resolve) => { baselineResolve = resolve; });

  function notify() {
    for (const listener of listeners) listener(workspaces);
  }

  function sameIds(left, right) {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  // 宿主给的是 partial order：只移动它提到的项，未提到（例如请求等待期间
  // follow 新增）的 workspace 保持当前相对顺序。
  function applyWorkspaceOrder(workspaceIds) {
    const byId = new Map(workspaces.map((row) => [row.workspaceId, row]));
    const emitted = new Set();
    workspaces = [
      ...(workspaceIds ?? []).flatMap((id) => {
        const row = byId.get(id);
        if (!row || emitted.has(id)) return [];
        emitted.add(id);
        return [row];
      }),
      ...workspaces.filter((row) => {
        if (emitted.has(row.workspaceId)) return false;
        emitted.add(row.workspaceId);
        return true;
      })
    ];
  }

  function movedIds(ids, movedId, beforeId) {
    if (movedId === beforeId || !ids.includes(movedId)) return null;
    if (beforeId != null && !ids.includes(beforeId)) return null;
    const next = ids.filter((id) => id !== movedId);
    const at = beforeId == null ? -1 : next.indexOf(beforeId);
    if (at === -1) next.push(movedId);
    else next.splice(at, 0, movedId);
    return sameIds(ids, next) ? null : next;
  }

  const service = {
    get workspaces() { return workspaces; },
    get archivedSessionIds() { return archivedSessionIds; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async refresh() {
      await Promise.race([baselineReady, new Promise((resolve) => setTimeout(resolve, 8000))]);
      return workspaces;
    },
    // 打开系统目录选择器;取消返回 null。
    async pickDirectory() {
      const value = await connection.call("directoryPicker/pick", {}, 120000);
      // DSH 0.1.2 直接返回 string | null；旧版曾返回 { path }。
      // 只按对象读取会把一次成功选择静默折算成“取消”。
      if (typeof value === "string") return value;
      return value?.path ?? null;
    },
    async createForPath(path) {
      const value = await connection.call(RPC.workspaceCreate, { request: { path } });
      return value.workspace;
    },
    // 选择目录 → 建 workspace(若已存在则幂等返回)。
    async pickAndCreate() {
      const path = await this.pickDirectory();
      if (!path) return null;
      return this.createForPath(path);
    },
    // 用宿主操作系统的默认方式打开某路径(系统文件管理器)。
    async openPath(path) {
      await connection.call(RPC.hostOpenPath, { request: { path } });
    },

    /// 工作区排序。beforeWorkspaceId 省略 = 移到末尾。
    ///
    /// 顺序必须记在宿主上,不能只在本地重排:workspace/follow 的下一份 baseline
    /// 会替换 workspaces,纯本地的移动会被打回原形。
    ///
    /// 乐观更新、权威回包与失败回滚都在这里完成。异步等待期间可能收到 follow；
    /// 因此只在原有 workspace 的当前顺序仍等于本次乐观顺序时结算，并只改顺序。
    async moveWorkspace(workspaceId, beforeWorkspaceId = null) {
      const previousOrder = workspaces.map((row) => row.workspaceId);
      const optimisticOrder = movedIds(previousOrder, workspaceId, beforeWorkspaceId);
      if (!optimisticOrder) return false;
      const previousIds = new Set(previousOrder);
      applyWorkspaceOrder(optimisticOrder);
      notify();
      try {
        const settled = await connection.call(RPC.workspaceInsertBefore, { request: {
          workspaceId, ...(beforeWorkspaceId ? { beforeWorkspaceId } : {})
        } });
        const currentOriginalOrder = workspaces.map((row) => row.workspaceId)
          .filter((id) => previousIds.has(id));
        if (sameIds(currentOriginalOrder, optimisticOrder)) {
          applyWorkspaceOrder(settled?.workspaceIds ?? optimisticOrder);
          notify();
        }
        return true;
      } catch {
        const currentOriginalOrder = workspaces.map((row) => row.workspaceId)
          .filter((id) => previousIds.has(id));
        if (sameIds(currentOriginalOrder, optimisticOrder)) {
          applyWorkspaceOrder(previousOrder);
          notify();
        }
        return false;
      }
    },

    /// 工作区内的会话排序。结算时只替换 sessionIds，保留 follow 并发更新的标题、
    /// 路径等字段；若期间已有更新改变了 sessionIds，则不再覆盖较新的顺序。
    async moveSession(workspaceId, sessionId, beforeSessionId = null) {
      const index = workspaces.findIndex((row) => row.workspaceId === workspaceId);
      if (index === -1) return false;
      const previousSessionIds = [...(workspaces[index].sessionIds ?? [])];
      const optimisticSessionIds = movedIds(previousSessionIds, sessionId, beforeSessionId);
      if (!optimisticSessionIds) return false;
      workspaces = workspaces.map((row, at) => at === index
        ? { ...row, sessionIds: optimisticSessionIds }
        : row);
      notify();
      try {
        const settled = await connection.call(RPC.workspaceInsertSessionBefore, { request: {
          workspaceId, sessionId, ...(beforeSessionId ? { beforeSessionId } : {})
        } });
        const settledWorkspace = settled?.workspace;
        const current = workspaces.find((row) => row.workspaceId === workspaceId);
        if (current && sameIds(current.sessionIds ?? [], optimisticSessionIds)
          && Array.isArray(settledWorkspace?.sessionIds)) {
          workspaces = workspaces.map((row) => row.workspaceId === workspaceId
            ? { ...row, sessionIds: settledWorkspace.sessionIds }
            : row);
          notify();
        }
        return true;
      } catch {
        const current = workspaces.find((row) => row.workspaceId === workspaceId);
        if (current && sameIds(current.sessionIds ?? [], optimisticSessionIds)) {
          workspaces = workspaces.map((row) => row.workspaceId === workspaceId
            ? { ...row, sessionIds: previousSessionIds }
            : row);
          notify();
        }
        return false;
      }
    }
  };
  connection.subscribe?.("workspaces", STREAM.workspaces, {});
  connection.onFrame?.((frame) => {
    if (frame.type !== "item" || frame.streamId !== "workspaces") return;
    const payload = frame.value ?? {};
    if (payload.type === "baseline") {
      workspaces = (payload.value?.items ?? [])
        .filter((item) => !removedWorkspaceIds.has(item.workspaceId));
      archivedSessionIds = payload.value?.archivedSessionIds ?? [];
      onArchivedChange?.(archivedSessionIds);
      baselineResolve?.(); baselineResolve = null;
    } else if (payload.type === "upsert") {
      const item = payload.workspace;
      if (!item) return;
      if (removedWorkspaceIds.has(item.workspaceId)) return;
      const index = workspaces.findIndex((row) => row.workspaceId === item.workspaceId);
      workspaces = index === -1
        ? [...workspaces, item]
        : workspaces.map((row, at) => at === index ? item : row);
    } else if (payload.type === "remove") {
      removedWorkspaceIds.add(payload.workspaceId);
      workspaces = workspaces.filter((row) => row.workspaceId !== payload.workspaceId);
    } else if (payload.type === "order") {
      applyWorkspaceOrder(payload.workspaceIds);
    } else if (payload.type === "archived") {
      archivedSessionIds = payload.archivedSessionIds ?? [];
      onArchivedChange?.(archivedSessionIds);
    } else return;
    notify();
  });
  return service;
}
