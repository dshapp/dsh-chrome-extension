// 粘贴/拖入的文件夹 → 写进提示词的绝对路径。
//
// 浏览器不暴露粘贴或拖入项的真实路径(entry.fullPath 是沙箱虚拟路径),所以
// 绝对路径来自 native host 读系统 pasteboard(粘贴读剪贴板 general,拖放读拖拽板
// drag)。这里只做纯函数部分:把 DataTransfer 里的文件夹名与 pasteboard 上的路径
// 对上号,再格式化成要插进输入框的文本。

/// Windows 绝对路径:盘符 "C:\…" 或 UNC "\\server\share\…"(Windows 宿主读剪贴板
/// 得到的就是这两种)。只有它们按 "\" 分段 —— POSIX 文件名里 "\" 是合法字符。
function isWindowsPath(path) {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

function isAbsolutePath(path) {
  return typeof path === "string" && (path.startsWith("/") || isWindowsPath(path));
}

function separators(path) {
  return isWindowsPath(path) ? /[\\/]+/ : /\/+/;
}

/// 去掉末尾分隔符;根("/"、"C:\")原样保留。
function trimTrailingSeparators(path) {
  if (!isWindowsPath(path)) return path.replace(/\/+$/, "") || "/";
  const trimmed = path.replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? path.slice(0, 3) : trimmed;
}

function basename(path) {
  return trimTrailingSeparators(String(path)).split(separators(path)).pop() ?? "";
}

/// 按名字把文件夹与 pasteboard 路径一一配对。
///
/// pasteboard 可能是旧的(比如拖拽板留着上一次拖的内容),所以必须核对名字,
/// 对不上的一律算 missing —— 宁可提示拿不到路径,也不能插一个别的文件夹的路径。
/// 同名多个时按出现顺序各取一个,不重复使用同一条路径。
export function matchDirectoryPaths(names, paths) {
  const matched = [];
  const missing = [];
  const paired = pairPathsByName(names, paths);
  (names ?? []).forEach((name, index) => {
    if (paired[index]) matched.push(paired[index]);
    else missing.push(name);
  });
  return { matched, missing };
}

/// 与 names 逐项对齐的路径(配不上的为 null)。规则同 matchDirectoryPaths;
/// 拖入/粘贴的**文件**也用它找回真实路径(点附件胶囊时用默认应用打开)。
export function pairPathsByName(names, paths) {
  const pool = (paths ?? []).filter(isAbsolutePath);
  return (names ?? []).map((name) => {
    const at = pool.findIndex((path) => basename(path) === name);
    return at === -1 ? null : trimTrailingSeparators(pool.splice(at, 1)[0]);
  });
}

/// 一条绝对路径的提示词写法:含空白时整体加双引号,避免被当成几段文字。
export function formatFolderPath(path) {
  return /\s/.test(path) ? `"${path}"` : path;
}

/// 把若干路径插进 text 的 [start, end) 处,前后按需补空格,返回新文本与光标位置。
export function insertFolderPaths(text, start, end, paths) {
  const value = String(text ?? "");
  const from = Math.max(0, Math.min(Number.isInteger(start) ? start : value.length, value.length));
  const to = Math.max(from, Math.min(Number.isInteger(end) ? end : from, value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${paths.map(formatFolderPath).join(" ")}${tail}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
