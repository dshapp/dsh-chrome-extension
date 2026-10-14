// 侧栏会话搜索的纯派生,逐条对齐 web deriveSearchResults
// (deepseek-harness packages/client/ui-workspace/src/client/tree.ts)。
import { ArchivedFilter, archivedVisible } from "./sidebar-sections.js";

/// session/search 响应的条数上限(web SESSION_SEARCH_RESULT_LIMIT)。
export const SEARCH_RESULT_LIMIT = 20;
export const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_QUERY_MAX_CODE_UNITS = 500;

/// web sanitizeSearchQuery:session/search 的线协议不收 NUL,最多 500 个 code unit
///(不切开代理对)。输入框本身也按它收敛。
export function sanitizeSearchQuery(value) {
  const withoutNul = String(value ?? "").replaceAll("\0", "");
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul;
  let end = SEARCH_QUERY_MAX_CODE_UNITS;
  const last = withoutNul.charCodeAt(end - 1);
  const next = withoutNul.charCodeAt(end);
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
  return withoutNul.slice(0, end);
}

/// 去掉首尾空白后的查询;为空即不在搜索,显示普通列表。
export function normalizeSearchQuery(value) {
  return sanitizeSearchQuery(value).trim();
}

/**
 * 本地命中(显示标题或工作区标签包含查询)按 updatedAt 新到旧领先,宿主内容命中按后端
 * 顺序接在后面;两臂都滤掉空白与子代理,已归档会话按侧栏同一个「筛选会话」取舍
 *(Mac deriveSessionSearchResults 的 archivedFilter),宿主命中还必须在名册里,按
 * sessionId 去重后截到 limit。归档命中带 archived:true。
 *
 * @param {object} options
 * @param {Array} options.sessions 名册(listStore 的会话摘要)。
 * @param {Array} options.workspaces 宿主 workspace(sessionIds / title / path)。
 * @param {Array<string>} options.archivedIds 已归档会话。
 * @param {string} [options.archivedFilter] ArchivedFilter 之一,默认隐藏归档。
 * @param {string} options.query normalizeSearchQuery 之后的非空查询。
 * @param {{items: Array, hasMore: boolean}} options.remote 当前查询的宿主结果页。
 * @returns {{items: Array, hasMore: boolean}}
 */
export function deriveSearchResults({
  sessions, workspaces, archivedIds, archivedFilter = ArchivedFilter.hide, query, remote, limit = SEARCH_RESULT_LIMIT
}) {
  const q = query.toLowerCase();
  const archived = new Set(archivedIds ?? []);
  const workspaceBySession = new Map();
  for (const workspace of workspaces ?? []) {
    const label = workspace.title || basename(workspace.path);
    for (const id of workspace.sessionIds ?? []) {
      if (!workspaceBySession.has(id)) workspaceBySession.set(id, label);
    }
  }
  const visible = (item) => item && !item.blank && item.origin !== "subagent"
    && archivedVisible(archived.has(item.sessionId), archivedFilter);
  const label = (item) => workspaceBySession.get(item.sessionId) ?? basename(item.cwd);

  const byId = new Map();
  const local = [];
  for (const item of sessions ?? []) {
    byId.set(item.sessionId, item);
    if (!visible(item)) continue;
    if (sessionTitle(item).toLowerCase().includes(q) || label(item).toLowerCase().includes(q)) local.push(item);
  }
  local.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (a.sessionId < b.sessionId ? -1 : 1));

  const ordered = [];
  const included = new Set();
  const include = (item) => {
    if (included.has(item.sessionId)) return;
    included.add(item.sessionId);
    ordered.push(archived.has(item.sessionId) && !item.archived ? { ...item, archived: true } : item);
  };
  for (const item of local) include(item);
  for (const hit of remote?.items ?? []) {
    const item = byId.get(hit.sessionId);
    if (visible(item)) include(item);
  }
  return { items: ordered.slice(0, limit), hasMore: Boolean(remote?.hasMore) || ordered.length > limit };
}

/// 会话自己的标题(web 0.2 tree.ts:`session.title?.trim() ?? ''`),未命名为空串。
/// 0.2 起标题匹配不再回落到目录名或 sessionId:行上已经不显示它们(显示「未命名」),
/// 用看不见的兜底文本命中只会让结果看起来莫名其妙。目录名仍由工作区标签那一臂命中。
export function sessionTitle(item) {
  const title = item?.projections?.values?.title;
  return typeof title === "string" ? title.trim() : "";
}

function basename(path) {
  const text = String(path || "");
  return text.replace(/\/+$/, "").split("/").pop() || text;
}
