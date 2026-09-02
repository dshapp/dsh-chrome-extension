// @vitest-environment jsdom
// 历史浮层:行内操作图标(Lucide SVG)+ 上下键导航。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { mountHistoryDrawer } from "../src/app/sidepanel/sidepanel-overlays.js";

const SESSIONS = [
  { sessionId: "s1", cwd: "/w", updatedAt: 3, projections: { values: { title: "第一个" } } },
  { sessionId: "s2", cwd: "/w", updatedAt: 2, projections: { values: { title: "第二个" } } },
  { sessionId: "s3", cwd: "/w", updatedAt: 1, projections: { values: { title: "第三个" } } }
];

function setup({ sessions = SESSIONS } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <button id="hdr-title-wrap"></button><span id="hdr-title"></span>
    <div id="history-popover"><input id="history-search" />
    <ul id="history-list-inner"></ul></div>
    <div id="workspace-menu"></div></body></html>`);
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.prompt = () => null;
  globalThis.alert = () => {};
  const doc = dom.window.document;
  // jsdom 没实现 scrollIntoView。
  dom.window.Element.prototype.scrollIntoView = function () {};
  const openSession = vi.fn();
  const deps = {
    sessions: {
      refreshList: vi.fn(async () => sessions),
      fork: vi.fn(async () => "forked"),
      rename: vi.fn(),
      archive: vi.fn(),
      search: vi.fn(async () => null)
    },
    formatErrorDetails: (e) => String(e)
  };
  const drawer = mountHistoryDrawer(deps, openSession, vi.fn(), null, { workspacePath: () => null });
  return { drawer, doc, openSession, deps, dom };
}

const rows = (doc) => [...doc.querySelectorAll(".history-item")];
const selectedTitles = (doc) =>
  rows(doc).filter((r) => r.classList.contains("selected")).map((r) => r.querySelector(".h-title").textContent);

function press(doc, key) {
  const event = new doc.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  doc.querySelector("#history-search").dispatchEvent(event);
  return event;
}

describe("历史行内操作图标", () => {
  beforeEach(() => vi.clearAllMocks());

  it("三个操作都渲染成 SVG,而不是 Unicode 字形", async () => {
    const { drawer, doc } = setup();
    await drawer.refresh();
    for (const action of ["fork", "rename", "archive"]) {
      const button = doc.querySelector(`button[data-action="${action}"]`);
      expect(button, action).toBeTruthy();
      expect(button.querySelector("svg"), action).toBeTruthy();
      // 旧实现是 ⑂ / ✎ / 🗄 这类字形,换图标后按钮里不该再有文字。
      expect(button.textContent.trim()).toBe("");
    }
  });

  it("图标用 Lucide 的 24×24 网格与描边风格", async () => {
    const { drawer, doc } = setup();
    await drawer.refresh();
    for (const svg of doc.querySelectorAll(".h-actions svg")) {
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("fill")).toBe("none");
    }
  });

  it("按钮带 aria-label 且不会误触发表单提交", async () => {
    const { drawer, doc } = setup();
    await drawer.refresh();
    for (const button of doc.querySelectorAll(".h-actions button")) {
      expect(button.getAttribute("aria-label")).toBeTruthy();
      expect(button.getAttribute("type")).toBe("button");
    }
  });
});

describe("点击工作目录菜单不关闭历史浮层", () => {
  beforeEach(() => vi.clearAllMocks());

  it("菜单项在冒泡中被 renderMenu 重建(摘掉 target)后,历史浮层仍保持打开", () => {
    const { drawer, doc, dom } = setup();
    drawer.show();
    const popover = doc.querySelector("#history-popover");
    expect(popover.classList.contains("open")).toBe(true);

    const menu = doc.querySelector("#workspace-menu");
    const button = doc.createElement("button");
    button.type = "button";
    menu.appendChild(button);

    // 模拟 handleSelect → renderMenu:点击菜单项后重建 innerHTML,
    // 被点击的 button 在冒泡到 document 前就从 DOM 里摘掉了。
    menu.addEventListener("click", () => { menu.innerHTML = ""; });

    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    // contains(event.target) 对已 disconnect 的 target 返回 false,会把浮层误关;
    // 修复后改用 event.composedPath() 判断(事件产生时固定的传播路径),浮层应保持打开。
    expect(popover.classList.contains("open")).toBe(true);
  });
});

describe("历史列表上下键导航", () => {
  beforeEach(() => vi.clearAllMocks());

  it("打开浮层即默认高亮第一行", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    expect(selectedTitles(doc)).toEqual(["第一个"]);
  });

  it("↓ 从默认的第一行继续下移", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第二个"]);
    press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第三个"]);
  });

  it("在第一行按 ↑ 绕到最后一行", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "ArrowUp");
    expect(selectedTitles(doc)).toEqual(["第三个"]);
  });

  it("到底再按 ↓ 回到开头(两端循环)", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    for (let i = 0; i < 2; i++) press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第三个"]);
    press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第一个"]);
  });

  it("回车打开高亮的那个会话", async () => {
    const { drawer, doc, openSession } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "ArrowDown");
    press(doc, "Enter");
    expect(openSession).toHaveBeenCalledWith("s2");
  });

  it("不按方向键,打开浮层直接回车就开第一条", async () => {
    const { drawer, doc, openSession } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "Enter");
    expect(openSession).toHaveBeenCalledWith("s1");
  });

  it("输入法组字确认候选的 Enter 不打开会话", async () => {
    const { drawer, openSession } = setup();
    drawer.show();
    await drawer.refresh();
    const prevented = vi.fn();
    // isComposing 的 Enter 是选字确认,不是操作列表:应被忽略,不默认打开第一条。
    const handled = drawer.handleKeyDown({ key: "Enter", isComposing: true, preventDefault: prevented });
    expect(handled).toBe(false);
    expect(prevented).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it("空列表时回车不打开任何会话", async () => {
    const { drawer, doc, openSession } = setup({ sessions: [] });
    drawer.show();
    await drawer.refresh();
    const event = press(doc, "Enter");
    expect(openSession).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);   // 交还默认行为
  });

  it("Esc 关闭浮层", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "Escape");
    expect(doc.querySelector("#history-popover").classList.contains("open")).toBe(false);
  });

  it("浮层关闭时不消费方向键,也不移动高亮", async () => {
    const { drawer, doc } = setup();
    await drawer.refresh();   // 未 show()
    const before = selectedTitles(doc);
    const event = press(doc, "ArrowDown");
    expect(event.defaultPrevented).toBe(false);
    expect(selectedTitles(doc)).toEqual(before);   // 按键被忽略
  });

  it("空列表时方向键不报错也不选中", async () => {
    const { drawer, doc } = setup({ sessions: [] });
    drawer.show();
    await drawer.refresh();
    expect(() => press(doc, "ArrowDown")).not.toThrow();
    expect(selectedTitles(doc)).toEqual([]);
  });

  it("重开浮层把高亮复位到第一行", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第二个"]);
    drawer.hide();
    drawer.show();
    await drawer.refresh();
    expect(selectedTitles(doc)).toEqual(["第一个"]);
  });

  it("搜索后直接回车,打开过滤结果的第一条", async () => {
    const { drawer, doc, openSession } = setup();
    drawer.show();
    await drawer.refresh();
    const search = doc.querySelector("#history-search");
    search.value = "第三";
    search.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(selectedTitles(doc)).toEqual(["第三个"]);
    press(doc, "Enter");
    expect(openSession).toHaveBeenCalledWith("s3");
  });

  it("改搜索词会把高亮拉回新结果的第一条", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "ArrowDown");
    press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第三个"]);
    // 换词后结果集变了,旧的第 3 行下标不该留着。
    const search = doc.querySelector("#history-search");
    search.value = "第二";
    search.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(selectedTitles(doc)).toEqual(["第二个"]);
  });

  it("清空搜索词后高亮回到完整列表的第一条", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    const search = doc.querySelector("#history-search");
    search.value = "第三";
    search.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    await Promise.resolve();
    search.value = "";
    search.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(selectedTitles(doc)).toEqual(["第一个"]);
  });

  it("后台刷新不会把用户移动过的高亮顶回第一行", async () => {
    const { drawer, doc } = setup();
    drawer.show();
    await drawer.refresh();
    press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第二个"]);
    await drawer.refresh();   // 外部 onChange 触发的刷新
    expect(selectedTitles(doc)).toEqual(["第二个"]);
  });

  it("打开浮层时先显示加载动画,列表回来后换成行", async () => {
    const { drawer, doc, deps } = setup();
    // 让 refreshList 挂住,以便观察 await 之前的那一帧。
    let release;
    deps.sessions.refreshList.mockReturnValueOnce(new Promise((resolve) => { release = () => resolve(SESSIONS); }));

    drawer.show();
    // 列表还没回来:应当是加载态,而不是一片空白或上一次的残留行。
    const loading = doc.querySelector(".history-loading");
    expect(loading).toBeTruthy();
    expect(loading.querySelector(".typing-dots")).toBeTruthy();
    expect(rows(doc)).toHaveLength(0);

    release();
    await Promise.resolve();
    await Promise.resolve();
    // 列表到手后加载态让位给真正的行。
    expect(doc.querySelector(".history-loading")).toBeNull();
    expect(rows(doc)).toHaveLength(3);
  });

  it("加载态下回车不打开任何会话", async () => {
    const { drawer, doc, openSession, deps } = setup();
    let release;
    deps.sessions.refreshList.mockReturnValueOnce(new Promise((resolve) => { release = () => resolve(SESSIONS); }));

    drawer.show();
    // 加载中还没有任何行,回车不该赌一个下标去开会话。
    press(doc, "Enter");
    expect(openSession).not.toHaveBeenCalled();

    release();
    await Promise.resolve();
    await Promise.resolve();
    // 加载完成后回车恢复正常,开首条。
    press(doc, "Enter");
    expect(openSession).toHaveBeenCalledWith("s1");
  });

  it("刷新失败时加载态退回旧列表,不把浮层留在转圈上", async () => {
    const { drawer, doc, deps } = setup();
    drawer.show();
    await drawer.refresh();
    expect(rows(doc)).toHaveLength(3);

    deps.sessions.refreshList.mockRejectedValueOnce(new Error("offline"));
    await drawer.refresh({ showLoading: true });
    // 后端不可达:保留旧行,而不是永远停在加载动画上。
    expect(doc.querySelector(".history-loading")).toBeNull();
    expect(rows(doc)).toHaveLength(3);
  });

  it("列表变短后高亮下标不会越界", async () => {
    const { drawer, doc, deps } = setup();
    drawer.show();
    await drawer.refresh();
    for (let i = 0; i < 2; i++) press(doc, "ArrowDown");
    expect(selectedTitles(doc)).toEqual(["第三个"]);
    // 列表收窄到 1 条后重渲染,原下标 2 已经不存在了。
    deps.sessions.refreshList.mockResolvedValueOnce([SESSIONS[0]]);
    await drawer.refresh();
    expect(rows(doc)).toHaveLength(1);
    expect(selectedTitles(doc)).toEqual(["第一个"]);
  });
});
