// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mountWorkspaceMenu } from "../src/app/sidepanel/workspace-menu.js";
import { mountHistoryDrawer } from "../src/app/sidepanel/sidepanel-overlays.js";
import { setLang, t } from "../src/shared/i18n.js";

const WORKSPACES = [
  { workspaceId: "w1", path: "/Users/u/dsh-chrome", title: "dsh-chrome", sessionIds: ["s1", "s3"] },
  { workspaceId: "w2", path: "/Users/u/mono/web", title: "web", sessionIds: ["s2"] }
];

// jsdom 未实现 Popover API,菜单只需要 hidePopover 存在。
function stubPopover(el) {
  el.hidePopover = () => {};
  el.showPopover = () => {};
  return el;
}

// workspace-menu 用 chrome.storage.local 持久化选择;这里用内存实现替身。
function stubChromeStorage(initial = {}) {
  const store = { ...initial };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]]).filter(([, v]) => v !== undefined)),
        set: async (obj) => Object.assign(store, obj),
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
      }
    }
  };
  return store;
}

const HOST_CWD = "/Users/u";

function setup({ workspaces = WORKSPACES, pickAndCreate, storage = {}, hostCwd = HOST_CWD } = {}) {
  stubChromeStorage(storage);
  const dom = new JSDOM("<!DOCTYPE html><body></body></html>");
  const doc = dom.window.document;
  const elements = {
    hdrWorkspace: doc.createElement("button"),
    hdrWorkspaceLabel: doc.createElement("span"),
    // 标题里的工作目录前缀:与头部那颗 chip 同一份选择,但按"会话归属"措辞。
    hdrWorkspacePrefix: doc.createElement("span"),
    // 新建会话页的那颗 chip:与头部共用同一个 popover,但首行语义不同。
    heroWorkspace: doc.createElement("button"),
    heroWorkspaceLabel: doc.createElement("span"),
    workspaceMenu: stubPopover(doc.createElement("div"))
  };
  const deps = {
    workspaces: {
      workspaces,
      refresh: vi.fn(async () => workspaces),
      pickAndCreate: pickAndCreate ?? vi.fn(async () => null)
    },
    formatErrorDetails: (e) => String(e?.message ?? e)
  };
  const onChange = vi.fn();
  const showToast = vi.fn();
  const menu = mountWorkspaceMenu(elements, deps, {
    onChange, showToast, hostCwd: () => hostCwd
  });
  return { elements, deps, menu, onChange, showToast };
}

function itemIds(menu) {
  return [...menu.querySelectorAll("[data-item-id]")].map((b) => b.dataset.itemId);
}

function clickItem(menu, id) {
  menu.querySelector(`[data-item-id="${id}"]`).click();
}

beforeEach(() => setLang("zh"));

