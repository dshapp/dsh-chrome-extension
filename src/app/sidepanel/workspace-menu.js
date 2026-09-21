// Header 的工作目录(workspace)下拉:决定历史列表的过滤范围与新建会话的归属。
// 会话的 cwd 在 session.create 时固定、之后不可改,所以这里只做两件事——
// 过滤历史 + 决定下一个新会话建在哪,绝不改动已有会话。
import { renderMenuItems } from "./sidepanel-overlays.js";
import { t } from "../../shared/i18n.js";

const STORAGE_KEY = "dsh_workspace_id";
const ALL_ID = "__all__";
const ADD_ID = "__add__";
// 「临时目录」过滤项:未挂到任何 workspace 的会话都建在宿主自己的 cwd 下
// (host 契约:"an omitted project uses the Host cwd")。它是一个真实存在的
// 目录,所以能像普通 workspace 一样精确过滤,而不是"不过滤"。
const TEMP_ID = "__temp__";

// storage 在扩展里是 chrome.storage.local;测试/普通页面里退回内存。
async function readStoredId() {
  try {
    const value = await chrome.storage.local.get([STORAGE_KEY]);
    return value?.[STORAGE_KEY] ?? null;
  } catch {
    return null;
  }
}

async function writeStoredId(workspaceId) {
  try {
    if (workspaceId) await chrome.storage.local.set({ [STORAGE_KEY]: workspaceId });
    else await chrome.storage.local.remove([STORAGE_KEY]);
  } catch {
    // storage 不可用时仅失去持久化,不影响本次会话内的选择。
  }
}

function basename(path) {
  return String(path || "").replace(/\/+$/, "").split("/").pop() || path || "";
}

