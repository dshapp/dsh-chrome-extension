import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  NativeHostIssue, classifyNativeFailure, isNativeHostSetupError, toNativeHostError
} from "../src/platform/dsh/native-host-error.js";
import { installSessionCookie } from "../src/platform/dsh/session-cookie.js";
import { renderSetupGuide, mountSetupGuide, recommendsMacApp, SETUP_COMMANDS, INSTALL_SCRIPTS } from "../src/features/onboarding/setup-guide.js";
import { openWelcomeIfNeeded, WELCOME_PAGE } from "../sw/onboarding.js";
import { setLang, t } from "../src/shared/i18n.js";

const HOST_MISSING = "Specified native messaging host not found.";

test("Chrome's native messaging failures are classified into actionable issues", () => {
  assert.equal(classifyNativeFailure(HOST_MISSING), NativeHostIssue.MISSING);
  assert.equal(classifyNativeFailure("Access to the specified native messaging host is forbidden."), NativeHostIssue.FORBIDDEN);
  assert.equal(classifyNativeFailure("caller-not-allowed"), NativeHostIssue.FORBIDDEN);
  assert.equal(classifyNativeFailure("Native host has exited."), NativeHostIssue.BROKEN);
  assert.equal(classifyNativeFailure("Error when communicating with the native messaging host."), NativeHostIssue.BROKEN);
  assert.equal(classifyNativeFailure("port-stayed-down"), null);
  assert.equal(classifyNativeFailure(""), null);
  assert.equal(toNativeHostError(new Error("boom")), null);
});

test("a missing native host surfaces as a setup error, never as Chrome's raw message", async () => {
  const chromeApi = {
    runtime: { sendNativeMessage: async () => { throw new Error(HOST_MISSING); } },
    cookies: { set: async () => ({}) }
  };
  await assert.rejects(installSessionCookie("http://127.0.0.1:3080", { chromeApi }), (error) => {
    assert.equal(isNativeHostSetupError(error), true);
    assert.equal(error.issue, NativeHostIssue.MISSING);
    assert.equal(error.detail, HOST_MISSING);
    assert.equal(error.i18nKey, "setup.toast.host-missing");
    assert.notEqual(t(error.i18nKey), error.i18nKey, "toast fallback text must exist");
    return true;
  });
});

test("a host that refuses the caller is reported as forbidden", async () => {
  const chromeApi = {
    runtime: { sendNativeMessage: async () => ({ ok: false, reason: "caller-not-allowed" }) },
    cookies: { set: async () => ({}) }
  };
  await assert.rejects(installSessionCookie("http://127.0.0.1:3080", { chromeApi }),
    (error) => error.issue === NativeHostIssue.FORBIDDEN);
});

test("other cookie failures keep their original message", async () => {
  const chromeApi = {
    runtime: { sendNativeMessage: async () => ({ ok: false, reason: "secret missing" }) },
    cookies: { set: async () => ({}) }
  };
  await assert.rejects(installSessionCookie("http://127.0.0.1:3080", { chromeApi }), (error) => {
    assert.equal(isNativeHostSetupError(error), false);
    assert.equal(error.message, "secret missing");
    return true;
  });
});

test("probeHost reports a stable reason code and keeps the raw text as detail", async () => {
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { sendNativeMessage: async () => { throw new Error(HOST_MISSING); } } };
  try {
    const { probeHost } = await import("../src/platform/dsh/native-supervisor.js");
    assert.deepEqual(await probeHost(), { ok: false, reason: NativeHostIssue.MISSING, detail: HOST_MISSING });
  } finally {
    globalThis.chrome = previous;
  }
});

function fragment(html) {
  return new JSDOM("<body>" + html + "</body>").window.document;
}

const MANUAL = [SETUP_COMMANDS.pnpm, SETUP_COMMANDS.dsh, SETUP_COMMANDS.plugin, SETUP_COMMANDS.start];
const copiesOf = (doc) => [...doc.querySelectorAll(".setup-copy")].map((node) => node.dataset.copy);

