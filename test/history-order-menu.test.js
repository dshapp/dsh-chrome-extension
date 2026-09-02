// @vitest-environment jsdom
// 排序下拉:住在搜索行右端,点开选一项。
// 老版本是三颗并排的药丸,挤在同一行里会把搜索框压没 —— 换成下拉后
// 这几条断言钉住的是"它确实是个下拉、确实在搜索框右边、确实能切档"。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountHistoryOrdering } from "../src/app/sidepanel/history-ordering.js";

function setup() {
  document.body.innerHTML = `
    <div id="history-popover" class="open">
      <div id="history-search-wrap">
        <button id="hdr-workspace"></button>
        <input id="history-search" />
      </div>
      <ul id="history-list-inner"></ul>
    </div>`;
  const rerender = vi.fn();
  const ordering = mountHistoryOrdering({
    popover: document.querySelector("#history-popover"),
    list: document.querySelector("#history-list-inner"),
    orderStore: null,
    workspaceId: () => null,
    workspaces: null,
    visibleRows: () => [],
    fullRows: () => [],
    rerender
  });
  return { ordering, rerender };
}

const trigger = () => document.querySelector("#history-order-btn");
const menu = () => document.querySelector("#history-order-menu");
const items = () => [...menu().querySelectorAll("[data-item-id]")];

describe("排序下拉", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("触发钮渲染在搜索行内,且排在搜索框之后(视觉上的右边)", () => {
    setup();
    const wrap = document.querySelector("#history-search-wrap");
    expect(wrap.contains(trigger())).toBe(true);
    const kids = [...wrap.children];
    expect(kids.indexOf(trigger())).toBeGreaterThan(kids.indexOf(document.querySelector("#history-search")));
  });

  it("是下拉而不是并排药丸:只有一颗按钮 + 一个 popover 菜单", () => {
    setup();
    expect(document.querySelectorAll("#history-search-wrap button[data-order]").length).toBe(0);
    expect(trigger().getAttribute("popovertarget")).toBe("history-order-menu");
    expect(menu().getAttribute("popover")).toBe("auto");
  });

  it("菜单列出三种排序,默认选中「最近」", () => {
    setup();
    expect(items().map((i) => i.dataset.itemId)).toEqual(["updated", "manual", "status"]);
    expect(menu().querySelector(".selected")?.dataset.itemId).toBe("updated");
  });

  it("触发钮上显示当前档位的名字", () => {
    const { ordering } = setup();
    expect(document.querySelector("#history-order-label").textContent).toBe("最近");
    items().find((i) => i.dataset.itemId === "status").click();
    expect(document.querySelector("#history-order-label").textContent).toBe("状态");
    expect(ordering.orderBy()).toBe("status");
  });

  it("选一项会切档并请求重画(高亮回第一行)", () => {
    const { ordering, rerender } = setup();
    items().find((i) => i.dataset.itemId === "manual").click();
    expect(ordering.orderBy()).toBe("manual");
    expect(rerender).toHaveBeenCalledWith({ resetSelection: true });
  });

  it("选中已经是当前档的那项不触发重画", () => {
    const { rerender } = setup();
    items().find((i) => i.dataset.itemId === "updated").click();
    expect(rerender).not.toHaveBeenCalled();
  });

  it("状态档禁用拖拽,其余档可拖", () => {
    const { ordering } = setup();
    expect(ordering.isDraggable()).toBe(true);
    items().find((i) => i.dataset.itemId === "status").click();
    expect(ordering.isDraggable()).toBe(false);
    items().find((i) => i.dataset.itemId === "manual").click();
    expect(ordering.isDraggable()).toBe(true);
  });

  it("选完后菜单收起", () => {
    setup();
    const hide = vi.fn();
    menu().hidePopover = hide;
    items().find((i) => i.dataset.itemId === "manual").click();
    expect(hide).toHaveBeenCalled();
  });
});
