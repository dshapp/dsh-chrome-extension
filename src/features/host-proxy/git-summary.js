// Git 摘要:聊天区右上角那个入口所需要的全部 git 事实,聚成一个对象。
//
// 对齐 macos/Sources/DSHMacKit/State/GitSummaryStore.swift 的 GitSummary。字段
// 一一对应,因为入口与 popover 的「出现时机」全部由这些字段决定 —— 少一个字段
// 就得在 UI 层临时再发一次 git,那会让入口在首帧闪烁。
//
// 解析全部走 porcelain / numstat 这类有版本承诺的格式,不碰人类可读输出。
// 纯函数单独导出,便于用真实 git 输出做单测而不需要仓库。

/// 没有仓库时的摘要。
///
/// 「不是 git 仓库」是一种正常状态而非错误:调用方据此**整个入口不渲染**,
/// 与 Mac 的 `hasRepository == false` 分支一致。
export const NO_REPOSITORY = Object.freeze({
  hasRepository: false,
  head: null,
  detached: false,
  added: 0,
  removed: 0,
  changedFiles: 0,
  localBranches: [],
  isWorktree: false,
  upstream: null
});

/// 解析 `git diff --numstat HEAD`；也兼容 `-z` 的 NUL 分隔格式，便于复用与测试。
///
/// 二进制文件 git 用 `-\t-` 表示「没有 diff 内容」,不能当 0 行处理 —— 那会让
/// 一个二进制改动在计数上凭空消失。这里单独标记并计入 changedFiles。
export function parseNumstat(stdout) {
  let added = 0;
  let removed = 0;
  let files = 0;
  const text = String(stdout ?? "");
  const records = text.includes("\0") ? text.split("\0") : text.split("\n");
  for (let index = 0; index < records.length; index += 1) {
    const header = records[index];
    if (!header) continue;
    const fields = header.split("\t");
    if (fields.length < 3) continue;
    const [a, r] = fields;
    // `-z` 的 rename/copy 记录把 header path 留空，随后分别给出旧、新路径。
    // 摘要只计文件数，无需保留路径，但仍必须消费两个字段，避免把它们误当记录。
    if (text.includes("\0") && fields.slice(2).join("\t") === "") index += 2;
    files += 1;
    if (a === "-" || r === "-") continue; // 二进制:计文件数,不计行数
    added += Number.parseInt(a, 10) || 0;
    removed += Number.parseInt(r, 10) || 0;
  }
  return { added, removed, files };
}

/// 从 `status --porcelain=v2 --branch` 的头部行取分支与 ahead/behind。
///
/// `# branch.ab +2 -3` 里 behind 是负号形式,取绝对值 —— UI 只关心数量。
/// 没有 `# branch.upstream` 行即表示没有上游,此时 push/pull 两行都不出现。
export function parseBranchHeader(stdout) {
  let head = null;
  let detached = false;
  let upstreamRef = null;
  let ahead = 0;
  let behind = 0;
  let sawAb = false;
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") detached = true;
      else head = value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstreamRef = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      sawAb = true;
      const [a, b] = line.slice("# branch.ab ".length).trim().split(" ");
      ahead = Math.abs(Number.parseInt(a, 10) || 0);
      behind = Math.abs(Number.parseInt(b, 10) || 0);
    }
  }
  // hasRemote 以「有 upstream 行」为准而不是「ab 行存在」:没有上游时 git 根本
  // 不打印 ab 行,两者都缺;但有上游而计数为 0 时 ab 行仍在。
  const upstream = upstreamRef ? { hasRemote: true, ref: upstreamRef, ahead, behind } : null;
  return { head, detached, upstream, sawAb };
}

/// `--git-dir` 指向 `.../.git/worktrees/<name>` 时,当前目录是 linked worktree。
///
/// 与 Mac 同法。用这个而不是「路径不等于 toplevel」:后者在符号链接与大小写不
/// 敏感文件系统上会误判。
export function isWorktreeGitDir(gitDir) {
  return String(gitDir ?? "").includes("/worktrees/");
}

/// 本地分支列表。`branch --format` 每行一个短名。
export function parseLocalBranches(stdout) {
  const names = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const name = line.trim();
    if (name) names.push(name);
  }
  return names;
}

