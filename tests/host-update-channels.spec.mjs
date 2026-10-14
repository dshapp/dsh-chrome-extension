import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { compareVersions, isExactVersion, isUpgrade, validateUpdateTarget } from "../src/features/host-proxy/version.js";
import { createHostProxyClient } from "../src/platform/dsh/host-proxy-client.js";
import { createServerOps } from "../src/features/host-proxy/server-ops.js";
import { createServerPane } from "../src/app/sidepanel/settings/server-pane.js";
const tags = { latest: "1.0.0", next: "1.1.0-rc.2", alpha: "2.0.0-alpha.10" };
function payload(target = "latest") { return { current: "1.0.0", latest: tags.latest, target,
  targetVersion: tags[target] ?? (isExactVersion(target) ? target : null), distTags: tags, updateSupported: true }; }
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("strict SemVer validation excludes ranges, packages and injection", () => {
  for (const value of ["1.2.3", "1.2.3-alpha.0+build.01", "9007199254740993.2.3"]) assert.ok(isExactVersion(value), value);
  for (const value of ["", "1", "1.2", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3+", "1.2.3-a..b", "1.2.3+..x", "1.2.3\n", " 1.2.3", "^1.2.3", "~1.2.3", "*", "beta", "@evil/pkg", "latest; echo pwn", "--version", "file:/tmp/pkg", null, {}, 42]) {
    assert.ok(!isExactVersion(value), String(value)); assert.throws(() => validateUpdateTarget(value));
  }
  assert.equal(validateUpdateTarget(), "latest");
  for (const value of ["latest", "next", "alpha"]) assert.equal(validateUpdateTarget(value), value);
});
test("SemVer prerelease ordering, metadata equality and arbitrary precision", () => {
  const versions = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < versions.length; i++) { assert.equal(compareVersions(versions[i-1], versions[i]), -1); assert.equal(compareVersions(versions[i], versions[i-1]), 1); }
  assert.equal(compareVersions("1.2.3+a", "1.2.3+b"), 0);
  assert.equal(compareVersions("1.2.3-alpha.9007199254740992", "1.2.3-alpha.9007199254740993"), -1);
  assert.ok(isUpgrade("0.9.0", "0.10.0"));
  assert.equal(compareVersions("1.2.3 junk", "1.2.4"), null);
  assert.ok(!isUpgrade("1.2.3", "1.2.3-alpha.1"));
});
test("host proxy POST carries only validated target, legacy empty calls unchanged", async () => {
  const calls = [];
  const client = createHostProxyClient({ fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, text: async () => "{}" }; } });
  await client.serverVersion(); await client.serverUpdate();
  await client.serverVersion("next"); await client.serverUpdate("1.2.3-alpha.2+build.01");
  assert.deepEqual(calls.map((x) => JSON.parse(x.options.body)), [{}, {}, { target: "next" }, { target: "1.2.3-alpha.2+build.01" }]);
  for (const { url, options } of calls) { assert.ok(["http://127.0.0.1:37086/host/server/version", "http://127.0.0.1:37086/host/server/update"].includes(url)); assert.equal(options.method, "POST"); assert.equal(options.headers["content-type"], "application/json"); }
  assert.throws(() => client.serverUpdate({ package: "evil" })); assert.equal(calls.length, 4);
});
test("server ops chooses requested dist-tag, detects downgrade and refuses old protocol", async () => {
  let updates = 0, restarts = 0;
  const ops = createServerOps({ client: { serverVersion: async (target) => payload(target), serverUpdate: async () => { updates++; return { exitCode: 0 }; }, serverRestart: () => restarts++ } });
  assert.equal((await ops.version()).updatable, false);
  assert.equal((await ops.version("next")).targetVersion, tags.next);
  assert.equal((await ops.version("alpha")).updatable, true);
  assert.equal((await ops.version("0.9.0")).downgrade, true);
  await ops.update("next"); assert.equal(updates, 1); assert.equal(restarts, 0);
  const old = createServerOps({ client: { serverVersion: async () => ({ current: "0.9.0", latest: "1.0.0", updatable: true }), serverUpdate: async () => { updates++; return { exitCode: 0 }; } } });
  assert.equal((await old.version()).updatable, true);
  assert.equal((await old.version("next")).targetVersion, null);
  await assert.rejects(old.update("next"), /newer chrome-daemon/); assert.equal(updates, 1);
  await old.update(); assert.equal(updates, 2);
});
test("missing or mismatched target is not silently replaced by latest", async () => {
  const ops = createServerOps({ client: { serverVersion: async () => ({ ...payload(), distTags: { latest: "bad", alpha: "1.2.3-01", evil: "99.0.0" } }), serverUpdate: async () => { throw Error("must not install"); } } });
  const result = await ops.version("next"); assert.equal(result.targetVersion, null); assert.equal(result.checkFailed, true); assert.deepEqual(result.distTags, {});
  await assert.rejects(ops.update("next"), /unavailable/);
});
test("failed install exposes stderr and never restarts", async () => {
  const ops = createServerOps({ client: { serverUpdate: async () => ({ exitCode: 1, stderr: "registry unavailable" }), serverRestart: () => assert.fail("restart") } });
  await assert.rejects(ops.update(), { name: "ServerUpdateError", message: "registry unavailable" });
});
function paneHarness(serverOps) {
  const dom = new JSDOM('<div id="host"></div>'); const host = dom.window.document.querySelector("#host");
  const pane = createServerPane({ host, deps: { connection: { streamState: "connected", baseUrl: "http://127.0.0.1:3080" }, DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting" } }, serverOps });
  function change(selector, value) { const node = host.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new dom.window.Event("change")); }
  return { dom, host, pane, change };
}
test("server pane selects channel/exact target and update completion never restarts", async (t) => {
  const updates = [], queries = []; let restarts = 0;
  const h = paneHarness({ version: async (target) => { queries.push(target); return { ...payload(target), updatable: target !== "latest", checkFailed: false }; }, update: async (target) => updates.push(target), restart: () => restarts++ });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle();
  assert.equal(h.host.querySelector("#srv-dsh-channel").value, "latest");
  h.change("#srv-dsh-channel", "next"); await settle();
  assert.match(h.host.textContent, /1\.1\.0-rc\.2/);
  h.host.querySelector("#srv-dsh-update").click(); await settle();
  assert.deepEqual(updates, ["next"]); assert.equal(restarts, 0); assert.equal(h.host.querySelector("#srv-dsh-update").disabled, true);
  h.change("#srv-dsh-channel", "exact"); await settle();
  h.change("#srv-dsh-exact", "1.2.3-alpha.10+build.01"); await settle();
  h.host.querySelector("#srv-dsh-update").click(); await settle();
  assert.deepEqual(updates, ["next", "1.2.3-alpha.10+build.01"]); assert.ok(queries.includes("1.2.3-alpha.10+build.01"));
});
test("stale target query cannot overwrite a later choice, invalid exact never queries", async (t) => {
  let release; const queries = [];
  const h = paneHarness({ version: async (target) => { queries.push(target); if (target === "next") await new Promise((r) => release = r); return { ...payload(target), updatable: target !== "latest", checkFailed: false }; } });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle();
  h.change("#srv-dsh-channel", "next"); h.change("#srv-dsh-channel", "alpha"); await settle(); release(); await settle();
  assert.equal(h.host.querySelector("#srv-dsh-channel").value, "alpha"); assert.match(h.host.textContent, /2\.0\.0-alpha\.10/);
  h.change("#srv-dsh-channel", "exact"); const before = queries.length; h.change("#srv-dsh-exact", "^1.2.3"); await settle();
  assert.equal(queries.length, before); assert.ok(!h.host.querySelector("#srv-dsh-update") || h.host.querySelector("#srv-dsh-update").disabled);
});
test("old daemon leaves latest path compatible and channel selector disabled", async (t) => {
  const h = paneHarness({ version: async () => ({ current: "0.9.0", latest: "1.0.0", targetVersion: "1.0.0", updatable: true, updateSupported: false }) });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle();
  assert.equal(h.host.querySelector("#srv-dsh-channel").disabled, true);
  assert.equal(h.host.querySelector("#srv-dsh-update").disabled, false);
});
