// 哪些分支被**其他** worktree 占着。
//
// 对齐 macos/.../WorktreeOccupancy:git 规定一个分支同时只能在一个 worktree 里
// checkout,所以被别处占用的分支在 popover 里必须置灰 —— 让它可点只会换来一句
// git 的拒绝,用户还得自己看懂为什么。
//
// 排除当前目录本身:当前 worktree 持有的正是当前分支,把它算作「被占用」会让
// 当前分支自己变成不可选。
import { parseWorktrees } from "./git-service.js";

/// worktree 的展示名:取路径最后一段,与 Mac 的 displayName 一致。
export function worktreeDisplayName(path) {
  const trimmed = String(path ?? "").replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/// 规范化路径以便比较:统一分隔符、去掉尾部斜杠。
///
/// 不做 realpath —— 扩展里拿不到文件系统。但 Windows 上两边的拼写天然不同:
/// `worktree list` 一律输出 `C:/Users/…`,会话 cwd 却是 `C:\Users\…`;盘符
/// 大小写也可能不一致(Windows 路径本就不区分大小写)。所以反斜杠归一成
/// 正斜杠,有盘符的路径整体按不区分大小写比较。
function normalizePath(path) {
  const slashed = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:(\/|$)/.test(slashed) ? slashed.toLowerCase() : slashed;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

/// `branch → { path, displayName }`,不含 `currentCwd` 自己那一条。
export function occupancyMap(worktrees, currentCwd) {
  const map = new Map();
  for (const worktree of worktrees ?? []) {
    if (!worktree?.branch) continue; // detached 的 worktree 不占用任何分支名
    if (samePath(worktree.path, currentCwd)) continue;
    map.set(worktree.branch, { path: worktree.path, displayName: worktreeDisplayName(worktree.path) });
  }
  return map;
}

/// 直接从 `worktree list --porcelain` 的原文折出占用表。
export function occupancyFromStdout(stdout, currentCwd) {
  return occupancyMap(parseWorktrees(stdout), currentCwd);
}
