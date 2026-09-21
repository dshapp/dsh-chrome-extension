// Agent preset 域(agentPreset/*):列出、读、复制、删除、打开文档目录。
//
// 从 settings-service.js 拆出来是因为那边贴着仓库的单文件 400 行上限。
// 与设置域的唯一耦合是 settingsCanOpenAgentPresetDirectory —— 它决定预设行
// 是否渲染"打开目录",所以和 preset 方法放在一起更连贯。
import { RPC } from "../../platform/dsh/rpc-methods.js";

/// @param connection dsh-connection 实例,提供 call(method, args)。
export function createPresetService(connection) {
  return {
    async presetList() {
      return connection.call(RPC.agentPresetList, {});
    },
    async presetRead(agentPreset) {
      return connection.call(RPC.agentPresetRead, { agentPreset });
    },
    /// 复制预设。id 是必填的目录名;name 可缺省,那时宿主用 id 当显示名 ——
    /// 所以这里必须把 name 透传下去(早先只发了 {from, id},用户填的名称被丢掉)。
    async presetCopy(from, agentPreset, name) {
      return connection.call(RPC.agentPresetCopy, {
        from, id: agentPreset, ...(name ? { name } : {})
      });
    },
    async presetRemove(agentPreset) {
      return connection.call(RPC.agentPresetRemove, { id: agentPreset });
    },
    async presetOpenDocument(agentPreset) {
      return connection.call(RPC.agentPresetOpenDocument, { agentPreset });
    },
    /// 宿主桌面上能不能打开预设目录。不能时这一行不渲染"打开目录"动作。
    async canOpenPresetDirectory() {
      return connection.call(RPC.settingsCanOpenAgentPresetDirectory, {});
    }
  };
}
