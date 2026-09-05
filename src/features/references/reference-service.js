// '@' 引用候选来源。对齐 macos/.../State/ComposerTriggerController.swift。
//
// 关键:文件候选走 `fileReferences/list`(按 agentId 限定到会话 cwd 的模糊搜索),
// **不是** host.listDirectory —— 后者需要 browse 能力,本机宿主直接回
// `directory-picker-unavailable`,'@' 会永远搜不到东西。
import { t } from "../../shared/i18n.js";

export const REFERENCE_RPC = Object.freeze({
  files: "fileReferences/list",
  sessions: "sessionReferenceResolver/candidates"
});

/// 把选中的文件/目录格式化成提示词文本(对齐 web formatFileMention):
/// 含空白的路径用 `@"path"` 引号语法;目录保留结尾斜杠(带引号时保留开引号),
/// 以便实时触发能继续下钻;含控制字符或内嵌引号的路径无法表示,返回 null。
export function formatFileMention(path, isDirectory) {
  const full = isDirectory ? `${path}/` : path;
  for (const ch of full) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || ch === '"') return null;
  }
  if (!/\s/.test(full)) return `@${full}`;
  return isDirectory ? `@"${full}` : `@"${full}"`;
}

/// 文件行 → 菜单候选。目录 insertsPlainText,让插入后菜单继续下钻。
export function fileCandidates(items) {
  return (items ?? []).map((item) => {
    const isDirectory = item.kind === "directory";
    const mention = formatFileMention(item.path, isDirectory);
    if (!mention) return null;
    const basename = item.path.split("/").filter(Boolean).pop() ?? item.path;
    return {
      name: `${t(isDirectory ? "reference.folder" : "reference.file")} · ${basename}${isDirectory ? "/" : ""}`,
      description: item.path,
      value: mention,
      insertLabel: basename,
      insertsPlainText: isDirectory
    };
  }).filter(Boolean);
}

/// 历史会话行 → 菜单候选。mention 由宿主给出(带 dsh-session: 编码),原样使用。
export function sessionCandidates(items) {
  return (items ?? []).map((item) => {
    const location = item.cwd ?? t("reference.noCwd");
    const idPrefix = item.label === item.sessionId ? "" : `${item.sessionId} · `;
    // 一个无法解析的 createdAt(宿主漏发/非法)不能让整个 '@' 会话候选源
    // 因 toISOString 抛 RangeError 而全军覆没:坏日期只丢日期段,会话仍可引用。
    const created = new Date(item.createdAt);
    const date = Number.isFinite(created.getTime()) ? created.toISOString() : "";
    return {
      name: `${t("reference.session")} · ${item.label}`,
      description: `${idPrefix}${location}${date ? ` · ${date}` : ""}`,
      value: item.mention,
      insertLabel: item.label
    };
  });
}

export function createReferenceService(connection) {
  return {
    /// 宿主已按 query 做过匹配与排序,这里不再本地过滤。
    async files(sessionId, query) {
      const value = await connection.call(REFERENCE_RPC.files, { agentId: sessionId, query });
      return fileCandidates(Array.isArray(value) ? value : []);
    },
    async sessions(sessionId, query) {
      const value = await connection.call(REFERENCE_RPC.sessions, { agentId: sessionId, query });
      return sessionCandidates(Array.isArray(value) ? value : []);
    }
  };
}