export function createGitSummaryReader(client, { warn = (...args) => console.warn(...args) } = {}) {
  // 已经报过的宿主拒绝原因。每次切会话都会重读摘要,同一个原因只报一次。
  const reported = new Set();

  /// 跑一条 git,只回 stdout;非零退出回 null。
  ///
  /// 这里刻意不抛错:摘要是由六七条命令拼出来的,任何一条在某些仓库状态下
  /// 都可能失败(空仓库没有分支 ref、没有上游、非仓库目录),而调用方要的是
  /// 「尽可能填满的摘要」,不是第一条失败就整体放弃。
  async function read(cwd, args) {
    try {
      const result = await client.git(cwd, args);
      return result?.exitCode === 0 ? String(result.stdout ?? "") : null;
    } catch (error) {
      // 宿主代理整体不可用要让调用方知道(入口需要整体隐藏),所以只吞命令级失败。
      if (error?.isUnsupported) throw error;
      // 但宿主**拒绝执行**(HTTP 4xx/5xx)与 git 自己非零退出不是一回事:前者
      // 照样会让入口当成「不是仓库」而隐藏,却没有任何 git 输出可看。Windows 上
      // daemon 只认 $HOME 时,每条 /host/git 都以 400 "cannot determine HOME"
      // 被拒,入口永远不出现且毫无痕迹。至少在控制台留下宿主给的原因。
      const reason = `${error?.status ?? "?"} ${error?.message ?? error}`;
      if (!reported.has(reason)) {
        reported.add(reason);
        warn(`[git-entry] host refused \`git ${args.join(" ")}\` in ${cwd}: ${reason}`);
      }
      return null;
    }
  }

  return {
    /// 读一个工作目录的完整摘要。
    ///
    /// 先判是不是仓库:不是就直接回 NO_REPOSITORY,省掉后面六条注定失败的命令。
    async summary(cwd) {
      if (!cwd) return NO_REPOSITORY;
      const inside = await read(cwd, ["rev-parse", "--is-inside-work-tree"]);
      if (inside === null || inside.trim() !== "true") return NO_REPOSITORY;

      // 其余读取互不依赖,并发发出:串行会让切换会话时入口明显迟滞。
      //
      // 两条刻意与 Mac 的 GitRepository.lineCounts 保持一致,否则 chip 会退化成
      // 只剩分支名(它正是用户看到的样子):
      //   - 比对 HEAD 而不是工作树对 index:只有比到 HEAD 才把**已暂存**的改动
      //     算进来,git add 之后不带 HEAD 就是空的。
      //   - 不加 `-z`:daemon 的 diff 允许项(GIT_ALLOWED_OPTIONS)没有它,传了会
      //     被 `/host/git` 以 400 拒掉,而 read() 把命令级失败吞成 null,于是
      //     `--numstat` 的正常换行输出拿不到,摘要静默变成干净。
      //     换行格式由 parseNumstat 处理,它同时兼容 `-z` 的 NUL 形式。
      const [statusOut, numstatOut, branchesOut, gitDirOut] = await Promise.all([
        read(cwd, ["status", "--porcelain=v2", "--branch"]),
        read(cwd, ["diff", "--numstat", "HEAD"]),
        read(cwd, ["branch", "--format=%(refname:short)"]),
        read(cwd, ["rev-parse", "--git-dir"])
      ]);

      const { head, detached, upstream } = parseBranchHeader(statusOut);
      const { added, removed, files } = parseNumstat(numstatOut);
      return {
        hasRepository: true,
        head,
        detached,
        added,
        removed,
        changedFiles: files,
        localBranches: parseLocalBranches(branchesOut),
        isWorktree: isWorktreeGitDir(gitDirOut),
        upstream
      };
    },

    /// 重新读 ahead/behind。
    ///
    /// 默认先 fetch,让 behind 反映**现在的**远端而不是上次 fetch 时的快照。
    /// fetch 失败(离线)不算失败:仍按磁盘上的 refs 算,于是 popover 退化成
    /// 旧数字,而不是把 push/pull 两行整个弄丢 —— 与 Mac 的降级语义一致。
    async upstreamState(cwd, { fetch = true } = {}) {
      if (!cwd) return null;
      if (fetch) await read(cwd, ["fetch", "--prune"]);
      const statusOut = await read(cwd, ["status", "--porcelain=v2", "--branch"]);
      return parseBranchHeader(statusOut).upstream;
    }
  };
}

/// 工作树干净 = 没有任何与 HEAD 不同的路径。
///
/// 入口据此决定是否显示 `+a −r`(Mac: `isClean`)。
export function isClean(summary) {
  return !summary?.hasRepository || summary.changedFiles === 0;
}