test("setup guide on macOS offers the app, the one-command script and the manual steps", () => {
  setLang("zh");
  const doc = fragment(renderSetupGuide({ issue: NativeHostIssue.MISSING, os: "mac", arch: "arm64" }));
  assert.ok(doc.querySelector(".setup-card-app a[href*='/download/']"));
  assert.deepEqual(copiesOf(doc), [INSTALL_SCRIPTS.unix.command, ...MANUAL]);
  assert.equal(INSTALL_SCRIPTS.unix.command, "curl -fsSL https://dshapp.github.io/install/chrome.sh | bash");
  assert.ok(doc.querySelector(".setup-card-script a[href='https://dshapp.github.io/install/chrome.sh']"), "script is inspectable");
  const manual = doc.querySelector("details.setup-manual");
  assert.ok(manual && !manual.open, "manual steps stay folded");
  const steps = copiesOf(manual);
  assert.ok(steps.indexOf(SETUP_COMMANDS.pnpm) < steps.indexOf(SETUP_COMMANDS.plugin), "pnpm must precede dsh plugin add");
  assert.ok(doc.querySelector("[data-setup-check]"));
  assert.doesNotMatch(doc.body.textContent, /native messaging host not found/i);
});

test("the macOS App is recommended on Apple Silicon Macs only", () => {
  assert.equal(recommendsMacApp({ os: "mac", arch: "arm64" }), true);
  assert.equal(recommendsMacApp({ os: "mac", arch: "arm" }), true);
  assert.equal(recommendsMacApp({ os: "mac", arch: "" }), true, "unknown arch on a Mac still recommends");
  assert.equal(recommendsMacApp({ os: "mac", arch: "x86-64" }), false, "Intel Mac cannot run the App");
  for (const os of ["linux", "cros", "win", "openbsd", "unknown", undefined]) {
    assert.equal(recommendsMacApp({ os, arch: "arm64" }), false, String(os));
  }
  setLang("zh");
  for (const [os, arch] of [["linux", "x86-64"], ["cros", "arm64"], ["unknown", ""], ["mac", "x86-64"], [undefined, ""]]) {
    const doc = fragment(renderSetupGuide({ issue: NativeHostIssue.MISSING, os, arch }));
    assert.equal(doc.querySelector(".setup-card-app"), null, os + "/" + arch + " must not recommend the App");
    assert.doesNotMatch(doc.body.textContent, /macOS App|任一方式|或者用一条命令/, os + "/" + arch);
    assert.deepEqual(copiesOf(doc), [INSTALL_SCRIPTS.unix.command, ...MANUAL]);
  }
  const win = fragment(renderSetupGuide({ issue: NativeHostIssue.MISSING, os: "win", arch: "x86-64" }));
  assert.doesNotMatch(win.body.textContent, /macOS App|任一方式/);
  const mac = fragment(renderSetupGuide({ issue: NativeHostIssue.MISSING, os: "mac", arch: "arm64" }));
  assert.match(mac.querySelector(".setup-lede").textContent, /任一方式/);
  assert.match(mac.body.textContent, /或者用一条命令安装/);
});

test("setup guide adapts to platform and issue", () => {
  setLang("en");
  const linux = fragment(renderSetupGuide({ issue: NativeHostIssue.MISSING, os: "linux" }));
  assert.equal(linux.querySelector(".setup-card-app"), null);
  assert.equal(copiesOf(linux)[0], INSTALL_SCRIPTS.unix.command);
  assert.ok(linux.querySelector("a[href^='https://dshapp.github.io/en/docs/install-chrome/']"));

  const win = fragment(renderSetupGuide({ issue: NativeHostIssue.MISSING, os: "win" }));
  assert.deepEqual(copiesOf(win), [INSTALL_SCRIPTS.win.command, ...MANUAL]);
  assert.match(win.querySelector(".setup-card-script").textContent, /Command Prompt or PowerShell/);
  assert.ok(win.querySelector(".setup-card-script a[href='https://dshapp.github.io/install/chrome.ps1']"));

  const broken = fragment(renderSetupGuide({ issue: NativeHostIssue.BROKEN, os: "mac", detail: "Native host has exited." }));
  assert.deepEqual([...broken.querySelectorAll(".setup-copy")].map((node) => node.dataset.copy), ["dsh web"]);
  assert.match(broken.querySelector(".setup-detail").textContent, /Native host has exited/);
  setLang("zh");
});

