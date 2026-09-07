// 聊天区右上角的 Git 入口:分支 + 改动量,点开是分支选择 popover。
//
// 对齐 macos/Sources/DSHMacKit/Components/Conversation/WorkspaceGitAction.swift
// 与 BranchSelectionMenu.swift,逐条包括这些**刻意**的行为:
//
//   - 不是 git 仓库(或宿主代理不可用)→ **整个入口不渲染**。入口的全部内容都是
//     git 状态,没有仓库既没有可报告的也没有可切换的,画一个空图标只会打开一个
//     空菜单。
//   - 干净工作树不显示 ±行数。
//   - 图标区分两种位置:linked worktree 用「堆叠」,普通 checkout 用「分支」。
//   - popover 自上而下:当前分支行(点击原地展开列表)→ 搜索框(分支 > 8 才有)
//     → 分支列表 → 新建分支 → push(ahead>0)→ pull(behind>0)。
//   - 被其他 worktree 占用的分支置灰并标出占用者:git 本就拒绝这种 checkout。
//   - 点当前分支不跑 git,直接关闭。
//   - 失败时 **popover 保持打开**,用 toast 报错,好让用户重试;成功才关闭。
//   - 新建分支不在 popover 里直接开模态:popover 还在拆除时开的模态不会出现,
//     所以先关 popover,再开。
//
// 数据刷新由 app 层驱动(见 refresh()),不在本模块内部定时拉 —— 与 Mac 把读取
// 放在 ConversationRoot 而不是入口自身的理由相同:入口在没有 summary 时不存在,
// 挂在它上面的定时器永远不会跑,入口会永久隐藏。
import { t } from "../../shared/i18n.js";
import { isClean } from "../../features/host-proxy/git-summary.js";
import { occupancyMap } from "../../features/host-proxy/worktree-occupancy.js";
import { ICON_WORKTREE, ICON_BRANCH, escapeHtml, row } from "./git-entry-view.js";

/// 超过这个数量才给搜索框(Mac: searchThreshold = 8)。
const SEARCH_THRESHOLD = 8;

/**
 * @param trigger  header 里的入口按钮(#git-entry-btn)。
 * @param menu     popover 容器(#git-entry-menu)。
 * @param deps     { summaryReader, gitService, getCwd, showToast, onWorkingTreeChanged, promptBranchName }
 */
