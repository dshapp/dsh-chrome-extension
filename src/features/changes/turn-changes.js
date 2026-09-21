// 本轮改动文件(web ui-deliverables 的 changed-files 卡 / mac TurnChanges.swift):
// 宿主 workspace-changes 插件在每个顶层 turn 结束时追加一条 `workspace/changes`
// 事件,事件里**只有 turn 号**;文件清单、行数与逐文件对比要按这条事件自己的
// seq 去宿主的鉴权 GET 路由读(`/api/changes.summary`、`/api/changes.diff`)。
//
// 因此这是一条"两段式"的面:公告是耐久的,摘要与对比只在会话活着时由宿主提供;
// 宿主回 404 表示"这条记录已经不提供了"(会话被回收、或本进程根本没记过它),
// 那是正常的"没东西可展示",不是失败 —— 调用方据此不画卡。

/// 宿主路由(与 ui-deliverables 的 CHANGED_FILES_PATH / CHANGES_DIFF_PATH 一致)。
export const CHANGES_SUMMARY_PATH = "/api/changes.summary";
export const CHANGES_DIFF_PATH = "/api/changes.diff";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function int(value) {
  return Number.isSafeInteger(value) ? value : null;
}

/// `workspace/changes` 事件的公告(web `isChangesEvent` / mac applyWorkspaceChanges):
/// 只认领带合法 turn 的事件,其余原样忽略(不画行,也不进未知面兜底)。
export function changesAnnouncement(event) {
  if (!isObject(event?.data)) return null;
  const turn = int(event.data.turn);
  const seq = int(event.seq);
  if (turn == null || turn < 1 || seq == null) return null;
  return { turn, seq };
}

/// 一条改动文件(宿主 `WorkspaceChangedFile`)。
/// `display` 是宿主的排序键与展示名(工作目录相对路径、`../`、`~` 或绝对路径),
/// `path` 才是 diff 路由寻址用的身份。缺字段的条目跳过,而不是画一行空卡。
function decodeFile(value) {
  if (!isObject(value)) return null;
  const path = typeof value.path === "string" ? value.path : "";
  const display = typeof value.display === "string" ? value.display : "";
  const added = int(value.added);
  const deleted = int(value.deleted);
  if (!path || !display || added == null || deleted == null) return null;
  return {
    path,
    display,
    added,
    deleted,
    // git 报告某一侧是二进制,或抓取到的某一侧含 NUL 字节。
    binary: value.binary === true,
    // 某一侧超过宿主的单文件上限,没有可比的内容。
    oversized: value.oversized === true
  };
}

/// 一次 `/api/changes.summary` 的响应体(web `isChangesSummary` / mac TurnChangesSummary)。
/// `total` 是完整的改动文件数,可能大于 `files.length`(宿主 maxFiles 截断)。
export function decodeChangesSummary(value) {
  if (!isObject(value)) return null;
  const turn = int(value.turn);
  const total = int(value.total);
  const added = int(value.added);
  const deleted = int(value.deleted);
  if (turn == null || turn < 1 || total == null || added == null || deleted == null) return null;
  if (!Array.isArray(value.files)) return null;
  const files = [];
  for (const entry of value.files) {
    const file = decodeFile(entry);
    if (file) files.push(file);
  }
  return { turn, files, total, added, deleted };
}

/// 一个 hunk(宿主 `WorkspaceDiffHunk`)。每行保留自己的 `+` / `-` / 空格前缀。
function decodeHunk(value) {
  if (!isObject(value)) return null;
  const oldStart = int(value.oldStart);
  const oldLines = int(value.oldLines);
  const newStart = int(value.newStart);
  const newLines = int(value.newLines);
  if (oldStart == null || oldLines == null || newStart == null || newLines == null) return null;
  if (!Array.isArray(value.lines)) return null;
  return {
    oldStart, oldLines, newStart, newLines,
    lines: value.lines.filter((line) => typeof line === "string")
  };
}

/// 一次 `/api/changes.diff` 的响应体(mac ChangedFileDiff)。
/// 二进制 / 过大的一侧没有行,所以"种类"是值的一部分,而不是一个空 hunk 列表。
export function decodeChangesDiff(value) {
  if (!isObject(value)) return null;
  const kind = typeof value.kind === "string" ? value.kind : "";
  const path = typeof value.path === "string" ? value.path : "";
  const display = typeof value.display === "string" ? value.display : "";
  if (!path || !display) return null;
  switch (kind) {
    case "text": {
      const hunks = [];
      for (const entry of Array.isArray(value.hunks) ? value.hunks : []) {
        const hunk = decodeHunk(entry);
        if (hunk) hunks.push(hunk);
      }
      // coarse:行级对比超时,宿主退化成"整文件替换"的一个 hunk。
      return { kind: "text", path, display, hunks, coarse: value.coarse === true };
    }
    case "binary":
      return { kind: "binary", path, display };
    case "oversized":
      return { kind: "oversized", path, display };
    default:
      return null;
  }
}
