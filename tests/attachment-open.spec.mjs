/**
 * 点开输入框顶部的附件胶囊:
 * - 图片胶囊进查看器(同一输入框里的几张图成组);
 * - 文件胶囊:有真实路径(拖入 / 从访达粘贴时读 pasteboard 拿到)交宿主用默认应用打开,
 *   路径失效或没有路径时退回新标签页里打开浏览器手上的字节;显示不了的下载副本;
 * - 移除 / 重试小按钮不触发打开。
 *
 * 跑法:node --test 'tests/*.spec.mjs'
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`<!doctype html><html><body>
  <textarea id="input"></textarea>
  <input id="file-input" type="file">
  <div id="preview-strip"></div>
  <div id="drop-overlay" hidden><span id="drop-hint"></span></div>
</body></html>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;

const { mountAttachmentControls } = await import("../src/app/sidepanel/composer-attachments.js");
const {
  createAttachmentTray, renderAttachmentTray, browserViewType, looksLikeText, createAttachmentOpener, pairPathsByName
} = await import("../src/features/attachments/index.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const bytes = (...values) => new Uint8Array(values);

function fileItem(f) {
  return { kind: "file", type: f.type, getAsFile: () => f, webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: f.name }) };
}

function drop(target, items) {
  const event = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], items, files: items.map((i) => i.getAsFile()) } });
  target.dispatchEvent(event);
}

function mount({ boards = {}, openPath, uploadFile } = {}) {
  const byId = (id) => document.getElementById(id);
  for (const id of ["input", "file-input", "preview-strip"]) {
    const old = byId(id);
    old.replaceWith(old.cloneNode(false));
  }
  const elements = {
    input: byId("input"),
    fileInput: byId("file-input"),
    previewStrip: byId("preview-strip"),
    dropOverlay: byId("drop-overlay"),
    dropOverlayHint: byId("drop-hint")
  };
  const calls = { reads: [], opened: [], tabs: [], downloads: [], viewed: [], toasts: [] };
  const attachments = createAttachmentTray({ uploadFile: uploadFile ?? (async () => ({ receiptId: "r1" })) });
  const controls = mountAttachmentControls({
    elements,
    deps: { attachments },
    showToast: (message) => calls.toasts.push(message),
    onChange() {},
    root: document.body,
    pasteboardPaths: async (board) => { calls.reads.push(board); return boards[board] ?? { ok: false, reason: "unknown-cmd" }; },
    openPath: openPath ?? (async (path) => { calls.opened.push(path); }),
    opener: createAttachmentOpener({
      openUrl: (url) => calls.tabs.push(url),
      download: (url, name) => calls.downloads.push(name)
    }),
    viewImages: (images, index) => calls.viewed.push({ count: images.length, index })
  });
  return { elements, attachments, calls, destroy: () => { controls.destroyDropZone(); attachments.clear(); } };
}

const chip = (ctx, index) => ctx.elements.previewStrip.querySelector(`.attachment-chip[data-open="${index}"]`);

test("拖入文件:读拖拽板拿到真实路径,点胶囊交宿主用默认应用打开", async () => {
  const ctx = mount({ boards: { drag: { ok: true, paths: ["/Users/me/报告.docx", "/tmp/other.txt"] } } });
  try {
    drop(document.body, [fileItem(new File(["x"], "报告.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }))]);
    await flush(); await flush();
    assert.deepEqual(ctx.calls.reads, ["drag"]);
    assert.equal(ctx.attachments.visible[0].path, "/Users/me/报告.docx");
    chip(ctx, 0).querySelector(".attachment-open").click();
    await flush();
    assert.deepEqual(ctx.calls.opened, ["/Users/me/报告.docx"]);
    assert.deepEqual(ctx.calls.tabs, []);
  } finally { ctx.destroy(); }
});

test("文件选择器选的文件没有路径:点开在新标签页显示(文本按纯文本)", async () => {
  const ctx = mount();
  try {
    await ctx.attachments.addFile(new File(["console.log(1)\n"], "a.ts", { type: "video/mp2t" }));
    chip(ctx, 0).click();
    await flush(); await flush();
    assert.deepEqual(ctx.calls.opened, []);
    assert.equal(ctx.calls.tabs.length, 1);
    assert.match(ctx.calls.tabs[0], /^blob:/);
    // 同一个文件再点一次复用同一条 URL;移走后回收。
    chip(ctx, 0).click();
    await flush(); await flush();
    assert.equal(ctx.calls.tabs[1], ctx.calls.tabs[0]);
  } finally { ctx.destroy(); }
});

test("路径失效(宿主打开失败):退回浏览器内打开", async () => {
  const ctx = mount({
    boards: { drag: { ok: true, paths: ["/gone/doc.pdf"] } },
    openPath: async () => { throw new Error("ENOENT"); }
  });
  try {
    drop(document.body, [fileItem(new File(["%PDF-1.4"], "doc.pdf", { type: "application/pdf" }))]);
    await flush(); await flush();
    chip(ctx, 0).click();
    await flush(); await flush();
    assert.equal(ctx.calls.tabs.length, 1);
    assert.deepEqual(ctx.calls.toasts, []);
  } finally { ctx.destroy(); }
});

test("浏览器显示不了的二进制且没有路径:下载副本并提示", async () => {
  const ctx = mount();
  try {
    await ctx.attachments.addFile(new File([bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 1)], "a.zip", { type: "application/zip" }));
    chip(ctx, 0).click();
    await flush(); await flush();
    assert.deepEqual(ctx.calls.tabs, []);
    assert.deepEqual(ctx.calls.downloads, ["a.zip"]);
    assert.equal(ctx.calls.toasts.length, 1);
    assert.match(ctx.calls.toasts[0], /a\.zip/);
  } finally { ctx.destroy(); }
});

test("移除 / 重试按钮不触发打开", async () => {
  let fail = true;
  const ctx = mount({ uploadFile: async () => { if (fail) throw new Error("boom"); return { receiptId: "r" }; } });
  try {
    await ctx.attachments.addFile(new File(["x"], "a.txt", { type: "text/plain" })).catch(() => {});
    assert.equal(ctx.attachments.visible[0].upload, "failed");
    fail = false;
    chip(ctx, 0).querySelector("button[data-retry]").click();
    await flush(); await flush();
    chip(ctx, 0).querySelector("button[data-index]").click();
    await flush();
    assert.equal(ctx.attachments.visible.length, 0);
    assert.deepEqual([ctx.calls.tabs.length, ctx.calls.opened.length], [0, 0]);
  } finally { ctx.destroy(); }
});

test("图片胶囊:点开进查看器,输入框里的几张图成组", async () => {
  const ctx = mount();
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = () => "blob:preview";   // jsdom 的 <img> 需要一个 src
  try {
    await ctx.attachments.addFile(new File(["a"], "a.png", { type: "image/png" }));
    await ctx.attachments.addFile(new File(["b"], "b.png", { type: "image/png" }));
    assert.match(chip(ctx, 1).querySelector(".attachment-open").getAttribute("aria-label"), /b\.png/);
    chip(ctx, 1).querySelector("img").click();
    await flush();
    assert.deepEqual(ctx.calls.viewed, [{ count: 2, index: 1 }]);
    assert.deepEqual(ctx.calls.reads, []);
  } finally { URL.createObjectURL = realCreate; ctx.destroy(); }
});

test("setPath 可早于文件入列(逐个上传时 pasteboard 回包先到)", async () => {
  const tray = createAttachmentTray({ uploadFile: async () => ({ receiptId: "r" }) });
  const f = new File(["x"], "late.txt", { type: "text/plain" });
  assert.equal(tray.setPath(f, "/a/late.txt"), true);
  await tray.addFile(f);
  assert.equal(tray.visible[0].path, "/a/late.txt");
  assert.equal(tray.setPath(f, ""), false);
});

test("renderAttachmentTray:文件名进打开按钮并转义", () => {
  const container = document.createElement("div");
  const opened = [];
  renderAttachmentTray(container, [{ kind: "file", name: '<b>"x"</b>.txt', upload: "ready" }], { onOpen: (i) => opened.push(i) });
  const button = container.querySelector(".attachment-open");
  assert.equal(button.textContent, '<b>"x"</b>.txt');
  assert.equal(container.querySelector("b"), null);
  button.click();
  assert.deepEqual(opened, [0]);
});

test("browserViewType:PDF/位图原样,文本(含被标成 video/mp2t 的 .ts、HTML、SVG)按纯文本,二进制为 null", async () => {
  assert.equal(await browserViewType(new File(["%PDF"], "a.pdf", { type: "application/pdf" })), "application/pdf");
  assert.equal(await browserViewType(new File(["x"], "a.png", { type: "image/png" })), "image/png");
  assert.equal(await browserViewType(new File(["let a = 1"], "a.ts", { type: "video/mp2t" })), "text/plain;charset=utf-8");
  assert.equal(await browserViewType(new File(["<script>alert(1)</script>"], "a.html", { type: "text/html" })), "text/plain;charset=utf-8");
  assert.equal(await browserViewType(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })), "text/plain;charset=utf-8");
  assert.equal(await browserViewType(new File([bytes(0, 1, 2)], "a.mp4", { type: "video/mp4" })), "video/mp4");
  assert.equal(await browserViewType(new File([bytes(0x50, 0x4b, 0)], "a.docx", { type: "" })), null);
  assert.equal(await looksLikeText(new File([bytes(0xff, 0xfe, 0x41)], "bad.txt")), false);
  assert.equal(await looksLikeText(new File(["中文"], "zh.md")), true);
});

test("pairPathsByName:与名字逐项对齐,配不上为 null", () => {
  assert.deepEqual(pairPathsByName(["a.txt", "b.txt", "a.txt"], ["/x/a.txt", "/y/a.txt", "rel/b.txt"]), ["/x/a.txt", null, "/y/a.txt"]);
});
