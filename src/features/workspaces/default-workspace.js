// 首次使用的默认工作区:对齐 web WorkspaceNavigation.initializeDefaultWorkspace
// (packages/client/ui-workspace/src/client/navigation.ts)与 Mac 267bcde
// AppModel.initializeDefaultWorkspace。
//
// 时机必须在建第一个会话**之前**:宿主的资格判定是"注册表与会话历史都为空",
// 连一个空白会话都算历史 —— 先建会话再问,宿主只会回 ok 无 value。
import { t } from "../../shared/i18n.js";

/**
 * 本地预判是否可能是首次使用。只是省 RPC 的快速筛:资格最终由宿主判,
 * 这里任何一项非空时宿主必然不合格(web restoreSelection 同一组条件)。
 *
 * @param {object} state
 * @param {object|null} state.selected 当前选中的 workspace(选了就按用户的来)。
 * @param {Array} state.workspaces 宿主注册表里的 workspace。
 * @param {Array} state.sessions 会话名册。
 * @param {Array<string>} state.archivedSessionIds 已归档会话。
 * @returns {boolean}
 */
export function isFirstUse({ selected = null, workspaces = [], sessions = [], archivedSessionIds = [] } = {}) {
  return !selected && !workspaces?.length && !sessions?.length && !archivedSessionIds?.length;
}

/**
 * 向宿主要默认工作区。标题按当前语言取,目录名同标题(web:zh/en 用本地化标题,
 * 其余语言用 "default-workspace";扩展只有中英两种)。建好后标题不随语言改。
 *
 * @param {{initializeDefault: Function}} workspaceService
 * @returns {Promise<object|null>} 默认 workspace;首次使用已结束时为 null。失败照常抛出。
 */
export function initializeDefaultWorkspace(workspaceService) {
  const title = t("workspace.defaultTitle");
  return workspaceService.initializeDefault({ directoryName: title, title });
}
