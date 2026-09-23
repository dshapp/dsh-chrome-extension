// settings-service 拆出来的两个协议搬运模块:RPC 名与参数形状是宿主契约,
// 写错不会报错,只会静默变成"宿主用了默认值"。这里逐个钉住。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createPluginManagerService } from "../src/features/settings/plugin-manager-service.js";
import { createPresetService } from "../src/features/settings/preset-service.js";
import { RPC } from "../src/platform/dsh/rpc-methods.js";

/// 记录调用的假 connection。
function recorder(result = { ok: true }) {
  const calls = [];
  return {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      return result;
    }
  };
}

test("plugin-manager:每个方法打到对应 RPC,参数名与宿主一致", async () => {
  const c = recorder();
  const service = createPluginManagerService(c);

  await service.pluginBundles();
  await service.pluginEntries();
  await service.setBundleEnabled("b", true);
  await service.setPluginEnabled("p", false);
  await service.removeBundle("b");
  await service.inspectPlugin("@scope/pkg");
  await service.cancelInstall("rid-1");

  assert.deepEqual(c.calls.map((x) => x.method), [
    RPC.pluginManagerListBundles,
    RPC.pluginManagerListPlugins,
    RPC.pluginManagerSetBundleEnabled,
    RPC.pluginManagerSetPluginEnabled,
    RPC.pluginManagerRemoveBundle,
    RPC.pluginManagerInspect,
    RPC.pluginManagerCancelInstall
  ]);
  assert.deepEqual(c.calls[2].args, { name: "b", enabled: true });
  assert.deepEqual(c.calls[3].args, { id: "p", enabled: false });
  assert.deepEqual(c.calls[5].args, { spec: "@scope/pkg" });
  assert.deepEqual(c.calls[6].args, { requestId: "rid-1" });
});

test("plugin-manager:installBundle 默认 enabled,approvedBuilds 为空时不出现", async () => {
  const c = recorder();
  const service = createPluginManagerService(c);

  await service.installBundle("@scope/pkg", { requestId: "rid-2" });
  assert.deepEqual(c.calls[0].args, {
    spec: "@scope/pkg", enabled: true, requestId: "rid-2"
  });

  await service.installBundle("@scope/pkg", {
    requestId: "rid-3", enabled: false, approvedBuilds: ["@scope/pkg"]
  });
  assert.deepEqual(c.calls[1].args, {
    spec: "@scope/pkg", enabled: false, requestId: "rid-3",
    approvedBuilds: ["@scope/pkg"]
  });
});

test("preset:0.1.7 只剩列表;删掉的预设端点不再暴露", async () => {
  const c = recorder();
  const service = createPresetService(c);

  await service.presetList();
  assert.deepEqual(c.calls.map((x) => x.method), [RPC.agentPresetList]);
  for (const gone of ["presetRead", "presetCopy", "presetRemove", "presetOpenDocument", "canOpenPresetDirectory"]) {
    assert.equal(service[gone], undefined, gone);
  }
  for (const gone of ["agentPresetRead", "agentPresetCopy", "agentPresetRemove", "agentPresetOpenDocument",
    "settingsCanOpenAgentPresetDirectory", "subagentList"]) {
    assert.equal(RPC[gone], undefined, gone);
  }
});
