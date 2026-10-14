import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createPluginManagerService } from "../src/features/settings/plugin-manager-service.js";
import { createInstallRecovery } from "../src/app/sidepanel/settings/plugin-install-recovery.js";
import { schemaFields, parseSchemaValue, createPluginSchemaConfig } from "../src/app/sidepanel/settings/plugin-schema-config.js";
import { updateAvailable, bundleRows, detailSubject } from "../src/app/sidepanel/settings/plugin-detail-view.js";
import { availableCards, PLUGIN_CARDS } from "../src/app/sidepanel/settings/plugin-config-cards.js";
const dom = new JSDOM('<!doctype html><html><body><main></main><aside></aside></body></html>');
globalThis.window = dom.window; globalThis.document = dom.window.document;
const { createMarketplaceView } = await import("../src/app/sidepanel/settings/plugin-marketplace.js");
const { createPluginsPane } = await import("../src/app/sidepanel/settings/plugins-pane.js");
const { createPluginDetailView } = await import("../src/app/sidepanel/settings/plugin-detail-view.js");
const { createInstallCompatibility } = await import("../src/app/sidepanel/settings/plugin-install-compatibility.js");
const { openPluginInstallSheet } = await import("../src/app/sidepanel/settings/plugin-install-sheet.js");
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const deps = { formatErrorDetails: error => error?.message ?? String(error) };
const pkg = (extra = {}) => ({ name: "@scope/bundle", official: true, optional: false, installed: false, enabled: false,
  availability: "missing", removable: false, rows: [], installTarget: { spec: "@scope/bundle@0.2.1-alpha.2", version: "0.2.1-alpha.2" }, ...extra });
function fakeSheet() {
  const root = document.createElement("div"); let token;
  return { root, open(options) { token = {}; root.innerHTML = options.body + options.actions; queueMicrotask(() => options.bind?.(root)); return token; },
    setBody(html, owner) { if (owner === token) { root.innerHTML = html + (this.actions ?? ""); } },
    setActions(html, owner) { if (owner === token) { this.actions = html; root.innerHTML += html; } },
    close(owner) { if (owner === token) { token = null; root.innerHTML = ""; } }, owns(owner) { return owner === token; } };
}

test("new RPC options preserve saveExact false and exact exemption arguments", async () => {
  const calls = [];
  const service = createPluginManagerService({ async call(method, args) { calls.push({ method, args }); return {}; } });
  await service.installBundle("p@1", { requestId: "r", saveExact: false, enabled: false, registry: null });
  await service.waitForInstall("r"); await service.listVersionExemptions();
  await service.setVersionExemption("@s/p@1", "0.2.1-alpha.2", true, true);
  await service.setVersionExemption("@s/p@1", "old", false);
  assert.deepEqual(calls[0].args, { spec: "p@1", options: { requestId: "r", enabled: false, saveExact: false, registry: null } });
  assert.equal(calls[1].method, "pluginManager/waitForInstall"); assert.deepEqual(calls[1].args, { requestId: "r" });
  assert.equal(calls[2].method, "pluginManager/listVersionExemptions");
  assert.deepEqual(calls[3].args, { packageVersion: "@s/p@1", runtimeVersion: "0.2.1-alpha.2", enabled: true, acceptRisk: true });
  assert.ok(!Object.hasOwn(calls[4].args, "acceptRisk"));
});

test("install reply lost joins original request; no duplicate install", async () => {
  let installs = 0; const waited = [], settled = [], uncertain = [];
  const recovery = createInstallRecovery({ settingsService: {
    async installBundle() { installs++; throw new Error("disconnected"); },
    async waitForInstall(id) { waited.push(id); return { application: "restart-required" }; }
  }, onSettled: result => settled.push(result), onUncertain: (...args) => uncertain.push(args) });
  await recovery.start("p", { requestId: "r" });
  assert.equal(installs, 1); assert.deepEqual(waited, ["r"]); assert.equal(settled[0].application, "restart-required");
  assert.equal(uncertain.length, 1); assert.equal(recovery.pending, false);
});

