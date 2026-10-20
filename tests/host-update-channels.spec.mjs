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
test("server ops follows the higher of next/alpha like the Mac checker", async () => {
  let updates = [], restarts = 0;
  const ops = createServerOps({ client: { serverVersion: async (target) => payload(target), serverUpdate: async (target) => { updates.push(target); return { exitCode: 0 }; }, serverRestart: () => restarts++ } });
  const v = await ops.version();
  assert.equal(v.targetVersion, tags.alpha); assert.equal(v.updateTarget, tags.alpha); assert.equal(v.updatable, true);
  assert.equal(v.releaseUrl, "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v" + tags.alpha);
  const rcAhead = createServerOps({ client: { serverVersion: async () => ({ ...payload(), distTags: { latest: "1.0.0", next: "2.1.0-rc.1", alpha: "2.1.0-alpha.3" } }) } });
  assert.equal((await rcAhead.version()).targetVersion, "2.1.0-rc.1");
  const current = createServerOps({ client: { serverVersion: async () => ({ ...payload(), current: "2.0.0-alpha.10" }) } });
  assert.equal((await current.version()).updatable, false);
  await ops.update(v.updateTarget); assert.deepEqual(updates, [tags.alpha]); assert.equal(restarts, 0);
  const old = createServerOps({ client: { serverVersion: async () => ({ current: "0.9.0", latest: "1.0.0", updatable: true }), serverUpdate: async (target) => { updates.push(target); return { exitCode: 0 }; } } });
  const legacy = await old.version();
  assert.equal(legacy.updatable, true); assert.equal(legacy.updateTarget, "latest");
  await assert.rejects(old.update("2.0.0-alpha.10"), /newer chrome-daemon/); assert.equal(updates.length, 1);
  await old.update(legacy.updateTarget); assert.deepEqual(updates, [tags.alpha, "latest"]);
});
test("invalid or missing dist-tags are not silently replaced by latest", async () => {
  const ops = createServerOps({ client: { serverVersion: async () => ({ ...payload(), distTags: { latest: "9.0.0", alpha: "1.2.3-01", evil: "99.0.0" } }), serverUpdate: async () => { throw Error("must not install"); } } });
  const result = await ops.version(); assert.equal(result.targetVersion, null); assert.equal(result.updateTarget, null); assert.equal(result.checkFailed, true); assert.deepEqual(result.distTags, { latest: "9.0.0" });
  await assert.rejects(ops.update("1.2.3"), /unavailable/);
});
test("failed install exposes stderr and never restarts", async () => {
  const ops = createServerOps({ client: { serverUpdate: async () => ({ exitCode: 1, stderr: "registry unavailable" }), serverRestart: () => assert.fail("restart") } });
  await assert.rejects(ops.update(), { name: "ServerUpdateError", message: "registry unavailable" });
});
function paneHarness(serverOps) {
  const dom = new JSDOM('<div id="host"></div>'); const host = dom.window.document.querySelector("#host");
  const pane = createServerPane({ host, deps: { connection: { streamState: "connected", baseUrl: "http://127.0.0.1:3080" }, DshStreamState: { CONNECTED: "connected", CONNECTING: "connecting" } }, serverOps });
  return { dom, host, pane };
}
const versionInfo = (current, targetVersion) => ({ current, targetVersion, updateTarget: targetVersion, updateSupported: true,
  updatable: isUpgrade(current, targetVersion), releaseUrl: "https://example.test/dsh-v" + targetVersion, checkFailed: false });
test("server pane has no channel picker and hides the update row until a newer dsh exists", async (t) => {
  const h = paneHarness({ version: async () => versionInfo("2.0.0", "1.9.0") });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle();
  assert.equal(h.host.querySelector("select"), null); assert.equal(h.host.querySelector("#srv-dsh-channel"), null);
  assert.equal(h.host.querySelector("#srv-dsh-update"), null);
});
test("update installs the checked version, then the row offers restart which re-checks", async (t) => {
  const updates = []; let restarts = 0; let current = "1.0.0";
  const h = paneHarness({ version: async () => versionInfo(current, "1.1.0-alpha.2"), update: async (target) => updates.push(target),
    restart: async () => { restarts++; current = "1.1.0-alpha.2"; return { started: true }; } });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle();
  assert.match(h.host.textContent, /1\.0\.0 → 1\.1\.0-alpha\.2/);
  assert.equal(h.host.querySelector(".srv-release-notes").getAttribute("href"), "https://example.test/dsh-v1.1.0-alpha.2");
  h.host.querySelector("#srv-dsh-update").click(); await settle();
  assert.deepEqual(updates, ["1.1.0-alpha.2"]); assert.equal(restarts, 0);
  assert.equal(h.host.querySelector("#srv-dsh-update"), null);
  h.host.querySelector("#srv-dsh-update-restart").click(); await settle(); await settle();
  assert.equal(restarts, 1);
  assert.equal(h.host.querySelector("#srv-dsh-update-restart"), null); assert.equal(h.host.querySelector("#srv-dsh-update"), null);
});
test("old daemon still offers the latest-only update", async (t) => {
  const h = paneHarness({ version: async () => ({ current: "0.9.0", latest: "1.0.0", targetVersion: "1.0.0", updateTarget: "latest", updatable: true, updateSupported: false }) });
  t.after(() => { h.pane.stop(); h.dom.window.close(); });
  await h.pane.refresh(); await settle();
  assert.equal(h.host.querySelector("#srv-dsh-update").disabled, false);
});