export function mountGitEntry(trigger, menu, deps) {
  let summary = null;
  let occupancy = new Map();
  let expanded = false;
  let query = "";
  let pendingBranch = null;
  let syncing = null;
  let open = false;
  // 会话/工作目录切换时,上一次 refresh 的 await 可能还在飞。generation 让
  // 迟到的旧回包无法把上一个目录的 summary/occupancy 写进当前入口
  // (对齐 Mac 的 GitSummaryRequestTracker:token 与 cwd 同时校验)。
  let refreshGeneration = 0;

  const cwd = () => deps.getCwd?.() || null;

  // ------------------------------------------------------------ trigger

  function paintTrigger() {
    // 与 Mac 的 `if let summary, summary.hasRepository` 等价:两者任一不成立
    // 就当入口不存在,而不是显示一个禁用态。
    if (!summary?.hasRepository) {
      trigger.hidden = true;
      return;
    }
    trigger.hidden = false;
    const branch = summary.head || (summary.detached ? t("git.detached") : t("git.noCommits"));
    trigger.querySelector(".git-entry-icon").innerHTML = summary.isWorktree ? ICON_WORKTREE : ICON_BRANCH;
    trigger.querySelector(".git-entry-branch").textContent = branch;
    const stat = trigger.querySelector(".git-entry-stat");
    if (isClean(summary)) {
      stat.hidden = true;
    } else {
      stat.hidden = false;
      trigger.querySelector(".git-entry-added").textContent = `+${summary.added}`;
      // 减号用 U+2212,与 Mac 一致:ASCII 连字符在数字旁边偏细偏矮。
      trigger.querySelector(".git-entry-removed").textContent = `−${summary.removed}`;
    }
    trigger.title = tooltip();
    trigger.setAttribute("aria-label", tooltip());
  }

  /// 把简短的标签展开成整句,包含标签本身没说的「干净」这一种情况。
  function tooltip() {
    const branch = summary.head || t("git.noCommits");
    const action = t("branch.switchTooltip");
    if (isClean(summary)) return `${action} · ${branch} · ${t("git.clean")}`;
    const files = t("git.changedFiles", { count: summary.changedFiles });
    return `${action} · ${branch} · ${files} +${summary.added} −${summary.removed}`;
  }

  // ------------------------------------------------------------- popover

  function switchable() {
    return (summary?.localBranches ?? []).filter((b) => b !== summary.head);
  }

  function filtered() {
    const needle = query.trim().toLowerCase();
    const all = switchable();
    if (!needle) return all;
    return all.filter((b) => b.toLowerCase().includes(needle));
  }

  function render() {
    if (!summary?.hasRepository) {
      menu.innerHTML = "";
      return;
    }
    const canExpand = switchable().length > 0;
    const head = summary.head;
    let html = "";

    if (head) {
      html += row({
        id: "git-current",
        name: head,
        icon: summary.isWorktree ? ICON_WORKTREE : ICON_BRANCH,
        trailing: canExpand ? (expanded ? "▾" : "▸") : "",
        disabled: !canExpand
      });
      if (expanded) {
        html += `<div class="git-sep"></div>`;
        if (switchable().length > SEARCH_THRESHOLD) {
          html += `<div class="git-search"><input class="set-input" id="git-search" type="text" `
            + `value="${escapeHtml(query)}" placeholder="${escapeHtml(t("branch.searchPlaceholder"))}" /></div>`;
        }
        const rows = filtered();
        if (!rows.length) {
          html += `<div class="git-empty">${escapeHtml(switchable().length ? t("branch.noMatches") : t("branch.empty"))}</div>`;
        } else {
          html += `<div class="git-list">` + rows.map((branch, index) => {
            const holder = occupancy.get(branch);
            return row({
              id: `git-branch-${index}`,
              name: branch,
              // 占用者名字是次要信息:它解释这行为何不可点,本身不是可操作项。
              trailing: holder ? holder.displayName : (pendingBranch === branch ? "…" : ""),
              disabled: Boolean(holder) || pendingBranch !== null,
              title: holder ? t("branch.occupiedByWorktree", { name: holder.displayName }) : ""
            });
          }).join("") + `</div>`;
        }
      }
    }

    html += `<div class="git-sep"></div>`;
    html += row({ id: "git-create", name: t("branch.createNew"), icon: "+" });

    // push / pull 排在新建之后:它们作用于「已经检出的这个分支」,而不是
    // 「检出哪个分支」。
    const up = summary.upstream;
    if (head && up?.hasRemote && up.ahead > 0) {
      html += row({ id: "git-push", name: t("branch.push"), icon: "↑", trailing: syncing === "push" ? "…" : String(up.ahead) });
    }
    if (head && up?.hasRemote && up.behind > 0) {
      html += row({ id: "git-pull", name: t("branch.pull"), icon: "↓", trailing: syncing === "pull" ? "…" : String(up.behind) });
    }

    menu.innerHTML = html;
    if (pendingBranch || syncing) {
      for (const button of menu.querySelectorAll("button")) button.disabled = true;
    }
    bind();
  }

  function bind() {
    menu.querySelector("#git-current")?.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
    const search = menu.querySelector("#git-search");
    search?.addEventListener("input", (event) => {
      query = event.target.value;
      render();
      const fresh = menu.querySelector("#git-search");
      if (fresh) {
        fresh.focus();
        fresh.setSelectionRange(fresh.value.length, fresh.value.length);
      }
    });
    filtered().forEach((branch, index) => {
      menu.querySelector(`#git-branch-${index}`)?.addEventListener("click", () => choose(branch));
    });
    menu.querySelector("#git-create")?.addEventListener("click", () => createBranch());
    menu.querySelector("#git-push")?.addEventListener("click", () => sync("push"));
    menu.querySelector("#git-pull")?.addEventListener("click", () => sync("pull"));
  }

  function close() {
    try { menu.hidePopover(); } catch { /* jsdom 无 popover API */ }
    open = false;
  }

  // ------------------------------------------------------------- actions

  /// 切换分支。点到当前分支是个 no-op —— 直接关闭,绝不跑 git。
  async function choose(branch) {
    if (pendingBranch || syncing) return;
    if (branch === summary.head) {
      close();
      return;
    }
    pendingBranch = branch;
    render();
    try {
      await deps.gitService.checkout(cwd(), branch);
      close();
      await deps.onWorkingTreeChanged?.();
    } catch (error) {
      // 保持打开:这一行还在,好重试。
      deps.showToast?.(t("branch.checkoutFailed", { reason: error?.message || String(error) }));
    } finally {
      pendingBranch = null;
      await refresh({ fetch: false });
    }
  }

  /// 新建分支。先关 popover 再开输入框(见文件头说明)。
  async function createBranch() {
    close();
    const name = await deps.promptBranchName?.();
    if (!name) return;
    try {
      await deps.gitService.checkout(cwd(), name, { create: true });
      deps.showToast?.(t("branch.created", { name }));
      await deps.onWorkingTreeChanged?.();
    } catch (error) {
      deps.showToast?.(t("branch.createFailed", { reason: error?.message || String(error) }));
    }
    await refresh({ fetch: false });
  }

  async function sync(action) {
    if (pendingBranch || syncing) return;
    syncing = action;
    render();
    try {
      if (action === "push") await deps.gitService.push(cwd());
      else await deps.gitService.pull(cwd());
      deps.showToast?.(t(action === "push" ? "branch.pushed" : "branch.pulled"));
      close();
      await deps.onWorkingTreeChanged?.();
    } catch (error) {
      deps.showToast?.(t(action === "push" ? "branch.pushFailed" : "branch.pullFailed", { reason: error?.message || String(error) }));
    } finally {
      syncing = null;
      // 失败后不再 fetch:refs 刚查过,答案不会变。
      await refresh({ fetch: false });
    }
  }

  // ------------------------------------------------------------- refresh

  /// 重读摘要与 worktree 占用。由 app 层在会话/工作目录变化时调用。
  async function refresh({ fetch = false } = {}) {
    const generation = ++refreshGeneration;
    const dir = cwd();
    // 每次 await 之后都要重新确认:generation 没被后来的 refresh 顶掉,且
    // 当前工作目录仍是发起这次读取时的那个。任一不成立就整个丢弃 ——
    // 旧目录的 git 状态画到新会话上,比暂时没有状态更糟。
    const current = () => generation === refreshGeneration && cwd() === dir;
    if (!dir) {
      summary = null;
      paintTrigger();
      return;
    }
    let next = null;
    try {
      next = await deps.summaryReader.summary(dir);
      if (!current()) return;
      if (next.hasRepository && fetch) {
        const up = await deps.summaryReader.upstreamState(dir, { fetch: true });
        if (!current()) return;
        if (up) next = { ...next, upstream: up };
      }
    } catch {
      // 宿主代理不可用 → 与「非仓库」同样静默隐藏,不打扰用户。
      if (!current()) return;
      next = null;
    }
    let nextOccupancy = occupancy;
    if (next?.hasRepository) {
      try {
        const worktrees = await deps.gitService.worktrees(dir);
        if (!current()) return;
        nextOccupancy = occupancyMap(worktrees, dir);
      } catch {
        if (!current()) return;
        nextOccupancy = new Map();
      }
    }
    summary = next;
    occupancy = nextOccupancy;
    paintTrigger();
    if (open) render();
  }

  // popover 打开时才拉 upstream:fetch 有网络代价,不该跟着每次会话切换跑。
  menu.addEventListener("toggle", (event) => {
    open = event.newState === "open";
    if (!open) {
      expanded = false;
      query = "";
      return;
    }
    render();
    refresh({ fetch: true });
  });

  return { refresh, paintTrigger, get summary() { return summary; } };
}