test("recovery unavailable remains pending, manual recovery converges null to unknown", async () => {
  let calls = 0, installs = 0; const unknown = [];
  const recovery = createInstallRecovery({ settingsService: {
    async installBundle() { installs++; throw new Error("offline"); },
    async waitForInstall() { if (++calls === 1) throw new Error("still offline"); return null; }
  }, onSettled: () => assert.fail("not a success"), onUncertain: (cause, value) => unknown.push(value) });
  await recovery.start("p", { requestId: "r" }); assert.equal(recovery.pending, true);
  await recovery.start("p", { requestId: "other" }); assert.equal(installs, 1);
  await recovery.recover(); assert.equal(recovery.pending, false); assert.equal(unknown.at(-1), true);
});

test("dispose ignores late install result", async () => {
  let done; const result = new Promise(resolve => { done = resolve; }); let settled = 0;
  const recovery = createInstallRecovery({ settingsService: { installBundle: () => result }, onSettled: () => settled++ });
  const work = recovery.start("p", { requestId: "r" }); recovery.dispose(); done({ application: "applied" }); await work;
  assert.equal(settled, 0);
});

test("official flag overrides optional; missing official enables via exact catalog install", async () => {
  const host = document.querySelector("main"), sheet = fakeSheet(); let enabledCalls = 0, installs = [];
  const bundles = [pkg(), pkg({ name: "community", official: false, optional: true, installed: true, availability: "profile", installTarget: undefined })];
  let view;
  const service = { pluginBundles: async () => bundles, pluginEntries: async () => [], setBundleEnabled: async () => enabledCalls++,
    installBundle: async (spec, options) => { installs.push({ spec, options }); return { application: "applied" }; } };
  view = createMarketplaceView({ host, sheet, deps, settingsService: service, cards: [], onChange: () => view.paint() });
  await view.refresh();
  assert.match(host.querySelector("#plug-count-official").textContent, /1$/);
  assert.match(host.querySelector("#plug-count-installed").textContent, /1$/);
  const enable = host.querySelector('input[id="plug-bundle-@scope/bundle"]'); enable.checked = true;
  enable.dispatchEvent(new dom.window.Event("change")); await flush();
  assert.equal(enabledCalls, 0); assert.ok(sheet.root.querySelector("#plug-install-run"));
  sheet.root.querySelector("#plug-install-run").click(); await flush();
  assert.equal(installs[0].spec, "@scope/bundle@0.2.1-alpha.2"); assert.equal(installs[0].options.saveExact, true);
  assert.equal(installs[0].options.enabled, true);
});

test("missing official without installTarget is not a fake enable control", async () => {
  const host = document.querySelector("main"); let view;
  view = createMarketplaceView({ host, deps, settingsService: { pluginBundles: async () => [pkg({ installTarget: undefined })], pluginEntries: async () => [] }, cards: [], onChange: () => view.paint() });
  await view.refresh(); assert.equal(host.querySelector('input[id="plug-bundle-@scope/bundle"]').disabled, true);
});

test("version updates are offered for profile version / changed checkout link only", () => {
  assert.equal(updateAvailable(pkg({ installed: true, availability: "profile", version: "0.2.0" })), true);
  assert.equal(updateAvailable(pkg({ installed: true, availability: "installation", version: "old" })), false);
  assert.equal(updateAvailable(pkg({ installed: true, availability: "profile", version: "0.2.1-alpha.2" })), false);
  assert.equal(updateAvailable(pkg({ installed: true, availability: "profile", version: "dev", source: "link:/old", installTarget: { spec: "link:/new", version: "dev" } })), true);
});

test("bundle rows join exact unique entry identities and unaddressable rows remain locked", () => {
  const bundle = pkg({ rows: [{ rowId: "r", moduleName: "m", entryId: "e" }, { rowId: "gone", moduleName: "n" }] });
  const rows = bundleRows(bundle, [{ entryId: "e", enabled: true, patchId: "patch", fiberPhase: "active" }]);
  assert.equal(rows[0].enabled, true); assert.equal(rows[1].readOnlyReason, "unaddressable");
  assert.equal(bundleRows(bundle, [{ entryId: "e" }, { entryId: "e" }])[0].readOnlyReason, "unaddressable");
  assert.deepEqual(detailSubject(bundle, rows, rows[0]).row, { rowId: "r", moduleName: "m", enabled: true });
});

