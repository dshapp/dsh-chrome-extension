// 插件市场域(pluginManager/*):bundle/插件的清单、启停、卸载、检查、安装与取消。
//
// 从 settings-service.js 拆出来是因为那边已经贴着 400 行上限(仓库约定单文件
// 不超过 400 行);这些方法只是纯协议搬运,和设置域的 describe/mutate 没有交集,
// 唯一的共享依赖是同一个 connection。
//
// 参数名对齐宿主具名参数契约,不做重命名 —— 重命名会让"扩展这边少发了一个字段"
// 变成宿主的默认值,静默改变行为。
import { RPC } from "../../platform/dsh/rpc-methods.js";

/// @param connection dsh-connection 实例,提供 call(method, args)。
export function createPluginManagerService(connection) {
  return {
    /// 安装随附/已安装的 bundle 列表(BundleInfo[])。
    async pluginBundles() {
      return connection.call(RPC.pluginManagerListBundles, {});
    },
    /// 宿主的插件条目列表(与只读的 pluginInventory 投影不同)。
    async pluginEntries() {
      return connection.call(RPC.pluginManagerListPlugins, {});
    },
    async setBundleEnabled(name, enabled) {
      return connection.call(RPC.pluginManagerSetBundleEnabled, { name, enabled });
    },
    async setPluginEnabled(id, enabled) {
      return connection.call(RPC.pluginManagerSetPluginEnabled, { id, enabled });
    },
    async removeBundle(name) {
      return connection.call(RPC.pluginManagerRemoveBundle, { name });
    },
    /// 安装前的检查:包名/地址 → 版本、来源、是不是 bundle,或被拒的原因。
    async inspectPlugin(spec) {
      return connection.call(RPC.pluginManagerInspect, { spec });
    },
    /// 安装。requestId 由调用方生成 —— 它同时是取消的凭据(宿主的
    /// cancelInstall 只认这个 id),所以必须在整个弹窗生命周期里保持不变。
    async installBundle(spec, { requestId, enabled = true, approvedBuilds } = {}) {
      return connection.call(RPC.pluginManagerInstallBundle, {
        spec, enabled, requestId,
        ...(approvedBuilds?.length ? { approvedBuilds } : {})
      });
    },
    async cancelInstall(requestId) {
      return connection.call(RPC.pluginManagerCancelInstall, { requestId });
    }
  };
}
