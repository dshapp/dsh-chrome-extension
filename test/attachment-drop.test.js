// @vitest-environment jsdom
// 侧栏拖放:把图片拖进来即加进附件区。
//
// jsdom 不实现 DataTransfer,也不实现 DragEvent 的 dataTransfer 初始化,
// 所以这里手搓一个桩挂到普通 Event 上 —— 被测代码只读 types/files/items/dropEffect。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountDropZone, hasFiles, partitionDropped } from "../src/features/attachments/drop-zone.js";

/// 造一个 DataTransfer 桩。types 默认按有没有文件推断。
function dt({ files = [], items = null, types = null } = {}) {
  return {
    types: types ?? (files.length || items ? ["Files"] : []),
    files,
    items: items ?? files.map((f) => ({ kind: "file", type: f.type })),
    dropEffect: ""
  };
}

const img = (name = "a.png") => new File(["x"], name, { type: "image/png" });
const pdf = (name = "a.pdf") => new File(["x"], name, { type: "application/pdf" });

/// 派发一个带 dataTransfer 的拖拽事件,返回该事件(便于断言 defaultPrevented)。
function fire(target, type, dataTransfer) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}

let root;
let overlay;
let onFiles;
let onRejected;
let zone;

function mount({ isEnabled } = {}) {
  zone = mountDropZone(root, { overlay, onFiles, onRejected, ...(isEnabled ? { isEnabled } : {}) });
  return zone;
}

beforeEach(() => {
  document.body.innerHTML = `<div id="root"><div id="child">x</div></div><div id="ov" hidden></div>`;
  root = document.getElementById("root");
  overlay = document.getElementById("ov");
  onFiles = vi.fn();
  onRejected = vi.fn();
  zone?.destroy?.();
  zone = null;
});

describe("hasFiles", () => {
  it("只认 Files,不认拖进来的文字", () => {
    expect(hasFiles(dt({ files: [img()] }))).toBe(true);
    expect(hasFiles({ types: ["text/plain"] })).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });

  it("DOMStringList 那种类数组也能认", () => {
    // 真实浏览器给的是 DOMStringList,没有 Array.prototype.includes。
    const listLike = { length: 1, 0: "Files", [Symbol.iterator]: function* () { yield "Files"; } };
    expect(hasFiles({ types: listLike })).toBe(true);
  });
});

describe("partitionDropped", () => {
  it("按 MIME 把图片和其余分开", () => {
    const { images, others } = partitionDropped(dt({ files: [img(), pdf()] }));
    expect(images.map((f) => f.name)).toEqual(["a.png"]);
    expect(others.map((f) => f.name)).toEqual(["a.pdf"]);
  });

  it("文件夹:files 为空但 items 里有 file,标记成 opaque", () => {
    const { images, others, opaque } = partitionDropped(dt({ files: [], items: [{ kind: "file", type: "" }] }));
    expect(images).toEqual([]);
    expect(others).toEqual([]);
    expect(opaque).toBe(true);
  });
});

describe("覆盖层的显隐", () => {
  it("dragenter 显示,配平的 dragleave 隐藏", () => {
    mount();
    fire(root, "dragenter", dt({ files: [img()] }));
    expect(overlay.hidden).toBe(false);
    fire(root, "dragleave", dt({ files: [img()] }));
    expect(overlay.hidden).toBe(true);
  });

  it("掠过子元素时不闪 —— enter/leave 交错要靠计数器配平", () => {
    mount();
    const child = document.getElementById("child");
    fire(root, "dragenter", dt({ files: [img()] }));      // 进根:depth 1
    fire(child, "dragenter", dt({ files: [img()] }));     // 进子:depth 2
    fire(root, "dragleave", dt({ files: [img()] }));      // 离根(冒泡自子):depth 1
    // 还在侧栏里,覆盖层必须仍然亮着。
    expect(overlay.hidden).toBe(false);
    fire(root, "dragleave", dt({ files: [img()] }));      // depth 0
    expect(overlay.hidden).toBe(true);
  });

  it("拖文字进来完全不响应", () => {
    mount();
    fire(root, "dragenter", { types: ["text/plain"], files: [], items: [] });
    expect(overlay.hidden).toBe(true);
  });

  it("Esc 关掉覆盖层", () => {
    mount();
    fire(root, "dragenter", dt({ files: [img()] }));
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlay.hidden).toBe(true);
  });

  it("drop 之后一定收起", () => {
    mount();
    fire(root, "dragenter", dt({ files: [img()] }));
    fire(root, "drop", dt({ files: [img()] }));
    expect(overlay.hidden).toBe(true);
  });
});

describe("drop 的分流", () => {
  it("图片交给 onFiles", () => {
    mount();
    fire(root, "drop", dt({ files: [img("a.png"), img("b.png")] }));
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("非图片只提示,不进附件", () => {
    mount();
    fire(root, "drop", dt({ files: [pdf()] }));
    expect(onFiles).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("混着拖:图片照收,同时提示一次", () => {
    mount();
    fire(root, "drop", dt({ files: [img(), pdf(), pdf("b.pdf")] }));
    expect(onFiles.mock.calls[0][0].map((f) => f.name)).toEqual(["a.png"]);
    // 拖 10 个 pdf 不该刷 10 条 toast。
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("文件夹:提示一次", () => {
    mount();
    fire(root, "drop", dt({ files: [], items: [{ kind: "file", type: "" }] }));
    expect(onFiles).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("isEnabled 为 false 时不收,也不亮覆盖层", () => {
    mount({ isEnabled: () => false });
    fire(root, "dragenter", dt({ files: [img()] }));
    expect(overlay.hidden).toBe(true);
    fire(root, "drop", dt({ files: [img()] }));
    expect(onFiles).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });
});

describe("不能让浏览器把侧栏替换成那个文件", () => {
  it("dragover 与 drop 都吃掉默认行为", () => {
    mount();
    const over = fire(root, "dragover", dt({ files: [img()] }));
    expect(over.defaultPrevented).toBe(true);
    const drop = fire(root, "drop", dt({ files: [img()] }));
    expect(drop.defaultPrevented).toBe(true);
  });

  it("落在响应区外(直接丢给 window)也照样吃掉", () => {
    mount();
    const outside = fire(window, "drop", dt({ files: [img()] }));
    expect(outside.defaultPrevented).toBe(true);
  });

  it("dragover 把 dropEffect 设成 copy,光标显示 +", () => {
    mount();
    const transfer = dt({ files: [img()] });
    fire(root, "dragover", transfer);
    expect(transfer.dropEffect).toBe("copy");
  });
});

describe("destroy", () => {
  it("解绑之后不再响应", () => {
    const handle = mount();
    handle.destroy();
    fire(root, "drop", dt({ files: [img()] }));
    expect(onFiles).not.toHaveBeenCalled();
    expect(overlay.hidden).toBe(true);
  });
});
