// 工作区:workspace.list / host.pickDirectory(原生目录选择)/ workspace.create。
import { RPC } from "../../platform/dsh/rpc-methods.js";

export function createWorkspaceService(connection) {
  let workspaces = [];
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(workspaces);
  }

  return {
    get workspaces() { return workspaces; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async refresh() {
      const value = await connection.call("workspace.list", {});
      workspaces = value.items ?? [];
      notify();
      return workspaces;
    },
    // 打开系统目录选择器;取消返回 null。
    async pickDirectory() {
      const value = await connection.call("host.pickDirectory", {}, 120000);
      return value.path ?? null;
    },
    async createForPath(path) {
      const value = await connection.call("workspace.create", { path });
      await this.refresh();
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
      await connection.call(RPC.hostOpenPath, { path });
    },

    /// 工作区排序。beforeWorkspaceId 省略 = 移到末尾。
    ///
    /// 顺序必须记在宿主上,不能只在本地重排:refresh() 每次都用 workspace.list
    /// 的结果整个替换 workspaces,纯本地的移动会在下一次刷新时被打回原形。
    ///
    /// 失败不抛给调用方,只回 false:位置没记上是件小事,不该让用户看见报错 ——
    /// 调用方据此把乐观更新回滚即可(对齐 macOS moveWorkspace 的取舍)。
    async moveWorkspace(workspaceId, beforeWorkspaceId = null) {
      try {
        await connection.call(RPC.workspaceInsertBefore, {
          workspaceId,
          ...(beforeWorkspaceId ? { beforeWorkspaceId } : {})
        });
        return true;
      } catch {
        return false;
      }
    },

    /// 工作区内的会话排序。beforeSessionId 省略 = 移到末尾。失败语义同上。
    async moveSession(workspaceId, sessionId, beforeSessionId = null) {
      try {
        await connection.call(RPC.workspaceInsertSessionBefore, {
          workspaceId,
          sessionId,
          ...(beforeSessionId ? { beforeSessionId } : {})
        });
        return true;
      } catch {
        return false;
      }
    }
  };
}
