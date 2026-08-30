// 主题:跟随系统 prefers-color-scheme,与原 extension 一致(无手动开关)。
// 启动时应用一次,并监听系统主题变化实时切换。

export function resolveTheme(mediaDark) {
  return mediaDark?.matches ? "dark" : "light";
}

export function initTheme(doc = document, win = window) {
  const mediaDark = win.matchMedia ? win.matchMedia("(prefers-color-scheme: dark)") : null;
  const apply = () => doc.documentElement.setAttribute("data-theme", resolveTheme(mediaDark));
  apply();
  mediaDark?.addEventListener?.("change", apply);
  return apply;
}
