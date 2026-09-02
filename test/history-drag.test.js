// @vitest-environment jsdom
// 行拖拽。重点验两件容易出错的事:
// 1. 事件不能冒到 window —— attachments/drop-zone.js 在那里等着接拖入的图片,
//    冒上去会让整个侧栏亮起"松手添加图片"的覆盖层。
// 2. 状态排序档下必须完全不可拖。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountHistoryDrag } from "../src/features/sessions/history-drag.js";

function setup({ enabled = true } = {}) {
  document.body.innerHTML = `<ul id="list">
    <li class="history-item" data-session-id="a"></li>
    <li class="history-item" data-session-id="b"></li>
    <li class="history-item" data-session-id="c"></li>
  </ul>`;
  const list = document.querySelector("#list");
  for (const row of list.querySelectorAll(".history-item")) {
    // jsdom 不做布局,所有矩形都是 0 —— 手动给一个,好判定上下半区。
    const index = [...list.children].indexOf(row);
    row.getBoundingClientRect = () => ({ top: index * 20, height: 20, bottom: index * 20 + 20 });
  }
  const onDrop = vi.fn();
  mountHistoryDrag(list, {
    enabled: () => enabled,
    visibleIds: () => ["a", "b", "c"],
    onDrop
  });
  return { list, onDrop };
}

function fire(target, type, { clientY = 0 } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.clientY = clientY;
  event.dataTransfer = { setData: vi.fn(), types: [] };
  target.dispatchEvent(event);
  return event;
}

const rowOf = (list, id) => list.querySelector(`[data-session-id="${id}"]`);

describe("历史行拖拽", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("拖到目标行上半区 → 插到它前面", () => {
    const { list, onDrop } = setup();
    fire(rowOf(list, "c"), "dragstart");
    fire(rowOf(list, "a"), "dragover", { clientY: 2 });
    fire(rowOf(list, "a"), "drop", { clientY: 2 });
    expect(onDrop).toHaveBeenCalledWith("c", "a", false);
  });

  it("拖到目标行下半区 → 插到它后面", () => {
    const { list, onDrop } = setup();
    fire(rowOf(list, "a"), "dragstart");
    fire(rowOf(list, "b"), "drop", { clientY: 38 });
    expect(onDrop).toHaveBeenCalledWith("a", "b", true);
  });

  it("dragover 与 drop 都不冒泡到 window(否则图片落区会亮起)", () => {
    const { list } = setup();
    const onWindowDragOver = vi.fn();
    const onWindowDrop = vi.fn();
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    fire(rowOf(list, "a"), "dragstart");
    fire(rowOf(list, "b"), "dragover", { clientY: 22 });
    fire(rowOf(list, "b"), "drop", { clientY: 22 });
    expect(onWindowDragOver).not.toHaveBeenCalled();
    expect(onWindowDrop).not.toHaveBeenCalled();
    window.removeEventListener("dragover", onWindowDragOver);
    window.removeEventListener("drop", onWindowDrop);
  });

  it("dragover 调用 preventDefault,否则浏览器不认这是可落点", () => {
    const { list } = setup();
    fire(rowOf(list, "a"), "dragstart");
    const event = fire(rowOf(list, "b"), "dragover", { clientY: 22 });
    expect(event.defaultPrevented).toBe(true);
  });

  it("状态排序档下完全不可拖", () => {
    const { list, onDrop } = setup({ enabled: false });
    fire(rowOf(list, "a"), "dragstart");
    fire(rowOf(list, "b"), "drop", { clientY: 38 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("拖到自己身上不上报", () => {
    const { list, onDrop } = setup();
    fire(rowOf(list, "a"), "dragstart");
    fire(rowOf(list, "a"), "drop", { clientY: 2 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("拖动中给行加 dragging 类,结束后清掉", () => {
    const { list } = setup();
    fire(rowOf(list, "a"), "dragstart");
    expect(rowOf(list, "a").classList.contains("dragging")).toBe(true);
    fire(rowOf(list, "a"), "dragend");
    expect(rowOf(list, "a").classList.contains("dragging")).toBe(false);
  });

  it("落点提示画在正确的一侧", () => {
    const { list } = setup();
    fire(rowOf(list, "a"), "dragstart");
    fire(rowOf(list, "b"), "dragover", { clientY: 22 });
    expect(rowOf(list, "b").classList.contains("drop-before")).toBe(true);
    fire(rowOf(list, "b"), "dragover", { clientY: 38 });
    expect(rowOf(list, "b").classList.contains("drop-after")).toBe(true);
  });

  it("没先 dragstart 的 drop 被忽略(例如从别处拖来的文件)", () => {
    const { list, onDrop } = setup();
    fire(rowOf(list, "b"), "drop", { clientY: 22 });
    expect(onDrop).not.toHaveBeenCalled();
  });
});
