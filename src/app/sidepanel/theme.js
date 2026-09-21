// 主题。默认跟随系统 prefers-color-scheme,但宿主 ui-theme.preference 是权威 ——
// Mac 的 ThemeCube 写进设置后界面立刻跟着变,扩展这边原本写完毫无反应,是实打实
// 的功能缺口。这里把偏好落成 `data-theme`:system 跟随媒体查询,light/dark 强制。
//
// 偏好值在启动时先读本地镜像(见 platform/storage/settings.js):侧栏要在宿主往返
// 之前就画出正确的颜色,否则每次冷启动都会闪一帧系统色。

export function resolveTheme(mediaDark) {
  return mediaDark?.matches ? "dark" : "light";
}

const VALID = new Set(["system", "light", "dark"]);

export function normalizeThemePreference(value) {
  return VALID.has(value) ? value : "system";
}

/// 应用一次主题,返回实际生效的明暗。偏好非法值一律按 system 处理。
export function applyTheme(root, preference, mediaDark) {
  const normalized = normalizeThemePreference(preference);
  const theme = normalized === "system" ? resolveTheme(mediaDark) : normalized;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-theme-preference", normalized);
  return theme;
}

/// 启动时应用一次,并在"跟随系统"档监听系统主题变化实时切换。
/// 返回的 setPreference 供设置页写入后立即生效,不需重启侧栏。
export function initTheme(doc = document, win = window) {
  const mediaDark = win.matchMedia ? win.matchMedia("(prefers-color-scheme: dark)") : null;
  const root = doc.documentElement;
  let preference = "system";

  const apply = () => applyTheme(root, preference, mediaDark);
  apply();
  mediaDark?.addEventListener?.("change", () => {
    // 只有跟随系统时才需要响应媒体查询;强制档下系统切换不该改动界面。
    if (preference === "system") apply();
  });

  return {
    apply,
    get preference() { return preference; },
    setPreference(value) {
      preference = normalizeThemePreference(value);
      return apply();
    }
  };
}