test("schema fallback handles nested primitives, excludes secrets, and validates bounds", () => {
  const schema = { type: "object", dict: { secret: { type: "string", meta: { role: "secret" } }, nested: { type: "object", dict: {
    flag: { type: "boolean" }, count: { type: "number", meta: { min: 1, max: 3 } }, compound: { type: "array" }
  } } } };
  const fields = schemaFields(schema); assert.equal(fields.length, 3); assert.equal(fields[2].editable, false);
  assert.deepEqual(parseSchemaValue(fields[0], "false"), { op: "set", path: ["nested", "flag"], value: false });
  assert.deepEqual(parseSchemaValue(fields[1], ""), { op: "unset", path: ["nested", "count"] });
  assert.throws(() => parseSchemaValue(fields[1], "4")); assert.throws(() => parseSchemaValue(fields[1], "nan"));
});

test("schema saves use exact revision and retain draft after conflict", async () => {
  const host = document.querySelector("main"); let call;
  const namespace = { ns: "row", revision: 7, schema: { type: "object", dict: { flag: { type: "boolean" } } }, value: { flag: true } };
  const config = createPluginSchemaConfig({ settingsService: { async mutate(...args) { call = args; throw new Error("conflict"); } },
    describeNow: () => ({ writable: true, namespaces: [namespace] }), onChange: () => paint() });
  function paint() { host.innerHTML = config.render("row"); config.bind(host, "row"); } paint();
  host.querySelector("#plug-schema-0").value = "false"; host.querySelector("#plug-schema-0").dispatchEvent(new dom.window.Event("change"));
  host.querySelector("#plug-schema-save").click(); await flush();
  assert.deepEqual(call, ["row", [{ op: "set", path: ["flag"], value: false }], 7]);
  assert.equal(host.querySelector("#plug-schema-0").value, "false"); assert.match(host.textContent, /conflict/);
});

test("partial subagent namespace still exposes limits, not fabricated model controls", () => {
  const [card] = availableCards(PLUGIN_CARDS, ["subagent"]);
  assert.equal(card.id, "subagent"); assert.equal(card.modelSelection, null);
});

test("package/row detail slots receive local subject and can bind", async () => {
  const host = document.querySelector("main"); const seen = []; let bound = 0, rowChange;
  const bundle = pkg({ availability: "profile", installed: true, enabled: true, rows: [{ rowId: "r", moduleName: "m", entryId: "e" }] });
  const entries = [{ entryId: "e", enabled: true, fiberPhase: "active", patchId: "p" }];
  const detail = createPluginDetailView({ settingsService: { listVersionExemptions: async () => ({ exemptions: {}, warnings: [] }) }, deps,
    schemaConfig: { render: ns => '<p>' + ns + '</p>', bind() {}, form() {} },
    renderSlot: (name, owner) => { seen.push({ name, subject: owner.subject }); return name === "plugins.detail.section" ? { html: '<div id="local-slot"></div>', bind: () => bound++ } : ""; },
    onChange() {}, onBack() {}, onOpenRow() {}, onEnable: (...args) => { rowChange = args; } });
  host.innerHTML = detail.render(bundle, entries, "r"); detail.bind(host);
  assert.equal(bound, 1); assert.ok(seen.every(item => item.subject.kind === "row"));
  const control = host.querySelector("#plug-detail-enabled"); control.checked = false; control.dispatchEvent(new dom.window.Event("change"));
  assert.equal(rowChange[2].entry.entryId, "e"); assert.equal(rowChange[1], false);
});

