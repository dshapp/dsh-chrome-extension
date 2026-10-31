// Markdown 链接目标的分类:外部网页 / 本地文件 / 不认。
//
// 逐条对齐 web MarkdownText:
// - 外部链接只放行 http / https / mailto(web safeHref);其余协议(javascript:、
//   data:、file: …)一律不成链接,只留标签文字。
// - 文件目标(web fileLinkTarget):不带协议的路径(Windows 盘符 C:\ 例外),
//   可选 #L12 / #L12-L20 行号锚点;带 ? 查询串、// 开头(协议相对 URL /
//   UNC)、控制字符、畸形 %-转义的一律不认。路径做一次 decodeURIComponent,
//   于是 src/my%20file.md 读的是 src/my file.md。

/// 外部链接地址;不可放行时返回 null。
export function externalHref(value) {
  const raw = String(value ?? "");
  if (!raw || raw.trim() !== raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? raw : null;
  } catch {
    return null;
  }
}

/// 只认 http(s) —— 行内 code 整段是网址时转链接用(web inlineCodeUrl)。
export function webUrl(value) {
  const raw = String(value ?? "");
  if (!raw || raw.trim() !== raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 工作区相对路径 → 宿主路径(web dsh-util-workspace-path resolveWorkspacePath):
 * 绝对路径(POSIX / Windows 盘符 / UNC)原样;没有 cwd 原样;否则拼到 cwd 下,
 * 拼接前去掉开头的 "./"、"/"、"\"(./a.png → <cwd>/a.png,不留 "/./")。
 * @param {string|null|undefined} cwd 会话工作区根。
 * @param {string} path 绝对或工作区相对路径。
 */
export function resolveWorkspacePath(cwd, path) {
  const value = String(path ?? "");
  const windows = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  if (value.startsWith("/") || windows(value)) return value;
  if (!cwd) return value;
  const separator = windows(cwd) && cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[/\\]+$/, "")}${separator}${value.replace(/^(?:\.?[/\\])+/, "")}`;
}

/**
 * 链接目标若指向本地文件,返回 { path, line? };否则 null。
 * @param {string} value markdown 里写的原始目标(已反转义)。
 */
export function fileLinkTarget(value) {
  const raw = String(value ?? "");
  const hash = raw.indexOf("#");
  const head = hash < 0 ? raw : raw.slice(0, hash);
  if (head.includes("?")) return null;
  let path;
  try { path = decodeURIComponent(head); } catch { return null; }
  if (!path.trim()) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (/^[\\/]{2}/.test(path)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
  if (hash < 0) return { path };
  const anchor = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(raw.slice(hash + 1));
  if (!anchor) return null;
  const line = Number(anchor[1]);
  const end = anchor[2] === undefined ? line : Number(anchor[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || end < line) return null;
  return { path, line };
}
