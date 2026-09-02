import { describe, it, expect, vi } from "vitest";
import {
  parseStatus,
  parseWorktrees,
  parseBranches,
  parseLog,
  createGitService,
  WRITE_ACTIONS
} from "../src/features/host-proxy/git-service.js";

const FS = "\u001f";

describe("git-service 解析", () => {
  it("解析真实的 status --porcelain=v2 --branch 输出", () => {
    // 取自 dsh-chrome-control 仓库的真实输出。
    const stdout = [
      "# branch.oid cd40f9e2f6ae28866e6e9c97e48fbb34193d1bb6",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 330a5d4 330a5d4 daemon/src/main.rs",
      "1 M. N... 100644 100644 100644 71cacbf 71cacbf daemon/src/server.rs",
      "? DAEMON_HTTP_PROXY_PLAN.md"
    ].join("\n");
    const status = parseStatus(stdout);
    expect(status.branch).toBe("main");
    expect(status.upstream).toBe("origin/main");
    expect(status.ahead).toBe(2);
    // behind 在 git 里是 "-3";UI 只要数量。
    expect(status.behind).toBe(3);
    expect(status.detached).toBe(false);
    expect(status.entries).toHaveLength(3);
    expect(status.entries[0]).toEqual({ path: "daemon/src/main.rs", staged: false, unstaged: true, kind: "changed" });
    expect(status.entries[1]).toEqual({ path: "daemon/src/server.rs", staged: true, unstaged: false, kind: "changed" });
    expect(status.entries[2].kind).toBe("untracked");
  });

  it("空仓库(无提交)不崩", () => {
    const status = parseStatus("# branch.oid (initial)\n# branch.head main\n");
    expect(status.branch).toBe("main");
    expect(status.upstream).toBeNull();
    expect(status.entries).toEqual([]);
  });

  it("识别脱离 HEAD", () => {
    const status = parseStatus("# branch.oid abc\n# branch.head (detached)\n");
    expect(status.detached).toBe(true);
    expect(status.branch).toBeNull();
  });

  it("重命名条目只取新路径", () => {
    // 类型 2 的路径段是 "新路径<TAB>旧路径",按空格切分会把两者混在一起。
    const stdout = "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.js\told/name.js";
    const status = parseStatus(stdout);
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0].path).toBe("new/name.js");
  });

  it("含空格的路径不被截断", () => {
    const stdout = "1 .M N... 100644 100644 100644 aaa bbb my dir/my file.txt";
    expect(parseStatus(stdout).entries[0].path).toBe("my dir/my file.txt");
  });

  it("冲突条目标记为 conflict", () => {
    const stdout = "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt";
    const status = parseStatus(stdout);
    expect(status.entries[0]).toMatchObject({ path: "conflicted.txt", kind: "conflict" });
  });

  it("解析真实的 worktree list --porcelain 输出", () => {
    const stdout = [
      "worktree /Users/u/repo",
      "HEAD cd40f9e2f6ae28866e6e9c97e48fbb34193d1bb6",
      "branch refs/heads/main",
      "",
      "worktree /Users/u/repo-wt",
      "HEAD aaaa",
      "detached",
      ""
    ].join("\n");
    const worktrees = parseWorktrees(stdout);
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toEqual({
      path: "/Users/u/repo",
      head: "cd40f9e2f6ae28866e6e9c97e48fbb34193d1bb6",
      branch: "main",
      bare: false,
      detached: false
    });
    expect(worktrees[1].detached).toBe(true);
    expect(worktrees[1].branch).toBeNull();
  });

  it("bare 仓库的 worktree 被标出", () => {
    const worktrees = parseWorktrees("worktree /Users/u/bare\nbare\n");
    expect(worktrees[0].bare).toBe(true);
  });

  it("worktree 输出为空时回空数组", () => {
    expect(parseWorktrees("")).toEqual([]);
  });

  it("解析 branch --format 输出并标出当前分支", () => {
    const stdout = " \tfeat/x\torigin/feat/x\n*\tmain\torigin/main\n \tlocal-only\t";
    const branches = parseBranches(stdout);
    expect(branches).toHaveLength(3);
    expect(branches[0]).toEqual({ name: "feat/x", current: false, upstream: "origin/feat/x" });
    expect(branches[1]).toEqual({ name: "main", current: true, upstream: "origin/main" });
    expect(branches[2].upstream).toBeNull();
  });

  it("解析 log,且标题里的空格与制表符不破坏切分", () => {
    const line = ["abc123", "abc", "horace", "2 hours ago", "fix: a  b\tc"].join(FS);
    const commits = parseLog(line);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      hash: "abc123",
      short: "abc",
      author: "horace",
      when: "2 hours ago",
      subject: "fix: a  b\tc"
    });
  });
});

describe("git-service 命令", () => {
  const okClient = (stdout = "") => ({ git: vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "" }) });

  it("status 用 porcelain=v2,不解析人类可读输出", async () => {
    const client = okClient("# branch.head main");
    await createGitService(client).status("/home/u/r");
    expect(client.git).toHaveBeenCalledWith("/home/u/r", ["status", "--porcelain=v2", "--branch"]);
  });

  it("log 显式带上条数上限", async () => {
    const client = okClient("");
    await createGitService(client).log("/home/u/r", 5);
    const args = client.git.mock.calls[0][1];
    expect(args[0]).toBe("log");
    expect(args).toContain("-n");
    expect(args[args.indexOf("-n") + 1]).toBe("5");
  });

  it("pull 用 --ff-only —— 这个面板没有解冲突的能力", async () => {
    const client = okClient("");
    await createGitService(client).pull("/home/u/r");
    expect(client.git).toHaveBeenCalledWith("/home/u/r", ["pull", "--ff-only"]);
  });

  it("branchDelete 用 -d 而非 -D", async () => {
    const client = okClient("");
    await createGitService(client).branchDelete("/home/u/r", "feat/x");
    expect(client.git).toHaveBeenCalledWith("/home/u/r", ["branch", "-d", "feat/x"]);
  });

  it("非零退出抛错,且错误文案就是 git 的 stderr", async () => {
    const client = { git: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "error: pathspec 'nope' did not match" }) };
    const error = await createGitService(client).checkout("/home/u/r", "nope").catch((e) => e);
    expect(error.name).toBe("GitCommandError");
    expect(error.message).toBe("error: pathspec 'nope' did not match");
    expect(error.exitCode).toBe(1);
  });

  it("每个写操作都有确认文案 —— 漏一个就等于它没有确认", () => {
    const service = createGitService(okClient(""));
    for (const action of Object.keys(WRITE_ACTIONS)) {
      expect(typeof service[action], action).toBe("function");
      expect(WRITE_ACTIONS[action].labelKey, action).toBeTruthy();
    }
    // 反向:服务上的写方法都必须在表里登记。
    for (const name of ["checkout", "fetch", "pull", "push", "worktreeAdd", "worktreeRemove", "branchDelete"]) {
      expect(WRITE_ACTIONS[name], name).toBeDefined();
    }
  });
});
