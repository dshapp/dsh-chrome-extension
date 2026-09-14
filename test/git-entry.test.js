// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountGitEntry } from "../src/app/sidepanel/git-entry.js";
import { NO_REPOSITORY } from "../src/features/host-proxy/git-summary.js";

/// 造出 header 里那两个节点,与 index.html 的结构一致。
function mountDom() {
  document.body.innerHTML = `
    <button id="git-entry-btn" hidden>
      <span class="git-entry-icon"></span>
      <span class="git-entry-text">
        <span class="git-entry-branch"></span>
        <span class="git-entry-stat" hidden>
          <span class="git-entry-added"></span><span class="git-entry-removed"></span>
        </span>
      </span>
    </button>
    <div id="git-entry-menu"></div>`;
  const trigger = document.querySelector("#git-entry-btn");
  const menu = document.querySelector("#git-entry-menu");
  // jsdom 没有 popover API;补一个最小实现,让 toggle 事件能被驱动。
  menu.hidePopover = () => menu.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" }));
  menu.showPopover = () => menu.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
  return { trigger, menu };
}

const REPO = {
  hasRepository: true, head: "main", detached: false,
  added: 12, removed: 3, changedFiles: 2,
  localBranches: ["main", "feat/a", "feat/b"], isWorktree: false,
  upstream: { hasRemote: true, ref: "origin/main", ahead: 0, behind: 0 }
};

function setup({ summary = REPO, worktrees = [], gitOverrides = {} } = {}) {
  const { trigger, menu } = mountDom();
  const showToast = vi.fn();
  const gitService = {
    worktrees: vi.fn().mockResolvedValue(worktrees),
    checkout: vi.fn().mockResolvedValue({ exitCode: 0 }),
    push: vi.fn().mockResolvedValue({ exitCode: 0 }),
    pull: vi.fn().mockResolvedValue({ exitCode: 0 }),
    ...gitOverrides
  };
  const summaryReader = {
    summary: vi.fn().mockResolvedValue(summary),
    upstreamState: vi.fn().mockResolvedValue(summary?.upstream ?? null)
  };
  const entry = mountGitEntry(trigger, menu, {
    summaryReader, gitService, getCwd: () => "/repo",
    showToast, onWorkingTreeChanged: vi.fn(),
    promptBranchName: vi.fn().mockResolvedValue("new-branch")
  });
  return { trigger, menu, entry, gitService, summaryReader, showToast };
}

describe("Git 入口:出现时机", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("非 git 仓库 -> 入口整个不渲染", async () => {
    // Mac 的注释:入口的全部内容都是 git 状态,没有仓库就什么都不该画。
    const { trigger, entry } = setup({ summary: NO_REPOSITORY });
    await entry.refresh();
    expect(trigger.hidden).toBe(true);
  });

  it("宿主代理不可用 -> 同样静默隐藏,不报错", async () => {
    // 老 daemon / 没跑 / 用户关了总开关:与「非仓库」一视同仁地隐藏,
    // 而不是弹一个用户无法处理的错误。
    const ctx = setup();
    ctx.summaryReader.summary.mockRejectedValue(
      Object.assign(new Error("no daemon"), { isUnsupported: true })
    );
    await ctx.entry.refresh();
    expect(ctx.trigger.hidden).toBe(true);
    expect(ctx.showToast).not.toHaveBeenCalled();
  });

  it("是仓库 -> 显示分支名与 ±行数", async () => {
    const { trigger, entry } = setup();
    await entry.refresh();
    expect(trigger.hidden).toBe(false);
    expect(trigger.querySelector(".git-entry-branch").textContent).toBe("main");
    expect(trigger.querySelector(".git-entry-stat").hidden).toBe(false);
    expect(trigger.querySelector(".git-entry-added").textContent).toBe("+12");
    expect(trigger.querySelector(".git-entry-removed").textContent).toBe("−3");
  });

  it("干净工作树不显示 ±行数", async () => {
    const { trigger, entry } = setup({ summary: { ...REPO, added: 0, removed: 0, changedFiles: 0 } });
    await entry.refresh();
    expect(trigger.querySelector(".git-entry-stat").hidden).toBe(true);
  });

  it("linked worktree 与普通 checkout 用不同图标", async () => {
    const plain = setup();
    await plain.entry.refresh();
    const plainIcon = plain.trigger.querySelector(".git-entry-icon").innerHTML;
    const wt = setup({ summary: { ...REPO, isWorktree: true } });
    await wt.entry.refresh();
    expect(wt.trigger.querySelector(".git-entry-icon").innerHTML).not.toBe(plainIcon);
  });

  it("tooltip 干净时说干净,有改动时给出文件数与行数", async () => {
    const clean = setup({ summary: { ...REPO, added: 0, removed: 0, changedFiles: 0 } });
    await clean.entry.refresh();
    expect(clean.trigger.title).toContain("main");
    const dirty = setup();
    await dirty.entry.refresh();
    expect(dirty.trigger.title).toContain("+12");
  });
});

