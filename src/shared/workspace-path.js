// 工作目录的显示名。
//
// 未选工作目录建的会话(「临时目录」)落在宿主自己的 cwd,实测就是用户 home:
// macOS 上是 /Users/<name>,Windows 上是 C:\Users\<name>。原先直接取 basename
// 显示,mac 上变成一个裸用户名,Windows 上因为只按 "/" 切,干脆把整条
// C:\Users\<name> 摆进了标题。这类目录统一简称为 Home。
//
// 纯函数,不碰 i18n:文案由调用方以 homeLabel 传进来(侧栏分区派生层保持纯)。

export const DEFAULT_HOME_LABEL = "Home";

/// 统一分隔符、去掉末尾分隔符;带盘符的 Windows 路径大小写不敏感,一并转小写。
export function normalizePath(path) {
  let text = String(path ?? "").trim().replace(/\\/g, "/");
  if (!text) return "";
  if (text.length > 1) text = text.replace(/\/+$/, "") || "/";
  if (/^[a-z]:(\/|$)/i.test(text)) text = text.toLowerCase();
  return text;
}

/// 末段目录名,同时认 "/" 与 "\"。
export function pathBasename(path) {
  const text = String(path ?? "");
  const parts = text.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.pop() || text;
}

// 宿主还没报 home 时的兜底:按各平台用户目录的固定形状认。
const HOME_SHAPES = [
  /^\/users\/[^/]+$/i,           // macOS
  /^\/home\/[^/]+$/,             // Linux
  /^\/root$/,                     // Linux root
  /^[a-z]:\/users\/[^/]+$/       // Windows(normalizePath 已转小写)
];

/// path 是不是用户 home。宿主报了 home 就以它为准,否则按平台形状判断。
export function isHomePath(path, home = null) {
  const target = normalizePath(path);
  if (!target) return false;
  const knownHome = normalizePath(home);
  if (knownHome) return target === knownHome;
  return HOME_SHAPES.some((shape) => shape.test(target));
}

/// 工作目录的显示名:home 显示为 homeLabel,其余用标题或目录名。
/// 宿主给 home 目录自动起的标题(目录名/整条路径)同样换成 Home;用户自己
/// 改过的标题照常尊重。
export function workspaceDisplayName({ title = null, path = null } = {}, { home = null, homeLabel = DEFAULT_HOME_LABEL } = {}) {
  if (isHomePath(path, home)) {
    const auto = !title || title === path || title === pathBasename(path);
    if (auto) return homeLabel;
  }
  return title || pathBasename(path);
}
