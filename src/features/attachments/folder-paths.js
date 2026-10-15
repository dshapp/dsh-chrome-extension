// 粘贴/拖入的文件夹 → 写进提示词的绝对路径。
//
// 浏览器不暴露粘贴或拖入项的真实路径(entry.fullPath 是沙箱虚拟路径),所以
// 绝对路径来自 native host 读系统 pasteboard(粘贴读剪贴板 general,拖放读拖拽板
// drag)。这里只做纯函数部分:把 DataTransfer 里的文件夹名与 pasteboard 上的路径
// 对上号,再格式化成要插进输入框的文本。

function basename(path) {
  return String(path).replace(/\/+$/, "").split("/").pop() ?? "";
}

/// 按名字把文件夹与 pasteboard 路径一一配对。
///
/// pasteboard 可能是旧的(比如拖拽板留着上一次拖的内容),所以必须核对名字,
/// 对不上的一律算 missing —— 宁可提示拿不到路径,也不能插一个别的文件夹的路径。
/// 同名多个时按出现顺序各取一个,不重复使用同一条路径。
export function matchDirectoryPaths(names, paths) {
  const pool = (paths ?? []).filter((path) => typeof path === "string" && path.startsWith("/"));
  const matched = [];
  const missing = [];
  for (const name of names ?? []) {
    const at = pool.findIndex((path) => basename(path) === name);
    if (at === -1) { missing.push(name); continue; }
    matched.push(pool.splice(at, 1)[0].replace(/\/+$/, "") || "/");
  }
  return { matched, missing };
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
