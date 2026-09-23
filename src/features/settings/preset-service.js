// Agent preset 域(agentPresets/*)。
//
// 0.1.7 预设改为在配置文件里声明:宿主只剩 list 与 select,read/copy/deletePreset
// 与打开预设目录的端点全部删除,这里随之只保留列表。默认预设与模式选择开关
// 走设置命名空间(见 presets-pane 的 writeRegistry)。
import { RPC } from "../../platform/dsh/rpc-methods.js";

/// @param connection dsh-connection 实例,提供 call(method, args)。
export function createPresetService(connection) {
  return {
    async presetList() {
      return connection.call(RPC.agentPresetList, {});
    }
  };
}