/// @param hostCwd 读取宿主自身 cwd 的函数（来自 `$events` ready.host.home）。未选工作目录
///        的会话都落在这里,所以它就是「临时目录」这一项的过滤路径。
export function mountWorkspaceMenu(elements, deps, { onChange, showToast, hostCwd } = {}) {
  let workspaces = [];
  // null = 「全部」(不过滤);否则为选中的 workspaceId。
  let selectedId = null;
  // 当前会话 cwd 不属于任何 workspace 时,仅用于显示标签。
  let orphanCwd = null;
  // 菜单是被新建会话页的 hero chip 打开的(而不是头部那颗)。两颗共用同一个
  // popover,但首行语义不同,所以按打开者切文案。
  let heroMode = false;
  // 选中了「临时目录」这一项(与选中某个 workspace 互斥;两者都没有 = 全部)。
  let tempSelected = false;
  const followsWorkspaceState = typeof deps.workspaces?.subscribe === "function";

  function selected() {
    return workspaces.find((item) => item.workspaceId === selectedId) ?? null;
  }

  function label() {
    const current = selected();
    if (current) return current.title || basename(current.path);
    if (tempSelected) return t("workspace.temporary");
    if (orphanCwd) return basename(orphanCwd);
    return t("workspace.all");
  }

  /// 新建会话页 chip 的标签。同一份选择在两处含义不同:头部那颗是历史过滤器,
  /// 未选 = "全部"(不过滤);这颗决定"会话建在哪",未选 = 交给宿主的临时目录。
  /// 写成两个函数,免得一句"全部"被读成"新会话要建在所有目录里"。
  function heroLabel() {
    const current = selected();
    if (current) return current.title || basename(current.path);
    // hero 上「全部」和「临时目录」是同一件事:都不带归属参数创建。
    if (orphanCwd && !tempSelected) return basename(orphanCwd);
    return t("workspace.temporary");
  }

  /// 标题里那段工作目录前缀。它讲的是"当前会话在哪个目录",不是过滤器 ——
  /// 所以未选具体目录时说「临时目录」(会话真正会落在宿主 cwd),而不是「全部」。
  function badgeLabel() {
    const current = selected();
    if (current) return current.title || basename(current.path);
    if (orphanCwd) return basename(orphanCwd);
    return t("workspace.temporary");
  }

  function paint() {
    const current = selected();
    const title = current ? current.path : orphanCwd || t("workspace.title");
    // 头部那颗过滤 chip 已经不存在了(会话列表改成按工作区分组,不再按目录过滤),
    // 但这段代码仍要能在"有 chip"的宿主页面里跑 —— 所以两处都按可选处理。
    if (elements.hdrWorkspaceLabel) elements.hdrWorkspaceLabel.textContent = label();
    if (elements.hdrWorkspace) elements.hdrWorkspace.title = title;
    // 标题里的工作目录前缀:与上面同一份选择,只是永远按"会话归属"的说法呈现。
    // 只写自己这个 span,会话标题由历史浮层的 setActive 独立写。
    if (elements.hdrWorkspacePrefix) {
      elements.hdrWorkspacePrefix.textContent = badgeLabel();
    }
    // 新建会话页的工作目录 chip 与头部那颗是同一个选择,共用同一份 popover,
    // 所以文案/标题一起刷,避免两处显示不一致。
    const heroText = heroLabel();
    const heroTitle = current ? current.path : orphanCwd || t("workspace.temporaryHint");
    if (elements.heroWorkspaceLabel) elements.heroWorkspaceLabel.textContent = heroText;
    if (elements.heroWorkspace) elements.heroWorkspace.title = heroTitle;
  }

  function renderMenu() {
    // 首行在两种语境下是同一个"未选工作目录"状态,但说法不同:
    // 历史浮层里它是过滤器的"全部";新建会话页它决定会话建在哪 —— 那就是
    // 临时目录。用 heroMode 区分,避免一句话同时承担两种含义。
    const entries = [
      {
        id: ALL_ID,
        label: heroMode ? t("workspace.temporary") : t("workspace.all"),
        ...(heroMode ? { hint: t("workspace.temporaryHint") } : {})
      },
      // 头部(过滤器)语境才需要单独一行:「全部」是不过滤,「临时目录」是只看
      // 建在宿主 cwd 下的那些会话 —— 两者不是一回事。hero 语境下首行已经
      // 表示"建到临时目录",再列一行同义项只会让人以为有两种临时目录。
      ...(!heroMode && hostCwd?.()
        ? [{ id: TEMP_ID, label: t("workspace.temporary"), hint: hostCwd() }]
        : []),
      ...workspaces.map((item) => ({
        id: item.workspaceId,
        label: item.title || basename(item.path),
        hint: item.path,
        // 只有真实工作目录可拖:「全部」/「临时目录」/「添加目录…」是功能项,
        // 不属于这份可排序的名单。
        draggable: true
      })),
      { id: ADD_ID, label: t("workspace.add"), icon: "plus" }
    ];
    renderMenuItems(elements.workspaceMenu, entries, {
      selectedId: selectedId ?? (tempSelected ? TEMP_ID : ALL_ID),
      onSelect: (id) => handleSelect(id),
      onReorder: (movedId, beforeId) => void reorderWorkspace(movedId, beforeId)
    });
  }

  /// 拖动工作目录改顺序。
  ///
  /// 先本地重排再上报:菜单要立刻跟手。顺序**必须**记在宿主上,不能只在本地 ——
  /// workspace/follow 的 baseline 会整个替换 workspaces,
  /// 纯本地的移动会在下一次刷新时被打回原形(对齐 macOS moveWorkspace 的注释)。
  ///
  /// 上报失败就把本地这一步回滚:与其让用户看着一个假的顺序、下次刷新又变回去,
  /// 不如当场退回去 —— 位置没记上是小事,不弹错误打断他。
  async function reorderWorkspace(movedId, beforeId) {
    // 正式 workspace service 会同步发布乐观顺序，并在异步回包时做窄合并/回滚；
    // 菜单只消费它的状态，避免自己保存一份会覆盖 follow 增量的旧快照。
    if (followsWorkspaceState) {
      // service 自己做乐观发布与窄回滚,这里只需吞掉 rejection:
      // 调用方是 void reorderWorkspace(...),不接住就成了 unhandled rejection。
      // 按上面的约定,位置没记上不弹错打断用户。
      try {
        await deps.workspaces.moveWorkspace?.(movedId, beforeId);
      } catch { /* service 已回滚本地顺序 */ }
      return;
    }
    // 简化的嵌入方没有 subscribe 时保留本地退化行为。
    const before = workspaces;
    const next = workspaces.filter((item) => item.workspaceId !== movedId);
    const moved = workspaces.find((item) => item.workspaceId === movedId);
    if (!moved) return;
    const at = beforeId ? next.findIndex((item) => item.workspaceId === beforeId) : -1;
    if (at === -1) next.push(moved);
    else next.splice(at, 0, moved);
    workspaces = next;
    renderMenu();
    const ok = await deps.workspaces?.moveWorkspace?.(movedId, beforeId);
    if (ok === false) {
      workspaces = before;
      renderMenu();
    }
  }

  async function handleSelect(id) {
    elements.workspaceMenu.hidePopover?.();
    if (id === ADD_ID) {
      await addDirectory();
      return;
    }
    const nextTemp = id === TEMP_ID;
    const next = id === ALL_ID || nextTemp ? null : id;
    if (next === selectedId && nextTemp === tempSelected) return;
    selectedId = next;
    tempSelected = nextTemp;
    // 明确选过之后,孤儿 cwd 标签不再有意义。
    orphanCwd = null;
    // 先同步刷新 UI 再持久化:持久化是旁路,不该让标签落后于状态一个微任务,
    // 也不该在 storage 不可用时把 UI 一起卡住。
    paint();
    renderMenu();
    onChange?.(selected());
    await writeStoredId(selectedId);
  }

  // 系统目录选择器 → workspace.create。用户取消(null)时保持原选中不变。
  async function addDirectory() {
    try {
      const created = await deps.workspaces.pickAndCreate();
      if (!created) return;
      workspaces = deps.workspaces.workspaces;
      selectedId = created.workspaceId ?? null;
      tempSelected = false;
      orphanCwd = null;
      paint();
      renderMenu();
      onChange?.(selected());
      await writeStoredId(selectedId);
    } catch (error) {
      showToast?.(deps.formatErrorDetails ? deps.formatErrorDetails(error) : t("workspace.addFailed"));
    }
  }

  // 两颗 chip 共用一个 popover:谁按下的,就按谁的语义渲染首行。
  // 用 pointerdown/keydown 而不是 click —— popover 的展开发生在 click 之前,
  // 等到 click 再改文案就晚了一帧,用户会看到旧文案闪一下。
  function markTrigger(element, hero) {
    if (!element) return;
    const mark = () => {
      if (heroMode === hero) return;
      heroMode = hero;
      renderMenu();
    };
    element.addEventListener("pointerdown", mark);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") mark();
    });
  }
  markTrigger(elements.heroWorkspace, true);
  markTrigger(elements.hdrWorkspace, false);   // 头部 chip 已移除时为 undefined,markTrigger 自己会跳过

  deps.workspaces?.subscribe?.((next) => {
    workspaces = next ?? [];
    if (selectedId && !workspaces.some((item) => item.workspaceId === selectedId)) {
      selectedId = null;
      void writeStoredId(null);
    }
    paint();
    renderMenu();
    onChange?.(selected());
  });

  return {
    /// 走一次系统目录选择器并建 workspace。会话抽屉分区标题右侧那颗「添加目录」
    /// 直接复用这条路径 —— 选中/持久化/失败提示都已经在里面了,菜单里那一项与
    /// 抽屉那颗按钮因此不会走岔。
    addDirectory,
    // 等待 workspace/follow baseline 并恢复上次选择；失败时退化为只有「全部」。
    async refresh() {
      try {
        workspaces = await deps.workspaces.refresh();
      } catch {
        workspaces = deps.workspaces.workspaces ?? [];
      }
      if (selectedId === null) {
        const stored = await readStoredId();
        // 上次选中的目录可能已被删除:回落「全部」并清掉这个 key。
        if (stored && workspaces.some((item) => item.workspaceId === stored)) selectedId = stored;
        else if (stored) await writeStoredId(null);
      } else if (!workspaces.some((item) => item.workspaceId === selectedId)) {
        selectedId = null;
        await writeStoredId(null);
      }
      paint();
      renderMenu();
      return workspaces;
    },
    selected,
    // 打开会话后把标签对齐到该会话的真实 cwd(session.list 不给 workspaceId,
    // 只能用 path 反查)。不触发 onChange:这是跟随显示,不是用户切换。
    setActiveByCwd(cwd) {
      const match = cwd ? workspaces.find((item) => item.path === cwd) : null;
      if (match) {
        selectedId = match.workspaceId;
        tempSelected = false;
        orphanCwd = null;
      } else if (cwd && cwd === hostCwd?.()) {
        // 会话就建在宿主 cwd 下 —— 那正是「临时目录」这一项,跟着选中它,
        // 而不是退化成「全部」(否则打开一个临时会话后过滤器会悄悄失焦)。
        selectedId = null;
        tempSelected = true;
        orphanCwd = null;
      } else {
        // cwd 不属于任何已知 workspace:显示其目录名,过滤视为「全部」。
        selectedId = null;
        tempSelected = false;
        orphanCwd = cwd ?? null;
      }
      paint();
      renderMenu();
    },
    // 供历史列表读取的过滤条件:null 表示不过滤。
    // 「临时目录」不是"不过滤"—— 它是一个具体路径(宿主自身 cwd),所以照常
    // 返回路径,历史列表用同一条 item.cwd === path 规则即可命中。
    activePath() {
      const current = selected();
      if (current) return current.path;
      if (tempSelected) return hostCwd?.() ?? null;
      return null;
    },
    // 供历史列表按会话归属过滤:选中具体 workspace 时,宿主给的 sessionIds 是权威
    // 成员名单。不要用它替代 activePath() 去猜 —— cwd 可能缺失、也可能与 workspace
    // 的 canonical 路径拼写不一致(symlink/尾斜杠),直接比 cwd 会让切目录后整片消失。
    // null 表示「不是某个具体 workspace」(全部 / 临时目录),回落到按路径过滤。
    activeSessionIds() {
      const current = selected();
      return current ? current.sessionIds ?? [] : null;
    },
    // 当前选中的 workspaceId。会话拖拽排序要用它:宿主的
    // workspace.insertSessionBefore 是"在某个工作区内排序",
    // 「全部」/「临时目录」没有工作区归属,返回 null(此时只记本地账本)。
    activeWorkspaceId() {
      return selected()?.workspaceId ?? null;
    },
    // 头部那颗「打开目录」按钮要打开的路径 —— 与 #hdr-workspace-prefix 显示的
    // 是同一个目录:选中 workspace → 其 path;孤儿目录 → 该 cwd;否则回落宿主 cwd
    // (即「临时目录」所代表的路径)。只有连接前啥都没有时才为 null。
    displayedPath() {
      const current = selected();
      if (current) return current.path;
      if (orphanCwd) return orphanCwd;
      return hostCwd?.() ?? null;
    }
  };
}
