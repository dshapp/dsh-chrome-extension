// Git 服务:把 daemon 的 /host/git 包成一组具名操作,并把 git 的机器可读输出
// 解析成 UI 用的数据。
//
// 解析全部走 porcelain 格式(`--porcelain=v2`、`worktree list --porcelain`、
// `--pretty=format:`),不解析人类可读输出 —— 后者随 git 版本和用户 config
// (color、i18n)变化,是长期故障源。
//
// 解析函数是纯函数并单独导出,便于用真实 git 输出做单测而不需要仓库。

/// 字段分隔符:ASCII UNIT SEPARATOR。提交信息里不可能出现,所以标题里的
/// 空格、制表符、引号都不会破坏切分。
const FS = "\u001f";

/// log 每次最多取多少条。daemon 侧也会兜底加 -n,这里给出明确意图。
const LOG_LIMIT = 100;

/// 写操作清单:UI 用它决定确认文案与危险级别。
///
/// 确认完全在扩展侧完成(daemon 收到请求即执行),所以这张表是用户看到
/// 「你确定吗」的唯一来源;漏掉一个动作就等于它没有确认。
export const WRITE_ACTIONS = Object.freeze({
  checkout: { labelKey: "git.confirmCheckout", danger: "normal" },
  fetch: { labelKey: "git.confirmFetch", danger: "safe" },
  pull: { labelKey: "git.confirmPull", danger: "normal" },
  push: { labelKey: "git.confirmPush", danger: "high" },
  worktreeAdd: { labelKey: "git.confirmWorktreeAdd", danger: "normal" },
  worktreeRemove: { labelKey: "git.confirmWorktreeRemove", danger: "high" },
  branchDelete: { labelKey: "git.confirmBranchDelete", danger: "high" }
});

/// 解析 `git status --porcelain=v2 --branch`。
///
/// v2 而非 v1:v1 不给 ahead/behind,也不区分重命名的两个路径。
export function parseStatus(stdout) {
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, entries: [] };
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      // git 用字面量 "(detached)" 表示脱离 HEAD,不是分支名。
      if (head === "(detached)") result.detached = true;
      else result.branch = head;
    } else if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const [ahead, behind] = line.slice("# branch.ab ".length).trim().split(" ");
      result.ahead = Number.parseInt(ahead, 10) || 0;
      // behind 形如 "-3";取绝对值,UI 只关心数量。
      result.behind = Math.abs(Number.parseInt(behind, 10) || 0);
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // 1 = 普通变更,2 = 重命名/复制。两者的 XY 状态码在同一位置。
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      // 重命名行的路径段是 "新路径<TAB>旧路径",只取新路径。
      const pathField = parts.slice(line.startsWith("2 ") ? 9 : 8).join(" ");
      const path = pathField.split("\t")[0];
      if (path) result.entries.push({ path, staged: xy[0] !== ".", unstaged: xy[1] !== ".", kind: "changed" });
    } else if (line.startsWith("? ")) {
      result.entries.push({ path: line.slice(2), staged: false, unstaged: true, kind: "untracked" });
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      const path = parts.slice(10).join(" ");
      if (path) result.entries.push({ path, staged: false, unstaged: true, kind: "conflict" });
    }
  }
  return result;
}

/// 解析 `git worktree list --porcelain`。
///
/// 记录以空行分隔;`bare`/`detached` 是无值的独立行,所以不能一律按
/// "key value" 切分。
export function parseWorktrees(stdout) {
  const worktrees = [];
  let current = null;
  const flush = () => {
    if (current?.path) worktrees.push(current);
    current = null;
  };
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), head: null, branch: null, bare: false, detached: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return worktrees;
}

/// 解析 `git branch --format='%(HEAD)\t%(refname:short)\t%(upstream:short)'`。
export function parseBranches(stdout) {
  const branches = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [head, name, upstream] = line.split("\t");
    if (!name) continue;
    branches.push({ name, current: head?.trim() === "*", upstream: upstream?.trim() || null });
  }
  return branches;
}

/// 解析用 [FS] 分隔的 log 行。
export function parseLog(stdout) {
  const commits = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [hash, short, author, when, subject] = line.split(FS);
    if (!hash) continue;
    commits.push({ hash, short: short ?? "", author: author ?? "", when: when ?? "", subject: subject ?? "" });
  }
  return commits;
}

/// 子进程失败时,拼一条以 git 自己的话为主的错误。
///
/// 优先 stderr:那是 git 的原文,比任何我们自己编的措辞都有用。
function describeFailure(result) {
  const stderr = String(result?.stderr ?? "").trim();
  const stdout = String(result?.stdout ?? "").trim();
  return stderr || stdout || `git exited with ${result?.exitCode}`;
}

export function createGitService(client) {
  /// 跑一条命令;非零退出抛错,错误文案取自 git 的 stderr。
  async function run(cwd, args) {
    const result = await client.git(cwd, args);
    if (result?.exitCode !== 0) {
      const error = new Error(describeFailure(result));
      error.name = "GitCommandError";
      error.exitCode = result?.exitCode ?? null;
      error.stderr = result?.stderr ?? "";
      throw error;
    }
    return result;
  }

  return {
    async status(cwd) {
      const result = await run(cwd, ["status", "--porcelain=v2", "--branch"]);
      return parseStatus(result.stdout);
    },

    async branches(cwd) {
      const result = await run(cwd, ["branch", "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)"]);
      return parseBranches(result.stdout);
    },

    async worktrees(cwd) {
      const result = await run(cwd, ["worktree", "list", "--porcelain"]);
      return parseWorktrees(result.stdout);
    },

    async log(cwd, limit = LOG_LIMIT) {
      const format = `--pretty=format:%H${FS}%h${FS}%an${FS}%ar${FS}%s`;
      const result = await run(cwd, ["log", format, "-n", String(limit)]);
      return parseLog(result.stdout);
    },

    // ---- 写操作。调用方必须先完成用户确认(见 WRITE_ACTIONS)。----

    /// 切换分支;`create` 为真时新建并切换(`checkout -b`)。
    checkout(cwd, branch, { create = false } = {}) {
      return run(cwd, create ? ["checkout", "-b", branch] : ["checkout", branch]);
    },
    fetch(cwd) {
      return run(cwd, ["fetch", "--prune"]);
    },
    pull(cwd) {
      // --ff-only:普通 pull 可能产生合并提交或留下冲突待解,而这个面板没有
      // 解冲突的能力。快进不了就失败,让用户去终端处理。
      return run(cwd, ["pull", "--ff-only"]);
    },
    push(cwd) {
      return run(cwd, ["push"]);
    },
    worktreeAdd(cwd, path, branch) {
      const args = ["worktree", "add", path];
      if (branch) args.push(branch);
      return run(cwd, args);
    },
    worktreeRemove(cwd, path) {
      return run(cwd, ["worktree", "remove", path]);
    },
    branchDelete(cwd, branch) {
      // -d 而非 -D:未合并的分支删除会失败,这是想要的行为。
      return run(cwd, ["branch", "-d", branch]);
    }
  };
}
