// Agent preset 域(agentPresets/*)。
//
// alpha.2: list/select 与只读 read,不恢复旧 copy/delete 或路径操作。
// read 返回声明的子插件组合 YAML;默认预设走设置命名空间。
import { RPC } from "../../platform/dsh/rpc-methods.js";

/// @param connection dsh-connection 实例,提供 call(method, args)。
export function createPresetService(connection) {
  return {
    async presetList() {
      return connection.call(RPC.agentPresetList, {});
    },
    async presetRead(agentPreset) {
      return connection.call(RPC.agentPresetRead, { agentPreset });
    }
  };
}
