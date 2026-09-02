// 插件装 / 更 / 删。
//
// 只读清单已有权威来源(settingsService.pluginInventory(),走 dsh web 的
// pluginInventory/list),本模块只补它缺的变更能力 —— 那三个动作需要跑
// `dsh plugin`(即 pnpm),扩展自己做不到,所以绕 daemon。
//
// 成功后一律重拉清单,而不是本地推测新状态:`dsh plugin` 装完会 reconcile
// profile 的 bundles 层,一个包是否真的成为插件层由宿主说了算(装了但没有
// dsh.bundle 声明的包只是普通依赖)。本地猜会显示出一个不存在的插件。

export function createPluginActions({ client, onInventoryChanged }) {
  async function run(action, name) {
    const result = await client.plugin(action, name);
    if (result?.exitCode !== 0) {
      const stderr = String(result?.stderr ?? "").trim();
      const stdout = String(result?.stdout ?? "").trim();
      const error = new Error(stderr || stdout || `dsh plugin ${action} exited with ${result?.exitCode}`);
      error.name = "PluginActionError";
      error.exitCode = result?.exitCode ?? null;
      throw error;
    }
    // 只在成功后刷新。失败时清单没变,重拉只会掩盖刚才的报错。
    await onInventoryChanged?.();
    return result;
  }

  return {
    install(name) {
      return run("add", name);
    },
    remove(name) {
      return run("remove", name);
    },
    update(name) {
      return run("update", name);
    },
    /// 宿主视角的已装列表(pnpm ls 的原文)。与 pluginInventory 的运行时投影
    /// 不同:这个反映磁盘上装了什么,那个反映当前组装加载了什么。
    list() {
      return client.plugin("list");
    },
    outdated() {
      return client.plugin("outdated");
    }
  };
}
