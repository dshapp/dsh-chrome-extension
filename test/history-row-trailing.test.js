// @vitest-environment jsdom
// 历史行尾部渲染:徽章 / 相对时间 / 状态点抑制。
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { mountHistoryDrawer } from "../src/app/sidepanel/sidepanel-overlays.js";
import { createSessionListStore } from "../src/features/sessions/session-list-store.js";
import { SessionAwaitingKind } from "../src/features/sessions/session-row-trailing.js";
import { setLang } from "../src/shared/i18n.js";

const NOW = Date.now();
const SESSIONS = [
  { sessionId: "s1", cwd: "/w", updatedAt: NOW - 5 * 60_000, projections: { values: { title: "一" } } },
  { sessionId: "s2", cwd: "/w", updatedAt: NOW - 3 * 86_400_000, projections: { values: { title: "二" } } }
];

function setup({ sessions = SESSIONS } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <button id="hdr-title-wrap"></button><span id="hdr-title"></span>
    <div id="history-popover"><input id="history-search" />
    <ul id="history-list-inner"></ul></div></body></html>`);
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = (fn) => fn();
  dom.window.Element.prototype.scrollIntoView = function () {};
  const listStore = createSessionListStore();
  const deps = {
    sessions: {
      listStore,
      refreshList: vi.fn(async () => sessions),
      fork: vi.fn(), rename: vi.fn(), archive: vi.fn(), search: vi.fn(async () => null)
    },
    formatErrorDetails: String
  };
  const drawer = mountHistoryDrawer(deps, vi.fn(), vi.fn(), null, { workspacePath: () => null });
  return { drawer, doc: dom.window.document, listStore };
}

const rowOf = (doc, id) => doc.querySelector(`[data-session-id="${id}"]`);
const trailingText = (doc, id) => rowOf(doc, id).querySelector(".h-badge, .h-when")?.textContent ?? "";

describe("历史行尾部渲染", () => {
  it("默认渲染相对时间,而不是绝对时间戳", async () => {
    setLang("zh");
    const { drawer, doc } = setup();
    await drawer.refresh();
    expect(trailingText(doc, "s1")).toBe("5分钟");
    expect(trailingText(doc, "s2")).toBe("3天");
  });

  it("后台会话待审批 / 待回答时打出徽章", async () => {
    setLang("zh");
    const { drawer, doc, listStore } = setup();
    listStore.setAwaitingUser("s1", SessionAwaitingKind.approval);
    listStore.setAwaitingUser("s2", SessionAwaitingKind.question);
    await drawer.refresh();
    expect(trailingText(doc, "s1")).toBe("待审批");
    expect(trailingText(doc, "s2")).toBe("待回答");
    expect(rowOf(doc, "s1").querySelector(".h-badge").getAttribute("title")).toContain("审批");
  });

  it("草稿徽章在未打开的会话上显示", async () => {
    setLang("zh");
    const { drawer, doc, listStore } = setup();
    listStore.setDraft("s1", true);
    await drawer.refresh();
    expect(trailingText(doc, "s1")).toBe("草稿");
  });

  it("卡住的轮次盖过草稿", async () => {
    setLang("zh");
    const { drawer, doc, listStore } = setup();
    listStore.setDraft("s1", true);
    listStore.setAwaitingUser("s1", SessionAwaitingKind.approval);
    await drawer.refresh();
    expect(trailingText(doc, "s1")).toBe("待审批");
  });

  it("当前打开的会话不升起任何徽章,保留时间", async () => {
    setLang("zh");
    const { drawer, doc, listStore } = setup();
    listStore.setAwaitingUser("s1", SessionAwaitingKind.approval);
    listStore.setDraft("s1", true);
    drawer.setActive("s1", "一");
    await drawer.refresh();
    expect(rowOf(doc, "s1").querySelector(".h-badge")).toBeNull();
    expect(trailingText(doc, "s1")).toBe("5分钟");
  });

  it("警示徽章出现时抑制 running 绿点", async () => {
    const { drawer, doc, listStore } = setup({
      sessions: [{ ...SESSIONS[0], running: true }]
    });
    await drawer.refresh();
    expect(rowOf(doc, "s1").querySelector(".h-dot")).not.toBeNull();   // 无徽章时正常显示
    listStore.setAwaitingUser("s1", SessionAwaitingKind.approval);
    await drawer.refresh();
    expect(rowOf(doc, "s1").querySelector(".h-dot")).toBeNull();
  });

  it("归档 / 空白行尾部什么都不显示", async () => {
    const { drawer, doc } = setup({
      sessions: [
        { sessionId: "a", cwd: "/w", updatedAt: NOW, archived: true, projections: { values: { title: "归档" } } },
        { sessionId: "b", cwd: "/w", updatedAt: NOW, blank: true, projections: { values: { title: "空白" } } }
      ]
    });
    await drawer.refresh();
    expect(trailingText(doc, "a")).toBe("");
    expect(trailingText(doc, "b")).toBe("");
  });

  it("英文环境下用英文文案", async () => {
    setLang("en");
    const { drawer, doc, listStore } = setup();
    listStore.setAwaitingUser("s1", SessionAwaitingKind.approval);
    await drawer.refresh();
    expect(trailingText(doc, "s1")).toBe("Approve");
    expect(trailingText(doc, "s2")).toBe("3d");
    setLang("zh");
  });
});
