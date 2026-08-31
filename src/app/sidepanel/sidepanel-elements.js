// 侧栏 DOM 查询:把 index.html 的 id 收敛成一份具名引用表,缺元素立即抛错。
const IDS = ["hdr-status", "hdr-new", "hdr-title", "hdr-title-wrap", "hdr-open-folder", "hdr-settings",
  "hdr-workspace", "hdr-workspace-label", "workspace-menu", "history-popover", "history-search",
  // 标题里的工作目录前缀("工作目录 / 会话标题"的前半段)
  "hdr-workspace-prefix",
  "history-list-inner", "shortcut-new", "shortcut-history", "messages", "empty-hint", "msg-list", "interactions", "prompt-queue",
  "preview-strip", "input", "composer-bar", "skills-menu", "perm-btn", "perm-label",
  "perm-menu", "model-btn", "model-label", "model-menu", "send", "toast", "view-settings",
  "attach-btn", "attach-menu", "attach-img", "file-input",
  // 新增:交互接管区、plan 药丸、触发候选菜单、权限二次确认
  "composer-takeover", "plan-chip", "trigger-menu", "perm-confirm", "composer",
  // 引用胶囊镜像层(画在 textarea 底下)
  "input-mirror",
  // 停靠区与 agent 预设
  "goal-bar-slot", "todo-panel", "stats-btn", "stats-menu", "preset-btn", "preset-label", "preset-menu",
  // 子代理目录:header chip + 树形 popover
  "subagent-catalog-btn", "subagent-catalog-menu",
  // 新建会话页(empty hero)的选择区:工作目录 + Agent 预设
  "hero-workspace", "hero-workspace-label",
  // 页面元素选取
  "element-picker-btn", "picked-elements-chip", "picked-elements-label",
  "picked-elements-menu", "picked-elements-clear",
  // 当前页面上下文开关
  "page-context-btn"];

export function collectElements(root) {
  const byId = new Map(IDS.map((id) => [id, root.querySelector(`#${id}`)]));
  for (const [id, element] of byId) {
    if (!element) throw new Error(`侧栏缺少元素 #${id}`);
  }
  return {
    hdrStatus: byId.get("hdr-status"),
    hdrNew: byId.get("hdr-new"),
    hdrTitle: byId.get("hdr-title"),
    hdrTitleWrap: byId.get("hdr-title-wrap"),
    hdrOpenFolder: byId.get("hdr-open-folder"),
    hdrWorkspace: byId.get("hdr-workspace"),
    hdrWorkspaceLabel: byId.get("hdr-workspace-label"),
    hdrWorkspacePrefix: byId.get("hdr-workspace-prefix"),
    workspaceMenu: byId.get("workspace-menu"),
    shortcutNew: byId.get("shortcut-new"),
    shortcutHistory: byId.get("shortcut-history"),
    historySearch: byId.get("history-search"),
    messages: byId.get("messages"),
    emptyHint: byId.get("empty-hint"),
    msgList: byId.get("msg-list"),
    interactions: byId.get("interactions"),
    promptQueue: byId.get("prompt-queue"),
    previewStrip: byId.get("preview-strip"),
    input: byId.get("input"),
    skillsMenu: byId.get("skills-menu"),
    permBtn: byId.get("perm-btn"),
    permLabel: byId.get("perm-label"),
    permMenu: byId.get("perm-menu"),
    modelLabel: byId.get("model-label"),
    modelMenu: byId.get("model-menu"),
    send: byId.get("send"),
    toast: byId.get("toast"),
    attachBtn: byId.get("attach-btn"),
    attachMenu: byId.get("attach-menu"),
    attachImg: byId.get("attach-img"),
    fileInput: byId.get("file-input"),
    modelBtn: byId.get("model-btn"),
    composer: byId.get("composer"),
    composerTakeover: byId.get("composer-takeover"),
    planChip: byId.get("plan-chip"),
    triggerMenu: byId.get("trigger-menu"),
    inputMirror: byId.get("input-mirror"),
    permConfirm: byId.get("perm-confirm"),
    goalBarSlot: byId.get("goal-bar-slot"),
    todoPanel: byId.get("todo-panel"),
    statsBtn: byId.get("stats-btn"),
    statsMenu: byId.get("stats-menu"),
    heroWorkspace: byId.get("hero-workspace"),
    heroWorkspaceLabel: byId.get("hero-workspace-label"),
    presetBtn: byId.get("preset-btn"),
    presetLabel: byId.get("preset-label"),
    presetMenu: byId.get("preset-menu"),
    subagentCatalogBtn: byId.get("subagent-catalog-btn"),
    subagentCatalogMenu: byId.get("subagent-catalog-menu"),
    elementPickerBtn: byId.get("element-picker-btn"),
    pickedChip: byId.get("picked-elements-chip"),
    pickedLabel: byId.get("picked-elements-label"),
    pickedMenu: byId.get("picked-elements-menu"),
    pickedClear: byId.get("picked-elements-clear"),
    pageContextBtn: byId.get("page-context-btn")
  };
}
