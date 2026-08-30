// 工具名称 → 视觉语义(图标/分类)。图标全部取自 Lucide(https://github.com/lucide-icons/lucide,ISC),
// 使用官方 24×24 网格的原始路径几何,未做改画;仅把 stroke-width 从 2 调到 1.7 以适配 14–16px 的渲染尺寸。
// 因为 Lucide 已在同一网格上做过统一的光学对齐,这里不再叠加自定义包围盒校准。仅用于 UI,不参与协议。

const LUCIDE_STROKE = 1.7;
// key → [lucide 图标名, 路径体]。保留 lucide 名字便于日后核对上游。
const LUCIDE_ICONS = Object.freeze({
  globe: ["globe", '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'],
  documentEye: ["file-search", '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="M13.3 16.3 15 18"/>'],
  documentEdit: ["file-pen-line", '<path d="M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"/><path d="M14.487 7.858A1 1 0 0 1 14 7V2"/><path d="M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"/><path d="M8 18h1"/>'],
  keyboard: ["keyboard", '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>'],
  tree: ["network", '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>'],
  cursor: ["mouse-pointer-2", '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>'],
  camera: ["camera", '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/>'],
  compass: ["compass", '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>'],
  codeSearch: ["file-code", '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>'],
  bookSearch: ["book-open-text", '<path d="M12 5v16"/><path d="M16 13h2"/><path d="M16 9h2"/><path d="M20.001 19A2 2 0 0 0 22 17V5a2 2 0 0 0-1.999-2L16 3.002A5 5 0 0 0 12 5a5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 1.999 2H8a5 5 0 0 1 4 2 5 5 0 0 1 4-2z"/><path d="M6 13h2"/><path d="M6 9h2"/>'],
  bookOpen: ["book-open", '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0 0 22 17V5a2 2 0 0 0-1.999-2L16 3.002A5 5 0 0 0 12 5a5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 1.999 2H8a5 5 0 0 1 4 2 5 5 0 0 1 4-2z"/>'],
  sparkleSearch: ["search", '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'],
  terminal: ["terminal", '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>'],
  git: ["git-branch", '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>'],
  database: ["database", '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>'],
  bell: ["bell", '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>'],
  wrench: ["wrench", '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>'],
  form: ["clipboard-list", '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>'],
  askQuestion: ["message-circle-question-mark", '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'],
  permission: ["shield-check", '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'],
  skill: ["sparkles", '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>']
});
export const TOOL_ICON_LUCIDE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(LUCIDE_ICONS).map(([key, [name]]) => [key, name]))
);
// Lucide 全部图标共用 0 0 24 24 网格,这里保持原样以维持官方的光学一致性。
export function getToolIconViewBox() {
  return "0 0 24 24";
}
const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${LUCIDE_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const TOOL_ICON_SVGS = Object.freeze(
  Object.fromEntries(Object.entries(LUCIDE_ICONS).map(([key, [, path]]) => [key, svg(path)]))
);
const EXACT = Object.freeze({
  AskUserQuestion: ["ask-user-question", "interaction", "askQuestion"],
  RequestPermission: ["request-permission", "permission", "permission"],
  request_permission: ["request-permission", "permission", "permission"],
  PermissionRequest: ["request-permission", "permission", "permission"],
  Skill: ["skill", "skill", "skill"],
  skill: ["skill", "skill", "skill"]
});
const CATEGORY_ICON = Object.freeze({
  search: "sparkleSearch",
  read: "documentEye",
  edit: "documentEdit",
  input: "keyboard",
  browser: "cursor",
  navigation: "compass",
  network: "globe",
  command: "terminal",
  git: "git",
  database: "database",
  notification: "bell",
  generic: "wrench",
  interaction: "askQuestion",
  permission: "permission",
  skill: "skill"
});
export function normalizeToolName(name) {
  if (!name) return "tool";
  const mcp = /^mcp__[^_]+(?:-[^_]+)*__(.+)$/.exec(String(name));
  if (mcp) return mcp[1];
  return String(name).replace(/^dsh[-_:]/, "");
}
export function isCommandLikeToolName(name) {
  const value = String(name || "");
  const normalized = normalizeToolName(value);
  const isMcpTool = normalized !== value;
  return !isMcpTool && (value.length > 40 || /\s/.test(value) || /^(TOK=|curl|API=|for |bash|sh |cat |echo |jq )/.test(value)) || /^(bash|shell|terminal|exec|command)$/i.test(normalized);
}
function fallbackCategory(normalized) {
  const value = normalized.toLowerCase();
  if (/ask[_ -]?user[_ -]?question/.test(value)) return "interaction";
  if (/(request[_ -]?permission|permission[_ -]?request|authorization[_ -]?request)/.test(value)) return "permission";
  if (/(mysql|postgres|database|db_|sql|query_database)/.test(value)) return "database";
  if (/(git|github|ghe|repo|pull_request|commit|branch)/.test(value)) return "git";
  if (/(notify|notification|message|wea_send|send_group)/.test(value)) return "notification";
  if (/(http|api|request|network|fetch|curl|station)/.test(value)) return "network";
  if (/(search|find|lookup|query|grep)/.test(value)) return "search";
  if (/(write|edit|update|create|patch|replace|format)/.test(value)) return "edit";
  if (/(browser|computer|click|scroll|screenshot|hover|mouse)/.test(value)) return "browser";
  if (/(navigate|navigation|open_url|go_back|go_forward)/.test(value)) return "navigation";
  if (/(read|get|load|list|glob|inspect|view)/.test(value)) return "read";
  if (/(bash|shell|terminal|exec|command)/.test(value)) return "command";
  return "generic";
}
export function getToolPresentation(name) {
  const normalized = normalizeToolName(name);
  if (/^(Write|Edit|MultiEdit|NotebookEdit)\b/.test(normalized)) {
    return { toolKey: "file-edit", category: "edit", iconKey: "documentEdit" };
  }
  if (isCommandLikeToolName(name)) return { toolKey: "command", category: "command", iconKey: "terminal" };
  const exact = EXACT[normalized];
  if (exact) return { toolKey: exact[0], category: exact[1], iconKey: exact[2] };
  const category = fallbackCategory(normalized);
  return { toolKey: `fallback:${normalized}`, category, iconKey: CATEGORY_ICON[category] };
}
export function getGroupPresentation(items) {
  if (!items?.length) return { category: "generic", iconKey: "wrench" };
  const toolKeys = new Set(items.map((item) => item.toolKey));
  if (toolKeys.size === 1) return { category: items[0].category, iconKey: items[0].iconKey };
  const categories = new Set(items.map((item) => item.category));
  if (categories.size === 1) {
    const category = items[0].category;
    return { category, iconKey: CATEGORY_ICON[category] || "wrench" };
  }
  return { category: "generic", iconKey: "wrench" };
}
export function getToolIconSvg(iconKey) {
  return TOOL_ICON_SVGS[iconKey] || TOOL_ICON_SVGS.wrench;
}
