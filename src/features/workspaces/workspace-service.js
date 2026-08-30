// 工作区:workspace.list / host.pickDirectory(原生目录选择)/ workspace.create。
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
    }
  };
}
