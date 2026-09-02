import { describe, it, expect, vi } from "vitest";
import { createPluginActions } from "../src/features/host-proxy/plugin-actions.js";

describe("plugin-actions", () => {
  const okClient = () => ({ plugin: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "" }) });

  it("install / remove / update 映射到对应的 pnpm 动词", async () => {
    const client = okClient();
    const actions = createPluginActions({ client });
    await actions.install("@scope/pkg");
    await actions.remove("@scope/pkg");
    await actions.update("@scope/pkg");
    expect(client.plugin.mock.calls.map((c) => c[0])).toEqual(["add", "remove", "update"]);
    expect(client.plugin.mock.calls[0][1]).toBe("@scope/pkg");
  });

  it("成功后重拉清单 —— 装了什么由宿主 reconcile 说了算", async () => {
    const onInventoryChanged = vi.fn().mockResolvedValue(undefined);
    await createPluginActions({ client: okClient(), onInventoryChanged }).install("pkg");
    expect(onInventoryChanged).toHaveBeenCalledTimes(1);
  });

  it("失败时不重拉,且原样抛出宿主的 stderr", async () => {
    // 失败后刷新会用一份没变的清单盖掉刚才的报错。
    const onInventoryChanged = vi.fn();
    const client = { plugin: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "ERR_PNPM_NO_MATCHING_VERSION" }) };
    const error = await createPluginActions({ client, onInventoryChanged }).install("nope").catch((e) => e);
    expect(error.name).toBe("PluginActionError");
    expect(error.message).toBe("ERR_PNPM_NO_MATCHING_VERSION");
    expect(onInventoryChanged).not.toHaveBeenCalled();
  });

  it("没有 onInventoryChanged 也不崩", async () => {
    await expect(createPluginActions({ client: okClient() }).install("pkg")).resolves.toBeTruthy();
  });

  it("只读动作不带包名", async () => {
    const client = okClient();
    const actions = createPluginActions({ client });
    await actions.list();
    await actions.outdated();
    expect(client.plugin.mock.calls[0]).toEqual(["list"]);
    expect(client.plugin.mock.calls[1]).toEqual(["outdated"]);
  });
});