describe("Git 入口:popover 结构", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  async function opened(options) {
    const ctx = setup(options);
    await ctx.entry.refresh();
    ctx.menu.showPopover();
    await Promise.resolve();
    return ctx;
  }

  it("先只有当前分支行、新建行", async () => {
    const { menu } = await opened();
    expect(menu.querySelector("#git-current")).toBeTruthy();
    expect(menu.querySelector("#git-create")).toBeTruthy();
    // 未展开时不列出可切换分支
    expect(menu.querySelector("#git-branch-0")).toBeNull();
  });

  it("点当前分支行原地展开分支列表", async () => {
    const { menu } = await opened();
    menu.querySelector("#git-current").click();
    expect(menu.querySelector("#git-branch-0")).toBeTruthy();
  });

  it("分支数 <= 8 不给搜索框", async () => {
    const { menu } = await opened();
    menu.querySelector("#git-current").click();
    expect(menu.querySelector("#git-search")).toBeNull();
  });

  it("分支数 > 8 才给搜索框", async () => {
    const many = ["main", ...Array.from({ length: 9 }, (_, i) => "b" + i)];
    const { menu } = await opened({ summary: { ...REPO, localBranches: many } });
    menu.querySelector("#git-current").click();
    expect(menu.querySelector("#git-search")).toBeTruthy();
  });

  it("被其他 worktree 占用的分支置灰并标出占用者", async () => {
    const { menu } = await opened({
      worktrees: [{ path: "/other-wt", branch: "feat/a", detached: false, bare: false, head: "x" }]
    });
    menu.querySelector("#git-current").click();
    const rows = [...menu.querySelectorAll(".git-row")].filter((r) => r.id.startsWith("git-branch-"));
    const occupied = rows.find((r) => r.textContent.includes("feat/a"));
    expect(occupied.disabled).toBe(true);
    expect(occupied.textContent).toContain("other-wt");
  });

  it("无可切换分支时当前分支行不可点", async () => {
    const { menu } = await opened({ summary: { ...REPO, localBranches: ["main"] } });
    expect(menu.querySelector("#git-current").disabled).toBe(true);
  });

  it("push 行只在 ahead > 0 时出现", async () => {
    const none = await opened();
    expect(none.menu.querySelector("#git-push")).toBeNull();
    const ahead = await opened({ summary: { ...REPO, upstream: { hasRemote: true, ref: "o/m", ahead: 2, behind: 0 } } });
    expect(ahead.menu.querySelector("#git-push")).toBeTruthy();
    expect(ahead.menu.querySelector("#git-push").textContent).toContain("2");
  });

  it("pull 行只在 behind > 0 时出现", async () => {
    const behind = await opened({ summary: { ...REPO, upstream: { hasRemote: true, ref: "o/m", ahead: 0, behind: 5 } } });
    expect(behind.menu.querySelector("#git-pull")).toBeTruthy();
    expect(behind.menu.querySelector("#git-pull").textContent).toContain("5");
  });

  it("没有远端时两行都不出现", async () => {
    const { menu } = await opened({ summary: { ...REPO, upstream: null } });
    expect(menu.querySelector("#git-push")).toBeNull();
    expect(menu.querySelector("#git-pull")).toBeNull();
  });
});

describe("Git 入口:动作", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  async function opened(options) {
    const ctx = setup(options);
    await ctx.entry.refresh();
    ctx.menu.showPopover();
    await Promise.resolve();
    ctx.menu.querySelector("#git-current")?.click();
    return ctx;
  }

  it("点当前分支所在行不跑 git", async () => {
    // Mac: 已经是当前分支就只关闭,绝不 checkout。
    const { menu, gitService } = await opened();
    // 当前分支不在可切换列表里,所以构造一次「列表里就是 head」的点击路径:
    // 直接验证可切换列表不含 head 即可。
    const head = menu.querySelector("#git-current");
    expect(head.textContent.trim().startsWith("main")).toBe(true);
    // 展开指示改成 lucide chevron(不再用 ▾ 字符)。
    expect(head.querySelector(".disclosure-chevron svg, svg.disclosure-chevron")).toBeTruthy();
    expect(gitService.checkout).not.toHaveBeenCalled();
  });

  it("切换分支调用 checkout", async () => {
    const { menu, gitService } = await opened();
    menu.querySelector("#git-branch-0").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(gitService.checkout).toHaveBeenCalledWith("/repo", "feat/a");
  });

  it("切换失败时 popover 不关闭,并 toast 报错", async () => {
    const { menu, showToast } = await opened({
      gitOverrides: { checkout: vi.fn().mockRejectedValue(new Error("would be overwritten")) }
    });
    let closed = false;
    menu.addEventListener("toggle", (e) => { if (e.newState === "closed") closed = true; });
    menu.querySelector("#git-branch-0").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(showToast).toHaveBeenCalled();
    expect(closed).toBe(false);
  });

  it("新建分支用 checkout -b,且先关闭 popover 再问名字", async () => {
    const ctx = setup();
    await ctx.entry.refresh();
    ctx.menu.showPopover();
    await Promise.resolve();
    let closedBeforePrompt = false;
    ctx.menu.addEventListener("toggle", (e) => { if (e.newState === "closed") closedBeforePrompt = true; });
    ctx.menu.querySelector("#git-create").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(closedBeforePrompt).toBe(true);
    expect(ctx.gitService.checkout).toHaveBeenCalledWith("/repo", "new-branch", { create: true });
  });

  it("push 成功后关闭并提示", async () => {
    const ctx = await opened({ summary: { ...REPO, upstream: { hasRemote: true, ref: "o/m", ahead: 1, behind: 0 } } });
    ctx.menu.querySelector("#git-push").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.gitService.push).toHaveBeenCalledWith("/repo");
    expect(ctx.showToast).toHaveBeenCalled();
  });

  it("pull 失败后不再 fetch —— refs 刚查过", async () => {
    const ctx = await opened({
      summary: { ...REPO, upstream: { hasRemote: true, ref: "o/m", ahead: 0, behind: 2 } },
      gitOverrides: { pull: vi.fn().mockRejectedValue(new Error("diverged")) }
    });
    ctx.summaryReader.upstreamState.mockClear();
    ctx.menu.querySelector("#git-pull").click();
    await new Promise((r) => setTimeout(r, 0));
    const fetched = ctx.summaryReader.upstreamState.mock.calls.some((c) => c[1]?.fetch === true);
    expect(fetched).toBe(false);
  });
});