describe("workspace 下拉菜单", () => {
  it("列出「全部」+ 每个 workspace + 「添加目录…」", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    // __temp__ =「临时目录」过滤项(宿主 cwd),排在「全部」之后、工作目录之前。
    expect(itemIds(elements.workspaceMenu)).toEqual(["__all__", "__temp__", "w1", "w2", "__add__"]);
    // 默认不过滤
    expect(menu.activePath()).toBeNull();
    expect(elements.hdrWorkspaceLabel.textContent).toBe(t("workspace.all"));
  });

  it("选中某目录后更新标签、过滤路径并通知调用方", async () => {
    const { elements, menu, onChange } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "w2");
    await vi.waitFor(() => expect(menu.selected()?.workspaceId).toBe("w2"));
    expect(menu.activePath()).toBe("/Users/u/mono/web");
    expect(elements.hdrWorkspaceLabel.textContent).toBe("web");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("选回「全部」清除过滤", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "w1");
    await vi.waitFor(() => expect(menu.activePath()).toBe("/Users/u/dsh-chrome"));
    clickItem(elements.workspaceMenu, "__all__");
    await vi.waitFor(() => expect(menu.activePath()).toBeNull());
  });

  it("activeSessionIds 选中 workspace 时返回其 sessionIds,否则为 null", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    expect(menu.activeSessionIds()).toBeNull();
    clickItem(elements.workspaceMenu, "w1");
    await vi.waitFor(() => expect(menu.selected()?.workspaceId).toBe("w1"));
    expect(menu.activeSessionIds()).toEqual(["s1", "s3"]);
    clickItem(elements.workspaceMenu, "__temp__");
    expect(menu.activeSessionIds()).toBeNull();
  });

  it("setActiveByCwd 按 cwd 反查并高亮对应项,不触发 onChange", async () => {
    const { menu, onChange } = setup();
    await menu.refresh();
    menu.setActiveByCwd("/Users/u/mono/web");
    expect(menu.selected()?.workspaceId).toBe("w2");
    // 跟随显示不是用户切换
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cwd 不属于任何 workspace 时显示目录名但不过滤", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd("/Users/u/code/teacher");
    expect(menu.selected()).toBeNull();
    expect(menu.activePath()).toBeNull();
    expect(elements.hdrWorkspaceLabel.textContent).toBe("teacher");
  });

  it("「添加目录…」被取消(返回 null)时保持原选中不变", async () => {
    const pickAndCreate = vi.fn(async () => null);
    const { elements, menu, onChange } = setup({ pickAndCreate });
    await menu.refresh();
    clickItem(elements.workspaceMenu, "w1");
    // handleSelect 是 async,onChange 在微任务里才触发:先等它到达再清计数,
    // 否则清掉的是尚未落地的那一次。
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(menu.selected()?.workspaceId).toBe("w1");
    onChange.mockClear();
    clickItem(elements.workspaceMenu, "__add__");
    await vi.waitFor(() => expect(pickAndCreate).toHaveBeenCalled());
    expect(menu.selected()?.workspaceId).toBe("w1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("添加目录成功后选中新目录", async () => {
    const created = { workspaceId: "w3", path: "/Users/u/new", title: "new" };
    const workspaces = [...WORKSPACES];
    const pickAndCreate = vi.fn(async () => { workspaces.push(created); return created; });
    const { elements, menu, deps, onChange } = setup({ workspaces, pickAndCreate });
    await menu.refresh();
    clickItem(elements.workspaceMenu, "__add__");
    await vi.waitFor(() => expect(menu.selected()?.workspaceId).toBe("w3"));
    expect(deps.workspaces.workspaces).toContain(created);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("workspace.list 为空时只有「全部」与「添加目录…」", async () => {
    const { elements, menu } = setup({ workspaces: [] });
    await menu.refresh();
    expect(itemIds(elements.workspaceMenu)).toEqual(["__all__", "__temp__", "__add__"]);
    expect(menu.activePath()).toBeNull();
  });

  it("workspace.list 失败时退化为不过滤,不抛错", async () => {
    const { elements, menu, deps } = setup();
    deps.workspaces.refresh = vi.fn(async () => { throw new Error("offline"); });
    deps.workspaces.workspaces = [];
    await expect(menu.refresh()).resolves.toBeDefined();
    expect(itemIds(elements.workspaceMenu)).toEqual(["__all__", "__temp__", "__add__"]);
  });

  it("恢复上次选中的目录", async () => {
    const { menu } = setup({ storage: { codemax_dsh_workspace_id: "w2" } });
    await menu.refresh();
    expect(menu.selected()?.workspaceId).toBe("w2");
  });

  it("上次选中的目录已被删除时回落「全部」", async () => {
    const { menu } = setup({ storage: { codemax_dsh_workspace_id: "gone" } });
    await menu.refresh();
    expect(menu.selected()).toBeNull();
    expect(menu.activePath()).toBeNull();
  });
});

// ---- 历史列表按 cwd 过滤 ----
const SESSIONS = [
  { sessionId: "s1", cwd: "/Users/u/dsh-chrome", updatedAt: 3, projections: { values: { title: "面板" } } },
  { sessionId: "s2", cwd: "/Users/u/mono/web", updatedAt: 2, projections: { values: { title: "网页" } } },
  { sessionId: "s3", cwd: "/Users/u/dsh-chrome", updatedAt: 1, projections: { values: { title: "桥" } } }
];

function historySetup(workspacePath, workspaceSessionIds = () => null) {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <button id="hdr-title-wrap"></button><span id="hdr-title"></span>
    <div id="history-popover"><input id="history-search" />
    <ul id="history-list-inner"></ul></div></body></html>`);
  globalThis.document = dom.window.document;
  globalThis.prompt = () => null;
  globalThis.alert = () => {};
  const deps = {
    sessions: { refreshList: vi.fn(async () => SESSIONS), fork: vi.fn(), rename: vi.fn() },
    formatErrorDetails: (e) => String(e)
  };
  const drawer = mountHistoryDrawer(deps, vi.fn(), vi.fn(), null, { workspacePath, workspaceSessionIds });
  return { drawer, doc: dom.window.document };
}

function listedIds(doc) {
  return [...doc.querySelectorAll("[data-session-id]")].map((el) => el.dataset.sessionId);
}

describe("历史列表按工作目录过滤", () => {
  it("选中目录时只列该目录的会话", async () => {
    const { drawer, doc } = historySetup(() => "/Users/u/dsh-chrome");
    await drawer.refresh();
    expect(listedIds(doc)).toEqual(["s1", "s3"]);
  });

  it("未选目录(null)时列出全部", async () => {
    const { drawer, doc } = historySetup(() => null);
    await drawer.refresh();
    expect(listedIds(doc)).toEqual(["s1", "s2", "s3"]);
  });

  it("过滤条件是取值函数,切换后下次刷新即生效", async () => {
    let path = null;
    const { drawer, doc } = historySetup(() => path);
    await drawer.refresh();
    expect(listedIds(doc)).toHaveLength(3);
    path = "/Users/u/mono/web";
    await drawer.refresh();
    expect(listedIds(doc)).toEqual(["s2"]);
  });

  it("该目录下没有会话时显示空文案", async () => {
    const { drawer, doc } = historySetup(() => "/nowhere");
    await drawer.refresh();
    expect(listedIds(doc)).toEqual([]);
    expect(doc.querySelector("#history-list-inner").textContent).toContain(t("sessions.empty"));
  });

  it("选中 workspace 时优先按 sessionIds 过滤,path 拼写不一致也不消失", async () => {
    // 关键回归:workspace.path 是 canonical 路径(带尾斜杠示意拼写差异),会话的
    // cwd 与之不严格相等。老逻辑按 item.cwd === path 会整片清空 —— 这就是
    // 「点击切换工作目录后会话列表消失」的根因。现在应改按成员名单命中。
    const { drawer, doc } = historySetup(() => "/Users/u/dsh-chrome/", () => ["s1", "s3"]);
    await drawer.refresh();
    expect(listedIds(doc)).toEqual(["s1", "s3"]);
  });

  it("workspace 没有 sessionIds 时回落到按 cwd 过滤", async () => {
    const { drawer, doc } = historySetup(() => "/Users/u/mono/web", () => []);
    await drawer.refresh();
    expect(listedIds(doc)).toEqual(["s2"]);
  });
});

// 真实 HTML 的结构不变量。用真页面而不是内联 fixture:这个 bug 恰恰是
// fixture 测不出来的那类 —— 逻辑全对,坏在元素的 DOM 归属上。
describe("工作目录菜单的挂载位置(hero chip 点击无反应回归)", () => {
  const html = readFileSync(resolve(process.cwd(), "pages/sidepanel/index.html"), "utf8");
  const css = readFileSync(
    resolve(process.cwd(), "src/app/sidepanel/styles/foundation.css"), "utf8");
  const build = () => {
    const dom = new JSDOM(html);
    const d = dom.window.document;
    d.head.appendChild(Object.assign(d.createElement("style"), { textContent: css }));
    return dom;
  };

  it("#workspace-menu 不能是 #history-popover 的后代", () => {
    // #history-popover 平时 display:none;菜单挂在它里面时整棵子树都不渲染,
    // 新建会话页的 hero chip 按下去就毫无反应。
    const d = build().window.document;
    expect(d.querySelector("#history-popover").contains(d.querySelector("#workspace-menu")))
      .toBe(false);
  });

  it("两颗触发钮都仍指向同一个 popover", () => {
    const d = build().window.document;
    const ids = [...d.querySelectorAll('[popovertarget="workspace-menu"]')].map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(["hdr-workspace", "hero-workspace"]));
    expect(d.querySelector("#workspace-menu").getAttribute("popover")).toBe("auto");
  });

  it("菜单的祖先链上没有任何 display:none 的容器", () => {
    const dom = build();
    const d = dom.window.document;
    let node = d.querySelector("#workspace-menu").parentElement;
    const hidden = [];
    while (node && node !== d.documentElement) {
      if (dom.window.getComputedStyle(node).display === "none") hidden.push("#" + node.id);
      node = node.parentElement;
    }
    expect(hidden).toEqual([]);
  });
});

// 参考 mac 端 session-158ce976 的结论:新建会话不强制选工作区,未选时
// session.create 不带 workspaceId/cwd,由宿主决定工作目录
// (host 契约:"an omitted project uses the Host cwd")。
// 传输层本来就支持,缺的是让用户看得懂的出口 —— 所以这里测的是文案语义。
describe("新建会话:工作目录可选(未选 = 临时目录)", () => {
  const openFrom = (el) => el.dispatchEvent(
    new el.ownerDocument.defaultView.Event("pointerdown", { bubbles: true }));

  it("hero chip 未选工作目录时显示「临时目录」,而不是「全部」", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    // 头部那颗是历史过滤器,仍然是「全部」。
    expect(elements.hdrWorkspaceLabel.textContent).toBe(t("workspace.all"));
    // 新建会话页那颗决定会话建在哪 —— 未选就是临时目录。
    expect(elements.heroWorkspaceLabel.textContent).toBe(t("workspace.temporary"));
    expect(elements.heroWorkspace.title).toBe(t("workspace.temporaryHint"));
  });

  it("由 hero chip 打开时,菜单首行是「临时目录」并带说明", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    openFrom(elements.heroWorkspace);
    const first = elements.workspaceMenu.querySelector('[data-item-id="__all__"]');
    expect(first.querySelector("span").textContent).toBe(t("workspace.temporary"));
    expect(first.querySelector("small").textContent).toBe(t("workspace.temporaryHint"));
  });

  it("由头部 chip 打开时,首行仍是过滤器语义的「全部」且无说明", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    openFrom(elements.heroWorkspace);
    openFrom(elements.hdrWorkspace);
    const first = elements.workspaceMenu.querySelector('[data-item-id="__all__"]');
    expect(first.querySelector("span").textContent).toBe(t("workspace.all"));
    expect(first.querySelector("small")).toBeNull();
  });

  it("选中工作目录后两颗 chip 都显示该目录名", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "w1");
    expect(elements.hdrWorkspaceLabel.textContent).toBe("dsh-chrome");
    expect(elements.heroWorkspaceLabel.textContent).toBe("dsh-chrome");
    expect(elements.heroWorkspace.title).toBe("/Users/u/dsh-chrome");
  });

  it("从工作目录切回首行后,hero 重新显示「临时目录」", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "w1");
    clickItem(elements.workspaceMenu, "__all__");
    expect(menu.selected()).toBeNull();
    expect(elements.heroWorkspaceLabel.textContent).toBe(t("workspace.temporary"));
  });

  it("未选工作目录时 selected() 为 null —— 调用方据此发空 payload", async () => {
    const { menu } = setup();
    await menu.refresh();
    // newSession() 读的就是这个:null => {} => 宿主自己定 cwd。
    expect(menu.selected()).toBeNull();
    expect(menu.activePath()).toBeNull();
  });
});

// 未选工作目录创建的会话都建在宿主自身 cwd 下,所以「临时目录」是一个具体
// 路径,能像普通工作目录一样精确过滤 —— 而不是退化成「全部」。
describe("历史过滤:临时目录", () => {
  it("菜单里「临时目录」独立成行,提示为宿主 cwd", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    const row = elements.workspaceMenu.querySelector('[data-item-id="__temp__"]');
    expect(row.querySelector("span").textContent).toBe(t("workspace.temporary"));
    expect(row.querySelector("small").textContent).toBe(HOST_CWD);
  });

  it("选中它后 activePath() 返回宿主 cwd(不是 null)", async () => {
    const { elements, menu, onChange } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "__temp__");
    // 关键:null 会被历史列表当成"不过滤",那就完全达不到过滤的目的。
    expect(menu.activePath()).toBe(HOST_CWD);
    expect(menu.selected()).toBeNull();
    expect(elements.hdrWorkspaceLabel.textContent).toBe(t("workspace.temporary"));
    expect(onChange).toHaveBeenCalled();
  });

  it("「全部」仍是不过滤,与「临时目录」互不混淆", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "__temp__");
    expect(menu.activePath()).toBe(HOST_CWD);
    clickItem(elements.workspaceMenu, "__all__");
    expect(menu.activePath()).toBeNull();
    expect(elements.hdrWorkspaceLabel.textContent).toBe(t("workspace.all"));
  });

  it("切到具体工作目录后会退出临时目录态", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "__temp__");
    clickItem(elements.workspaceMenu, "w1");
    expect(menu.activePath()).toBe("/Users/u/dsh-chrome");
    expect(elements.hdrWorkspaceLabel.textContent).toBe("dsh-chrome");
  });

  it("打开建在宿主 cwd 下的会话时,过滤器跟随选中「临时目录」", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd(HOST_CWD);
    expect(menu.activePath()).toBe(HOST_CWD);
    expect(elements.hdrWorkspaceLabel.textContent).toBe(t("workspace.temporary"));
  });

  it("打开既非工作目录也非宿主 cwd 的会话时,显示目录名且不过滤", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd("/Users/u/legacy-proj");
    expect(menu.activePath()).toBeNull();
    expect(elements.hdrWorkspaceLabel.textContent).toBe("legacy-proj");
  });

  it("拿不到宿主 cwd 时不显示这一项(没有路径就无法过滤)", async () => {
    const { elements, menu } = setup({ hostCwd: null });
    await menu.refresh();
    expect(itemIds(elements.workspaceMenu)).toEqual(["__all__", "w1", "w2", "__add__"]);
  });
});

// 端到端:workspacePath() 给出宿主 cwd 时,历史列表真的只剩临时目录下的会话。
describe("历史列表按临时目录过滤(端到端)", () => {
  const HOST_SESSIONS = [
    { sessionId: "t1", cwd: "/Users/u", updatedAt: 3, projections: { values: { title: "临时一" } } },
    { sessionId: "s1", cwd: "/Users/u/dsh-chrome", updatedAt: 2, projections: { values: { title: "面板" } } },
    { sessionId: "t2", cwd: "/Users/u", updatedAt: 1, projections: { values: { title: "临时二" } } }
  ];

  function drawerWith(pathFn) {
    const dom = new JSDOM("<!DOCTYPE html><body>"
      + '<button id="hdr-title-wrap"></button><span id="hdr-title"></span>'
      + '<div id="history-popover"><input id="history-search" />'
      + '<ul id="history-list-inner"></ul></div></body></html>');
    globalThis.document = dom.window.document;
    globalThis.prompt = () => null;
    globalThis.alert = () => {};
    const deps = {
      sessions: { refreshList: vi.fn(async () => HOST_SESSIONS), fork: vi.fn(), rename: vi.fn() },
      formatErrorDetails: (e) => String(e)
    };
    const drawer = mountHistoryDrawer(deps, vi.fn(), vi.fn(), null, { workspacePath: pathFn });
    return { drawer, doc: dom.window.document };
  }

  it("只列出建在宿主 cwd 下的会话", async () => {
    const { drawer, doc } = drawerWith(() => "/Users/u");
    await drawer.refresh();
    expect(listedIds(doc)).toEqual(["t1", "t2"]);
  });

  it("不过滤时三条都在", async () => {
    const { drawer, doc } = drawerWith(() => null);
    await drawer.refresh();
    expect(listedIds(doc)).toEqual(["t1", "s1", "t2"]);
  });
});

// 标题里的工作目录前缀("工作目录 / 会话标题"的前半段)。它与过滤器共用同一份
// 选择,但措辞按"会话归属"来:没选具体目录时会话真正落在宿主 cwd,所以说
// 「临时目录」而不是「全部」。分隔符 "/" 由 CSS ::after 画,不进 textContent。
describe("标题中的工作目录前缀", () => {
  it("未选目录时显示「临时目录」", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    expect(elements.hdrWorkspacePrefix.textContent).toBe(t("workspace.temporary"));
    // 同一时刻过滤器仍是「全部」——两处措辞不同是有意的。
    expect(elements.hdrWorkspaceLabel.textContent).toBe(t("workspace.all"));
  });

  it("选中目录后显示目录名", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "w2");
    await vi.waitFor(() => expect(menu.selected()?.workspaceId).toBe("w2"));
    expect(elements.hdrWorkspacePrefix.textContent).toBe("web");
  });

  it("跟随打开的会话:cwd 命中 workspace 时显示其名字", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd("/Users/u/dsh-chrome");
    expect(elements.hdrWorkspacePrefix.textContent).toBe("dsh-chrome");
  });

  it("cwd 不属于任何 workspace 时显示该目录名", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd("/Users/u/code/teacher");
    expect(elements.hdrWorkspacePrefix.textContent).toBe("teacher");
  });

  it("会话就建在宿主 cwd 下时显示「临时目录」", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd(HOST_CWD);
    expect(elements.hdrWorkspacePrefix.textContent).toBe(t("workspace.temporary"));
  });

  it("前缀与会话标题各写各的 span,互不覆盖", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    // 模拟历史浮层的 setActive 写入会话标题
    const titleSpan = elements.hdrWorkspacePrefix.ownerDocument.createElement("span");
    titleSpan.textContent = "重构头部布局";
    menu.setActiveByCwd("/Users/u/mono/web");
    expect(elements.hdrWorkspacePrefix.textContent).toBe("web");
    expect(titleSpan.textContent).toBe("重构头部布局");
  });
});

// 「打开工作目录」按钮的路径来源:与 #hdr-workspace-prefix 显示的是同一个目录。
// displayedPath() 返回完整绝对路径而非显示名;与 activePath()(历史过滤器路径)
// 的关键差别在孤儿目录——header 会显示该目录名,却不过滤历史。
describe("打开目录按钮的路径(displayedPath)", () => {
  it("连接前(无选择、无宿主 cwd)为 null", async () => {
    const { menu } = setup({ hostCwd: null });
    await menu.refresh();
    expect(menu.displayedPath()).toBeNull();
  });

  it("未选目录且有宿主 cwd 时返回宿主 cwd(「临时目录」语义)", async () => {
    const { menu } = setup();
    await menu.refresh();
    expect(menu.displayedPath()).toBe(HOST_CWD);
  });

  it("选中 workspace 时返回其 path", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "w2");
    await vi.waitFor(() => expect(menu.displayedPath()).toBe("/Users/u/mono/web"));
  });

  it("选中「临时目录」时返回宿主 cwd", async () => {
    const { elements, menu } = setup();
    await menu.refresh();
    clickItem(elements.workspaceMenu, "__temp__");
    expect(menu.displayedPath()).toBe(HOST_CWD);
    expect(menu.activePath()).toBe(HOST_CWD);
  });

  it("孤儿目录(cwd 不属于任何 workspace)返回该 cwd,而 activePath 仍为 null", async () => {
    const { menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd("/Users/u/code/teacher");
    expect(menu.displayedPath()).toBe("/Users/u/code/teacher");
    expect(menu.activePath()).toBeNull();
  });

  it("打开宿主 cwd 下的会话时返回宿主 cwd", async () => {
    const { menu } = setup();
    await menu.refresh();
    menu.setActiveByCwd(HOST_CWD);
    expect(menu.displayedPath()).toBe(HOST_CWD);
  });
});