test("the Windows one-liner survives being pasted into cmd or PowerShell", () => {
  const command = INSTALL_SCRIPTS.win.command;
  // PowerShell would expand $vars inside the outer double quotes before the child sees them.
  assert.doesNotMatch(command, /\$/);
  // cmd metacharacters outside quotes would split or redirect the command.
  const outside = command.replace(/"[^"]*"/g, "");
  assert.doesNotMatch(outside, /[&|<>^%]/);
  assert.match(command, /^powershell -NoProfile -ExecutionPolicy Bypass -Command "/);
  assert.match(command, /DownloadData\('https:\/\/dshapp\.github\.io\/install\/chrome\.ps1'\)/);
  assert.match(command, /UTF8\.GetString/);
});

test("mounted guide polls until the host appears, then hands over exactly once", async () => {
  const dom = new JSDOM('<body><div id="g" hidden></div></body>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector("#g");
  const replies = [{ ok: false, reason: NativeHostIssue.MISSING }, { ok: false, reason: "Native host has exited." }, { ok: true }];
  let ready = 0;
  const copied = [];
  const guide = mountSetupGuide(host, {
    os: "mac", intervalMs: 0,
    probe: async () => replies.shift(),
    onReady: () => { ready += 1; },
    copy: async (text) => { copied.push(text); }
  });
  await guide.show(NativeHostIssue.MISSING);
  assert.equal(host.hidden, false);

  host.querySelector(".setup-copy").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(copied, [INSTALL_SCRIPTS.unix.command]);

  assert.equal(await guide.check(), false);
  assert.equal(guide.issue, NativeHostIssue.MISSING);
  assert.equal(await guide.check(), false);
  assert.equal(guide.issue, NativeHostIssue.BROKEN, "copy follows the host's new state");
  assert.equal(await guide.check(), true);
  assert.equal(ready, 1);
  assert.ok(host.querySelector(".setup-status.ok"));
  assert.equal(await guide.check(), false, "no second hand-over after detection");
  assert.equal(ready, 1);
  guide.dispose();
  assert.equal(host.hidden, true);
  dom.window.close();
});

test("polling never folds the manual steps the user opened; only the user does", async () => {
  const dom = new JSDOM('<body><div id="g" hidden></div></body>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector("#g");
  const replies = [
    { ok: false, reason: NativeHostIssue.MISSING },
    { ok: false, reason: NativeHostIssue.MISSING },
    { ok: false, reason: NativeHostIssue.MISSING },
    { ok: false, reason: NativeHostIssue.MISSING }
  ];
  const guide = mountSetupGuide(host, { os: "mac", intervalMs: 0, probe: async () => replies.shift() });
  await guide.show(NativeHostIssue.MISSING);
  const manual = () => host.querySelector("details.setup-manual");
  assert.equal(manual().open, false, "folded by default");

  manual().open = true;
  const before = manual();
  assert.equal(await guide.check({ quiet: true }), false);
  assert.equal(manual(), before, "an unchanged background poll does not re-render");
  assert.equal(manual().open, true);

  assert.equal(await guide.check(), false, "a manual check re-renders");
  assert.notEqual(manual(), before);
  assert.equal(manual().open, true, "and keeps the user's choice");
  guide.relabel();
  assert.equal(manual().open, true, "language switch keeps it too");

  manual().open = false;
  assert.equal(await guide.check(), false);
  assert.equal(manual().open, false, "folding is the user's choice as well");
  guide.dispose();
  dom.window.close();
});

test("fresh install opens the welcome page only when the host is not usable", async () => {
  const opened = [];
  const tabs = { create: async (options) => { opened.push(options.url); } };
  const runtime = { getURL: (path) => "chrome-extension://id/" + path };
  assert.equal(await openWelcomeIfNeeded({ probe: async () => ({ ok: true }), tabs, runtime }), false);
  assert.equal(await openWelcomeIfNeeded({ probe: async () => ({ ok: false, reason: NativeHostIssue.MISSING }), tabs, runtime }), true);
  assert.equal(await openWelcomeIfNeeded({ probe: async () => { throw new Error("x"); }, tabs, runtime }), true);
  assert.deepEqual(opened, ["chrome-extension://id/" + WELCOME_PAGE, "chrome-extension://id/" + WELCOME_PAGE]);
});
