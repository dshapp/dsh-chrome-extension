// 静态 DOM 的本地化:index.html 里的首帧文案(标题/占位符/aria-label)默认写死成
// 中文,英文用户切到 en 后必须被这里重写。动态文案由各模块自己 render,不在这里。
// 语言切换时由 sidepanel-app 的 relabel() 再调一次即可整体刷新。
import { getLang, t } from "../../shared/i18n.js";

function setText(root, selector, value) {
  const node = root.querySelector(selector);
  if (node) node.textContent = value;
}

function setAttr(root, selector, name, value) {
  const node = root.querySelector(selector);
  if (node) node.setAttribute(name, value);
}

function setPlaceholder(root, selector, value) {
  const node = root.querySelector(selector);
  if (node) node.placeholder = value;
}

/// 把所有静态标签刷成当前语言的文案,并同步 <html lang>。
export function applyStaticLabels(root) {
  // 顶栏
  setAttr(root, "#hdr-new", "aria-label", t("new_session"));
  setAttr(root, "#hdr-open-folder", "aria-label", t("hdr.openFolder"));
  setAttr(root, "#hdr-open-folder", "title", t("hdr.openFolderHint"));
  setAttr(root, "#hdr-settings", "aria-label", t("settings"));
  setAttr(root, "#hdr-settings", "title", t("settings"));
  setAttr(root, "#history-popover", "aria-label", t("history.label"));
  setAttr(root, "#hdr-workspace", "aria-label", t("workspace.label"));
  setAttr(root, "#hdr-workspace", "title", t("workspace.switchHint"));
  setPlaceholder(root, "#history-search", t("history.searchPlaceholder"));

  // 工作目录菜单 / 弹层
  setAttr(root, "#workspace-menu", "aria-label", t("workspace.label"));
  setAttr(root, "#hero-workspace", "aria-label", t("workspace.label"));
  setAttr(root, "#hero-workspace", "title", t("workspace.switchHint"));
  setAttr(root, "#subagent-catalog-menu", "aria-label", t("subagentCatalogPanelLabel"));
  setAttr(root, "#jobs-menu", "aria-label", t("jobs.title"));
  setAttr(root, "#git-entry-menu", "aria-label", t("git.entryLabel"));
  setAttr(root, "#preset-menu", "aria-label", t("preset.title"));

  // 空会话提示
  setText(root, "#empty-title", t("empty.start"));

  // 会话内查找
  setPlaceholder(root, "#find-input", t("find.placeholder"));
  setAttr(root, "#find-input", "aria-label", t("find.placeholder"));
  setAttr(root, "#find-prev", "aria-label", t("find.previous"));
  setAttr(root, "#find-prev", "title", t("find.previous"));
  setAttr(root, "#find-next", "aria-label", t("find.next"));
  setAttr(root, "#find-next", "title", t("find.next"));
  setAttr(root, "#find-close", "aria-label", t("find.close"));
  setAttr(root, "#find-close", "title", t("find.close"));

  // 轨迹页
  setAttr(root, "#trajectory-pane .trajectory-toolbar", "aria-label", t("trajectory.toolbarLabel"));
  setPlaceholder(root, "#trajectory-search", t("trajectory.searchPlaceholder"));
  setAttr(root, "#trajectory-search", "aria-label", t("trajectory.search"));
  setAttr(root, "#trajectory-pane .trajectory-search-clear", "aria-label", t("trajectory.searchClear"));
  setAttr(root, "#trajectory-pane .trajectory-close", "aria-label", t("trajectory.close"));
  setAttr(root, "#trajectory-ledger", "aria-label", t("trajectory.ledgerLabel"));

  // 输入区
  setAttr(root, "#prompt-queue", "aria-label", t("queue.title"));
  setAttr(root, "#picked-elements-clear", "aria-label", t("picker.clear"));
  setAttr(root, "#picked-elements-clear", "title", t("picker.clear"));
  setAttr(root, "#picked-elements-menu", "aria-label", t("picker.region"));
  setText(root, "#picked-elements-label", t("picker.label", { n: "0" }));
  setPlaceholder(root, "#input", t("input.placeholder"));
  setAttr(root, "#input", "aria-label", t("input.placeholder"));
  setAttr(root, "#trigger-menu", "aria-label", t("trigger.candidates"));
  setAttr(root, "#attach-btn", "aria-label", t("attach.addContext"));
  setAttr(root, "#element-picker-btn", "aria-label", t("picker.pick"));
  setAttr(root, "#skills-menu", "aria-label", t("skills.title"));
  setAttr(root, "#perm-menu", "aria-label", t("perm.modeLabel"));
  setAttr(root, "#model-btn", "aria-label", t("model.select"));
  setAttr(root, "#model-menu", "aria-label", t("model.select"));
  setAttr(root, "#stats-menu", "aria-label", t("stats.title"));
  setAttr(root, "#send", "aria-label", t("send"));

  // 轮次导航 / 拖放
  setAttr(root, "#turn-rail", "aria-label", t("turnNavigation.label"));
  setText(root, "#drop-overlay-hint", t("attach.dropHint"));

  // full-access 二次确认
  setText(root, "#perm-confirm-title", t("perm.confirmTitle"));
  setText(root, "#perm-confirm-body", t("perm.confirmBody"));
  setText(root, "#perm-confirm-ack-label", t("perm.confirmAcknowledge"));
  setText(root, "#perm-confirm-cancel", t("perm.confirmCancel"));
  setText(root, "#perm-confirm-enable", t("perm.confirmEnable"));

  // 设置页外壳
  setText(root, "#settings-title", t("settings"));
  setAttr(root, "#settings-back", "aria-label", t("settings.back"));
  setAttr(root, "#settings-tabs", "aria-label", t("settings.sections"));

  // 每帧首帧 <html lang> 也跟随当前语言,屏幕阅读器与字体回退都用它。
  const lang = getLang();
  if (root.lang !== lang) root.lang = lang;
}
