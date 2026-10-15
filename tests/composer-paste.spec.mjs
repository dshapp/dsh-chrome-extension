/**
 * 粘贴 / 拖入:
 * - 文件(Finder 拷贝后 Cmd+V)与拖入一致:进附件条,输入框里不出现文件名;
 * - 文件夹不上传,按绝对路径写进提示词。路径来自 native host 读系统 pasteboard
 *   (粘贴读 general、拖放读 drag),并按名字核对,对不上就提示、不乱插;
 * - 带文字的剪贴板(纯文本 / Excel·Word 混合)保留默认的文字插入。
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
const { partitionDropped, hasText, matchDirectoryPaths, formatFolderPath, insertFolderPaths } = await import("../src/features/attachments/index.js");

const file = (name, type) => ({ name, type, size: 3 });
const fileItem = (f) => ({ kind: "file", type: f.type, getAsFile: () => f, webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: f.name }) });
const dirItem = (name) => ({ kind: "file", type: "", getAsFile: () => ({ name, type: "", size: 224 }), webkitGetAsEntry: () => ({ isFile: false, isDirectory: true, name }) });
const textItem = (type) => ({ kind: "string", type, getAsFile: () => null, webkitGetAsEntry: () => null });

function transfer({ types, items }) {
  const files = items.filter((item) => item.kind === "file").map((item) => item.getAsFile());
  return { types, items, files };
}

/// pasteboard 桩:按 board 返回预设回包,并记下被读了哪块。
function mount({ boards = {} } = {}) {
  const added = [];
  const toasts = [];
  const reads = [];
  const byId = (id) => document.getElementById(id);
  // 每次挂载换一个新的 textarea / file input:上一个用例挂的 paste 监听不能串到这里。
  for (const id of ["input", "file-input"]) {
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
  elements.input.value = "";
  const controls = mountAttachmentControls({
    elements,
    deps: {
      attachments: {
        visible: [],
        onChange() {},
        remove() {},
        async addFile(f) { added.push(f.name); }
      }
    },
    showToast: (message) => toasts.push(message),
    onChange() {},
    root: document.body,
    pasteboardPaths: async (board) => {
      reads.push(board);
      return boards[board] ?? { ok: false, reason: "unknown-cmd" };
    }
  });
  return { elements, added, toasts, reads, destroy: () => controls.destroyDropZone() };
}

function paste(input, data) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  input.dispatchEvent(event);
  return event;
}

function drop(target, data) {
  const event = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: data });
  target.dispatchEvent(event);
  return event;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Finder 拷贝的文件:按顺序加入附件,并吃掉默认的文件名插入", async () => {
  const ctx = mount();
  try {
    const event = paste(ctx.elements.input, transfer({ types: ["Files"], items: [fileItem(file("sample.txt", "text/plain")), fileItem(file("doc.pdf", "application/pdf"))] }));
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(ctx.added, ["sample.txt", "doc.pdf"]);
    assert.deepEqual(ctx.toasts, []);
    assert.deepEqual(ctx.reads, []);
    assert.equal(ctx.elements.input.value, "");
  } finally { ctx.destroy(); }
});

test("Finder 拷贝的图片与文件混合:图片在前,与拖入的顺序规则一致", async () => {
  const ctx = mount();
  try {
    const event = paste(ctx.elements.input, transfer({ types: ["Files"], items: [fileItem(file("a.pdf", "application/pdf")), fileItem(file("b.png", "image/png"))] }));
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(ctx.added, ["b.png", "a.pdf"]);
  } finally { ctx.destroy(); }
});

test("纯文本粘贴:不拦截,不加附件", async () => {
  const ctx = mount();
  try {
    const event = paste(ctx.elements.input, transfer({ types: ["text/plain"], items: [textItem("text/plain")] }));
    await flush();
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(ctx.added, []);
  } finally { ctx.destroy(); }
});

test("文字 + 图片(Excel/Word):保留文字的默认插入,图片照常加入", async () => {
  const ctx = mount();
  try {
    const event = paste(ctx.elements.input, transfer({
      types: ["text/plain", "text/html", "Files"],
      items: [textItem("text/plain"), textItem("text/html"), fileItem(file("image.png", "image/png"))]
    }));
    await flush();
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(ctx.added, ["image.png"]);
  } finally { ctx.destroy(); }
});

test("粘贴文件夹:读剪贴板拿绝对路径,插在光标处,不上传", async () => {
  const ctx = mount({ boards: { general: { ok: true, paths: ["/Users/me/proj"] } } });
  try {
    const input = ctx.elements.input;
    input.value = "看看这个目录";
    input.setSelectionRange(2, 2);
    let inputs = 0;
    input.addEventListener("input", () => { inputs += 1; }, { once: true });
    const event = paste(input, transfer({ types: ["Files"], items: [dirItem("proj")] }));
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(ctx.reads, ["general"]);
    assert.deepEqual(ctx.added, []);
    assert.deepEqual(ctx.toasts, []);
    assert.equal(input.value, "看看 /Users/me/proj 这个目录");
    assert.equal(input.selectionStart, "看看 /Users/me/proj ".length);
    assert.equal(inputs, 1);
  } finally { ctx.destroy(); }
});

test("文件夹 + 文件:文件上传,文件夹写路径;含空格的路径加引号", async () => {
  const ctx = mount({ boards: { general: { ok: true, paths: ["/tmp/x.txt", "/Users/me/My Docs"] } } });
  try {
    paste(ctx.elements.input, transfer({ types: ["Files"], items: [dirItem("My Docs"), fileItem(file("x.txt", "text/plain"))] }));
    await flush();
    assert.deepEqual(ctx.added, ["x.txt"]);
    assert.equal(ctx.elements.input.value, '"/Users/me/My Docs" ');
  } finally { ctx.destroy(); }
});

test("pasteboard 上的路径与文件夹名对不上:不乱插,提示拿不到路径", async () => {
  const ctx = mount({ boards: { general: { ok: true, paths: ["/Users/me/other"] } } });
  try {
    paste(ctx.elements.input, transfer({ types: ["Files"], items: [dirItem("proj")] }));
    await flush();
    assert.equal(ctx.elements.input.value, "");
    assert.equal(ctx.toasts.length, 1);
    assert.match(ctx.toasts[0], /proj/);
  } finally { ctx.destroy(); }
});

test("旧版 native host(unknown-cmd):提示更新插件,不插任何文字", async () => {
  const ctx = mount();
  try {
    paste(ctx.elements.input, transfer({ types: ["Files"], items: [dirItem("proj")] }));
    await flush();
    assert.equal(ctx.elements.input.value, "");
    assert.equal(ctx.toasts.length, 1);
    assert.match(ctx.toasts[0], /dsh-chrome-control/);
  } finally { ctx.destroy(); }
});

test("拖入文件夹:读拖拽板,输入框没焦点时接在草稿末尾", async () => {
  const ctx = mount({ boards: { drag: { ok: true, paths: ["/Users/me/a", "/Users/me/b"] } } });
  try {
    const input = ctx.elements.input;
    input.value = "比较";
    input.blur();
    const event = drop(document.body, transfer({ types: ["Files"], items: [dirItem("a"), dirItem("b")] }));
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(ctx.reads, ["drag"]);
    assert.equal(input.value, "比较 /Users/me/a /Users/me/b ");
  } finally { ctx.destroy(); }
});

test("partitionDropped:目录按名字单独列出;取不到文件的条目记为 opaque;没有 items 时退回 files", () => {
  const png = file("p.png", "image/png");
  const doc = file("d.pdf", "application/pdf");
  const mixed = partitionDropped({ items: [dirItem("dir"), fileItem(png), fileItem(doc), textItem("text/plain")] });
  assert.deepEqual(mixed.images.map((f) => f.name), ["p.png"]);
  assert.deepEqual(mixed.others.map((f) => f.name), ["d.pdf"]);
  assert.deepEqual(mixed.directories, ["dir"]);
  assert.equal(mixed.opaque, false);

  const unreadable = partitionDropped({ items: [{ kind: "file", getAsFile: () => null }], files: [] });
  assert.deepEqual([unreadable.images.length, unreadable.others.length, unreadable.directories.length, unreadable.opaque], [0, 0, 0, true]);

  const legacy = partitionDropped({ files: [png, doc] });
  assert.deepEqual([legacy.images.length, legacy.others.length, legacy.opaque], [1, 1, false]);
});

test("matchDirectoryPaths:按名字配对、同名各取一次、忽略相对路径", () => {
  assert.deepEqual(
    matchDirectoryPaths(["src", "src", "x"], ["/a/src/", "relative/x", "/b/src", "/c/y"]),
    { matched: ["/a/src", "/b/src"], missing: ["x"] }
  );
});

test("formatFolderPath / insertFolderPaths:空白加引号,前后按需补空格", () => {
  assert.equal(formatFolderPath("/a/b"), "/a/b");
  assert.equal(formatFolderPath("/a/b c"), '"/a/b c"');
  assert.deepEqual(insertFolderPaths("", 0, 0, ["/a"]), { text: "/a ", caret: 3 });
  assert.deepEqual(insertFolderPaths("x y", 1, 1, ["/a"]), { text: "x /a y", caret: 4 });
  assert.deepEqual(insertFolderPaths("x", 99, 99, ["/a", "/b"]), { text: "x /a /b ", caret: 8 });
  assert.deepEqual(insertFolderPaths("abc", 1, 2, ["/a"]), { text: "a /a c", caret: 5 });
});

test("hasText:只认文字类 type", () => {
  assert.equal(hasText({ types: ["Files"] }), false);
  assert.equal(hasText({ types: ["Files", "text/plain"] }), true);
  assert.equal(hasText({ types: ["text/html"] }), true);
  assert.equal(hasText(null), false);
});
