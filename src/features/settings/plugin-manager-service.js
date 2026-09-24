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
    /// 安装前的检查:包名/地址 → 版本、来源、是不是 bundle、作答的 registry,
    /// 或被拒的原因与问过的 registries。宿主签名 inspect(spec, options?),
    /// registry 为 undefined 时整个 options 省略(问宿主配置的首选源)。
    async inspectPlugin(spec, { registry } = {}) {
      return connection.call(RPC.pluginManagerInspect, {
        spec,
        ...(registry !== undefined ? { options: { registry } } : {})
      });
    },
    /// 安装。宿主签名 installBundle(spec, options?),选项必须包在 options 里
    /// (对齐 Mac PluginInstallPayload)。requestId 由调用方生成 —— 它同时是取消的
    /// 凭据(宿主的 cancelInstall 只认这个 id),所以必须在整个弹窗生命周期里保持不变。
    /// registry:首先问的源,null = pnpm 自身配置的源,undefined = 宿主配置的首选。
    async installBundle(spec, { requestId, enabled = true, approvedBuilds, registry } = {}) {
      return connection.call(RPC.pluginManagerInstallBundle, {
        spec,
        options: {
          enabled, requestId,
          ...(approvedBuilds?.length ? { approvedBuilds } : {}),
          ...(registry !== undefined ? { registry } : {})
        }
      });
    },
    /// 宿主会问的源:{registry, fallbackRegistries, resolved}。
    async pluginRegistries() {
      return connection.call(RPC.pluginManagerRegistries, {});
    },
    /// 宿主并行 ping npmjs 与 npmmirror,返回先答的那个 URL;都不通或关闭时 null。
    async fastestRegistry() {
      return connection.call(RPC.pluginRegistryProbeFastest, {});
    },
    async cancelInstall(requestId) {
      return connection.call(RPC.pluginManagerCancelInstall, { requestId });
    }
  };
}
