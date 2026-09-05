// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createModelsPane } from "../src/app/sidepanel/settings/models-pane.js";
import { createPresetsPane } from "../src/app/sidepanel/settings/presets-pane.js";
import { createGeneralPane } from "../src/app/sidepanel/settings/general-pane.js";
import { createPluginsPane } from "../src/app/sidepanel/settings/plugins-pane.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const sheet = { open: vi.fn(), close: vi.fn(), setBody: vi.fn(), setActions: vi.fn() };
const deps = {
  formatErrorDetails: (error) => error?.message ?? String(error),
  models: { refresh: vi.fn(async () => null) },
  connection: { call: vi.fn() }
};

describe("设置页刷新竞态", () => {
  it("模型页只接受最后一次刷新结果", async () => {
    const host = document.createElement("div");
    const first = deferred();
    const second = deferred();
    const settingsService = {
      loadProviderRows: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
    };
    const pane = createModelsPane({ host, sheet, deps, settingsService });
    const oldLoad = pane.refresh();
    const newLoad = pane.refresh();
    second.resolve({ rows: [{ configured: true, removable: false, entry: {
      provider: "new", displayName: "New Provider", settingsNs: "new"
    } }], namespaces: new Map(), writable: true, failures: [] });
    await newLoad;
    first.reject(new Error("stale failure"));
    await oldLoad;

    expect(host.textContent).toContain("New Provider");
    expect(host.textContent).not.toContain("stale failure");
  });

  it("预设页只接受最后一次刷新结果", async () => {
    const host = document.createElement("div");
    const first = deferred();
    const second = deferred();
    const settingsService = {
      presetList: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      describe: vi.fn(async () => ({ writable: true, namespaces: [] }))
    };
    const pane = createPresetsPane({ host, sheet, deps, settingsService });
    const oldLoad = pane.refresh();
    const newLoad = pane.refresh();
    second.resolve({ presets: [{ id: "new", name: "New Preset", trust: "user" }] });
    await newLoad;
    first.resolve({ presets: [{ id: "old", name: "Old Preset", trust: "user" }] });
    await oldLoad;

    expect(host.textContent).toContain("New Preset");
    expect(host.textContent).not.toContain("Old Preset");
  });

  it("通用页只接受最后一次设置快照", async () => {
    const host = document.createElement("div");
    const first = deferred();
    const second = deferred();
    const settingsService = {
      describe: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      presetList: vi.fn(async () => ({ presets: [] }))
    };
    const pane = createGeneralPane({
      host,
      deps: {
        ...deps,
        settings: { getNotificationsEnabled: vi.fn(async () => true) },
        getLang: () => "zh", setLang: vi.fn()
      },
      settingsService,
      showToast: vi.fn()
    });
    const oldLoad = pane.refresh();
    await vi.waitFor(() => expect(settingsService.describe).toHaveBeenCalledTimes(1));
    const newLoad = pane.refresh();
    await vi.waitFor(() => expect(settingsService.describe).toHaveBeenCalledTimes(2));
    second.resolve({ namespaces: [{ ns: "ui-theme", revision: 2,
      value: { preference: "dark" } }], writable: true });
    await newLoad;
    first.resolve({ namespaces: [{ ns: "ui-theme", revision: 1,
      value: { preference: "light" } }], writable: true });
    await oldLoad;
    expect(host.querySelector("#set-theme")?.value).toBe("dark");
  });

  it("插件配置页只接受最后一次 describe", async () => {
    const host = document.createElement("div");
    const first = deferred();
    const second = deferred();
    const settingsService = {
      describe: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
    };
    const pane = createPluginsPane({
      host, deps, settingsService, showToast: vi.fn(), pluginActions: null
    });
    const oldLoad = pane.refresh();
    const newLoad = pane.refresh();
    second.resolve({ namespaces: [{ ns: "shell", revision: 2, value: {}, base: {}, user: {} }],
      writable: true });
    await newLoad;
    first.resolve({ namespaces: [{ ns: "agent-loop", revision: 1, value: {}, base: {}, user: {} }],
      writable: true });
    await oldLoad;
    expect(host.querySelector("#plug-head-shell")).toBeTruthy();
    expect(host.querySelector("#plug-head-agent-loop")).toBeNull();
  });
});