test("version exemption grant requires separate risk confirmation, revoke needs no acceptRisk", async () => {
  const host = document.querySelector("main"), sheet = fakeSheet(), calls = [];
  const bundle = pkg({ installed: true, version: "1", error: { code: "incompatible-version", incompatible: [{ name: "@s/p", version: "1", runtimeVersion: "0.2.1-alpha.2", peers: { dsh: ">=99" } }] } });
  let detail;
  const service = { async listVersionExemptions() { return { exemptions: { "@scope/bundle@1": ["old"] }, warnings: ["invalid stored entry"] }; },
    async setVersionExemption(...args) { calls.push(args); return { application: "applied" }; } };
  function paint() { host.innerHTML = detail.render(bundle, []); detail.bind(host); }
  detail = createPluginDetailView({ settingsService: service, sheet, deps, schemaConfig: {}, onChange: paint, onBack() {}, onOpenRow() {}, onEnable() {} });
  await detail.refreshExemptions(); paint();
  host.querySelector("#plug-exempt-grant-0").click(); await flush(); assert.equal(calls.length, 0);
  sheet.root.querySelector("#plug-risk-accept").click(); await flush();
  assert.deepEqual(calls[0], ["@s/p@1", "0.2.1-alpha.2", true, true]);
  host.querySelector("#plug-exempt-revoke-0").click(); await flush();
  assert.deepEqual(calls[1], ["@scope/bundle@1", "old", false, undefined]);
});

test("install incompatibility consent persists exact pair without automatic retry", async () => {
  const root = document.querySelector("main"); const calls = []; let compatibility;
  function paint() { root.innerHTML = compatibility.render(); compatibility.bind(root); }
  compatibility = createInstallCompatibility({ settingsService: { async setVersionExemption(...args) { calls.push(args); return { application: "applied" }; } }, onChange: paint });
  compatibility.set({ error: { incompatible: [{ name: "p", version: "1", runtimeVersion: "0.2", peers: { dsh: ">9" } }] } }); paint();
  assert.equal(root.querySelector("#plug-install-exempt").disabled, true);
  const check = root.querySelector("#plug-install-risk"); check.checked = true; check.dispatchEvent(new dom.window.Event("change"));
  root.querySelector("#plug-install-exempt").click(); await flush(); assert.deepEqual(calls, [["p@1", "0.2", true, true]]);
});

test("readonly settings inventory has no package writes and cleans host subscription", async () => {
  const host = document.querySelector("aside"); let cleaned = 0, managerOpened = 0, forbidden = 0;
  const pane = createPluginsPane({ host, deps: { ...deps, sessions: { onPluginManagerChanged: () => () => cleaned++ } }, readOnlyInventory: true,
    settingsService: { async pluginInventory() { return { entries: [{ entryId: "e", moduleName: "m", enabled: true }] }; }, async describe() { forbidden++; } },
    pluginActions: { async list() { forbidden++; } }, onOpenManager: () => managerOpened++ });
  await pane.refresh(); host.querySelector("#plug-open-manager").click();
  assert.equal(managerOpened, 1); assert.equal(forbidden, 0); assert.equal(host.querySelector("#plug-install"), null);
  assert.equal(host.querySelector("[data-subtab]"), null); pane.dispose(); assert.equal(cleaned, 1);
});

test("marketplace remains accessible when configuration describe is unavailable", async () => {
  const host = document.querySelector("main");
  const pane = createPluginsPane({ host, deps, settingsService: { async describe() { throw new Error("no settings"); }, async pluginBundles() { return [pkg()]; }, async pluginEntries() { return []; } } });
  await pane.refresh(); assert.match(host.textContent, /no settings/); assert.ok(host.querySelector("#plug-add")); pane.dispose();
});

test("pane visibility plus force refresh coalesce and supports refresh false", async () => {
  const host = document.querySelector("aside"); let calls = 0, finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const pane = createPluginsPane({ host, deps, readOnlyInventory: true, settingsService: { async pluginInventory() { calls++; await waiting; return { entries: [] }; } } });
  pane.setVisible(true); const first = pane.refresh(); const second = pane.refresh();
  assert.equal(first, second); assert.equal(calls, 1); finish(); await first;
  pane.setVisible(false); pane.setVisible(true, { refresh: false }); assert.equal(calls, 1); pane.dispose();
});
