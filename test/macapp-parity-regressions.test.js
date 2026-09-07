// @vitest-environment jsdom
// 对齐 dsh-macapp 今天那批修复的三类问题在本扩展里的回归测试:
//   1. 陈旧异步回包(旧请求的结果覆盖新状态)
//   2. 用户动作缺进度反馈 / 失败被吞
//   3. 无界渲染(超长内容一次性物化)
import { describe, it, expect, vi, beforeAll } from "vitest";
import { mountGitEntry } from "../src/app/sidepanel/git-entry.js";
import { mountGoalBar } from "../src/features/docks/session-docks.js";
import { foldMessageText } from "../src/features/chat/long-message.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const REPO = {
  hasRepository: true, head: "main", detached: false,
  added: 1, removed: 0, changedFiles: 1,
  localBranches: ["main"], isWorktree: false,
  upstream: { hasRemote: true, ref: "origin/main", ahead: 0, behind: 0 }
};

function mountGitDom() {
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
  const menu = document.querySelector("#git-entry-menu");
  menu.hidePopover = () => {};
  menu.showPopover = () => {};
  return { trigger: document.querySelector("#git-entry-btn"), menu };
}

describe("陈旧异步回包", () => {
  it("git 入口丢弃切换工作目录前发出的摘要", async () => {
    const { trigger, menu } = mountGitDom();
    const slow = deferred();
    let cwd = "/repo-a";
    const summaryReader = {
      summary: vi.fn()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValue({ ...REPO, head: "branch-b" }),
      upstreamState: vi.fn().mockResolvedValue(null)
    };
    const entry = mountGitEntry(trigger, menu, {
      summaryReader,
      gitService: { worktrees: vi.fn().mockResolvedValue([]) },
      getCwd: () => cwd,
      showToast: vi.fn()
    });

    const stale = entry.refresh();     // 针对 /repo-a
    cwd = "/repo-b";
    await entry.refresh();             // 针对 /repo-b,先落地
    slow.resolve({ ...REPO, head: "branch-a" });
    await stale;

    // 旧目录的分支名不得覆盖新目录的。
    expect(trigger.querySelector(".git-entry-branch").textContent).toBe("branch-b");
  });
});

describe("失败必须可见", () => {
  it("目标编辑保存失败时报错并留在编辑态", async () => {
    document.body.innerHTML = `<div id="goal-bar"></div>`;
    const container = document.querySelector("#goal-bar");
    const onEdit = vi.fn().mockRejectedValue(new Error("host refused"));
    mountGoalBar(container, {
      onPause: vi.fn(), onResume: vi.fn(), onEdit, onClear: vi.fn()
    }).set({ id: "g1", objective: "old", phase: "active" });

    [...container.querySelectorAll(".goal-btn")].find((b) => b.title === "Edit goal").click();
    const input = container.querySelector("input");
    input.value = "new objective";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => {
      expect(container.querySelector(".goal-error")?.textContent).toContain("host refused");
    });
    expect(onEdit).toHaveBeenCalledWith("new objective");
    // 失败后不能悄悄退回展示态、显示旧目标,让用户以为保存成功了。
    expect(container.querySelector("input")).toBeTruthy();
  });
});

describe("无界渲染", () => {
  it("超长 assistant 正文按阈值折叠,不整段交给渲染器", () => {
    const huge = "x".repeat(500000);
    const fold = foldMessageText(huge, 20000);
    expect(fold.folded).toBe(true);
    expect(fold.preview.length).toBeLessThanOrEqual(20000);
    expect(fold.hidden).toBe(500000 - fold.preview.length);
  });
});
