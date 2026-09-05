import { describe, it, expect, vi } from "vitest";
import {
  parseNumstat, parseBranchHeader, isWorktreeGitDir, parseLocalBranches,
  createGitSummaryReader, isClean, NO_REPOSITORY
} from "../src/features/host-proxy/git-summary.js";
import { occupancyMap, occupancyFromStdout, worktreeDisplayName } from "../src/features/host-proxy/worktree-occupancy.js";

describe("git-summary 解析", () => {
  it("解析真实的 diff --numstat", () => {
    // 取自 dsh-chrome-control 的真实输出。
    const out = "73\t0\tREADME.md\n18\t1\tdaemon/src/main.rs\n30\t0\tdaemon/src/server.rs";
    expect(parseNumstat(out)).toEqual({ added: 121, removed: 1, files: 3 });
  });

  it("二进制文件计文件数但不计行数", () => {
    // git 用 "-\t-" 表示没有 diff 内容;当成 0 会让这个改动在计数上消失。
    const out = "10\t2\ta.txt\n-\t-\timage.png";
    expect(parseNumstat(out)).toEqual({ added: 10, removed: 2, files: 2 });
  });

  it("解析 -z 输出时不会把 rename 的两个路径误算成记录", () => {
    const out = "2\t3\t\u0000old/name.js\u0000new/name.js\u00001\t0\trequest => response.md\u0000";
    expect(parseNumstat(out)).toEqual({ added: 3, removed: 3, files: 2 });
  });

  it("-z 输出保留文件名里的 tab 与换行", () => {
    const out = "-\t-\tfolder/tab\tand\nline.bin\u0000";
    expect(parseNumstat(out)).toEqual({ added: 0, removed: 0, files: 1 });
  });

  it("空输出是干净工作树", () => {
    expect(parseNumstat("")).toEqual({ added: 0, removed: 0, files: 0 });
  });

  it("解析分支头部与 ahead/behind", () => {
    const out = [
      "# branch.oid cd40f9e",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3"
    ].join("\n");
    const parsed = parseBranchHeader(out);
    expect(parsed.head).toBe("main");
    expect(parsed.detached).toBe(false);
    expect(parsed.upstream).toEqual({ hasRemote: true, ref: "origin/main", ahead: 2, behind: 3 });
  });

  it("没有上游时 upstream 为 null —— push/pull 两行都不该出现", () => {
    const out = "# branch.oid cd40f9e\n# branch.head main";
    expect(parseBranchHeader(out).upstream).toBeNull();
  });

  it("有上游但计数为 0 时仍视为有远端", () => {
    // 这一条决定 push/pull 行「有远端但无需同步」与「没有远端」的区别。
    const out = "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0";
    expect(parseBranchHeader(out).upstream).toEqual({ hasRemote: true, ref: "origin/main", ahead: 0, behind: 0 });
  });

  it("识别脱离 HEAD", () => {
    const parsed = parseBranchHeader("# branch.head (detached)");
    expect(parsed.detached).toBe(true);
    expect(parsed.head).toBeNull();
  });

  it("从 --git-dir 识别 linked worktree", () => {
    // 真实输出:主 checkout 是 ".git",linked worktree 是 .../.git/worktrees/<name>
    expect(isWorktreeGitDir("/Users/u/repo/.git/worktrees/wt-probe")).toBe(true);
    expect(isWorktreeGitDir(".git")).toBe(false);
    expect(isWorktreeGitDir(null)).toBe(false);
  });

  it("解析本地分支列表", () => {
    expect(parseLocalBranches("main\nfeat/x\n\n")).toEqual(["main", "feat/x"]);
  });

  it("isClean 以 changedFiles 为准", () => {
    expect(isClean({ hasRepository: true, changedFiles: 0 })).toBe(true);
    expect(isClean({ hasRepository: true, changedFiles: 3 })).toBe(false);
    expect(isClean(NO_REPOSITORY)).toBe(true);
  });
});

describe("git-summary 读取", () => {
  /// 按 args[0..1] 派发假 stdout。
  function fakeClient(table) {
    return {
      git: vi.fn(async (cwd, args) => {
        const key = args.slice(0, 2).join(" ");
        for (const [prefix, value] of Object.entries(table)) {
          if (key.startsWith(prefix)) {
            return value === null ? { exitCode: 1, stdout: "", stderr: "no" } : { exitCode: 0, stdout: value, stderr: "" };
          }
        }
        return { exitCode: 1, stdout: "", stderr: "unhandled " + key };
      })
    };
  }

  it("非 git 目录回 NO_REPOSITORY,且不再发后续命令", async () => {
    // 这是入口「整个不渲染」的依据,也是省掉六条注定失败命令的地方。
    const client = fakeClient({ "rev-parse --is-inside-work-tree": null });
    const summary = await createGitSummaryReader(client).summary("/tmp/plain");
    expect(summary).toEqual(NO_REPOSITORY);
    expect(client.git).toHaveBeenCalledTimes(1);
  });

  it("聚合一份完整摘要", async () => {
    const client = fakeClient({
      "rev-parse --is-inside-work-tree": "true\n",
      "status --porcelain=v2": "# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0",
      "diff --numstat": "5\t2\ta.txt",
      "branch --format": "main\nfeat/x",
      "rev-parse --git-dir": "/repo/.git/worktrees/wt"
    });
    const summary = await createGitSummaryReader(client).summary("/repo");
    expect(summary).toMatchObject({
      hasRepository: true, head: "main", added: 5, removed: 2, changedFiles: 1,
      localBranches: ["main", "feat/x"], isWorktree: true
    });
    expect(summary.upstream.ahead).toBe(1);
    expect(client.git).toHaveBeenCalledWith("/repo", ["diff", "--numstat", "-z"]);
  });

  it("单条命令失败不让整份摘要失败", async () => {
    // 空仓库没有分支 ref,branch --format 会失败;入口仍要能显示。
    const client = fakeClient({
      "rev-parse --is-inside-work-tree": "true\n",
      "status --porcelain=v2": "# branch.head main",
      "diff --numstat": null,
      "branch --format": null,
      "rev-parse --git-dir": ".git"
    });
    const summary = await createGitSummaryReader(client).summary("/repo");
    expect(summary.hasRepository).toBe(true);
    expect(summary.head).toBe("main");
    expect(summary.localBranches).toEqual([]);
    expect(summary.changedFiles).toBe(0);
  });

  it("宿主代理不可用时向上抛,让入口整体隐藏", async () => {
    const err = Object.assign(new Error("no daemon"), { isUnsupported: true });
    const client = { git: vi.fn().mockRejectedValue(err) };
    await expect(createGitSummaryReader(client).summary("/repo")).rejects.toThrow("no daemon");
  });

  it("upstreamState 默认先 fetch", async () => {
    const client = fakeClient({
      "fetch --prune": "",
      "status --porcelain=v2": "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -4"
    });
    const state = await createGitSummaryReader(client).upstreamState("/repo");
    expect(client.git.mock.calls.some((c) => c[1][0] === "fetch")).toBe(true);
    expect(state).toEqual({ hasRemote: true, ref: "origin/main", ahead: 0, behind: 4 });
  });

  it("fetch 失败仍按磁盘 refs 给出计数 —— 离线只退化成旧数字", async () => {
    const client = fakeClient({
      "fetch --prune": null,
      "status --porcelain=v2": "# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0"
    });
    const state = await createGitSummaryReader(client).upstreamState("/repo");
    expect(state.ahead).toBe(2);
  });

  it("可以跳过 fetch(失败重试后再读时用)", async () => {
    const client = fakeClient({ "status --porcelain=v2": "# branch.head main" });
    await createGitSummaryReader(client).upstreamState("/repo", { fetch: false });
    expect(client.git.mock.calls.some((c) => c[1][0] === "fetch")).toBe(false);
  });
});

describe("worktree-occupancy", () => {
  const worktrees = [
    { path: "/repo", branch: "main", detached: false, bare: false, head: "a" },
    { path: "/repo-wt", branch: "feat/x", detached: false, bare: false, head: "b" },
    { path: "/repo-det", branch: null, detached: true, bare: false, head: "c" }
  ];

  it("排除当前目录 —— 当前分支不能把自己标成被占用", () => {
    const map = occupancyMap(worktrees, "/repo");
    expect(map.has("main")).toBe(false);
    expect(map.get("feat/x")).toEqual({ path: "/repo-wt", displayName: "repo-wt" });
  });

  it("detached 的 worktree 不占用任何分支名", () => {
    expect([...occupancyMap(worktrees, "/repo").keys()]).toEqual(["feat/x"]);
  });

  it("尾部斜杠不影响当前目录的比较", () => {
    expect(occupancyMap(worktrees, "/repo/").has("main")).toBe(false);
  });

  it("displayName 取路径最后一段", () => {
    expect(worktreeDisplayName("/Users/u/some/wt-name")).toBe("wt-name");
    expect(worktreeDisplayName("/Users/u/some/wt-name/")).toBe("wt-name");
  });

  it("可直接从 porcelain 原文折出占用表", () => {
    const stdout = [
      "worktree /repo", "HEAD aaa", "branch refs/heads/main", "",
      "worktree /repo-wt", "HEAD bbb", "branch refs/heads/feat/x", ""
    ].join("\n");
    const map = occupancyFromStdout(stdout, "/repo");
    expect(map.get("feat/x").displayName).toBe("repo-wt");
  });
});
