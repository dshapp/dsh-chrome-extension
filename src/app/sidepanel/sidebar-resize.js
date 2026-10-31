// 左侧会话栏的拖拽调宽。
//
// 抽屉右缘有一条竖向把手(#session-drawer-resizer):按住左右拖改宽度,双击恢复默认,
// 获得焦点时 ← / → 每次 16px。宽度只写一个 CSS 变量 --sidebar-w-pref(挂在 :root 上),
// 上下限全部交给 foundation.css 的 clamp() —— 它按档位不同:挤出栏要给聊天区留够宽,
// 窄档浮层只要别盖满整屏。JS 不重复那套公式:拖动时直接把指针位置写进去让 CSS 夹住,
// 松手后再把**实际渲染出来的宽度**存下来,这样存下的值永远是用户看见的那个。
//
// 与收起偏好(sidebar-state.js)同一个理由存 localStorage:同步读,首帧就按用户的宽度画,
// 不会先画默认宽再跳。多个侧栏实例之间靠 window 的 storage 事件同步。

export const SIDEBAR_WIDTH_KEY = "dsh_sidebar_width";
export const SIDEBAR_WIDTH_PROP = "--sidebar-w-pref";
/// 与 foundation.css 的下限一致;更大的上限由 CSS 按视口夹。
export const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_SANE_MAX = 4000;
const KEY_STEP = 16;
const RESIZING_CLASS = "sidebar-resizing";

/// 存储里读回来的值:非数字 / 越界一律当作没设置(用默认宽度)。
export function parseSidebarWidth(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Math.round(Number(raw));
  if (!Number.isFinite(value) || value < SIDEBAR_WIDTH_MIN || value > SIDEBAR_WIDTH_SANE_MAX) return null;
  return value;
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {Storage|null} [options.storage] 默认 localStorage;写不了时只在本页生效。
 * @returns {{ width(): number|null, setWidth(px: number|null, opts?: {persist?: boolean}): void, reset(): void } | null}
 */
export function mountSidebarResize({ doc = globalThis.document, storage = defaultStorage() } = {}) {
  const root = doc.documentElement;
  const body = doc.body;
  const drawer = doc.querySelector("#session-drawer");
  const handle = doc.querySelector("#session-drawer-resizer");

  function readStored() {
    try { return parseSidebarWidth(storage?.getItem(SIDEBAR_WIDTH_KEY)); } catch { return null; }
  }
  function apply(px) {
    if (px === null) root.style.removeProperty(SIDEBAR_WIDTH_PROP);
    else root.style.setProperty(SIDEBAR_WIDTH_PROP, `${Math.round(px)}px`);
  }
  function persist(px) {
    try {
      if (px === null) storage?.removeItem(SIDEBAR_WIDTH_KEY);
      else storage?.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
    } catch { /* 写不了就只在本页生效 */ }
  }
  /// 抽屉此刻实际渲染的宽度(已被 CSS clamp 夹过)。抽屉不可见时为 0。
  function renderedWidth() {
    return Math.round(drawer?.getBoundingClientRect().width ?? 0);
  }
  /// 把手的 aria-valuenow / valuemax。上限是 CSS 按档位与视口算的,量法是把变量临时
  /// 推到极大、读一次实际宽度再还原 —— 同一个同步任务里完成,不会画出中间态。
  /// 拖动中每帧只更新 valuenow(withMax=false),免得每次 pointermove 多两次强制排版。
  function syncAria({ withMax = true } = {}) {
    const width = renderedWidth();
    if (!handle || width <= 0) return;
    handle.setAttribute("aria-valuenow", String(width));
    if (!withMax) return;
    const saved = root.style.getPropertyValue(SIDEBAR_WIDTH_PROP);
    root.style.setProperty(SIDEBAR_WIDTH_PROP, `${SIDEBAR_WIDTH_SANE_MAX}px`);
    const max = renderedWidth();
    if (saved) root.style.setProperty(SIDEBAR_WIDTH_PROP, saved);
    else root.style.removeProperty(SIDEBAR_WIDTH_PROP);
    handle.setAttribute("aria-valuemax", String(Math.max(max, width)));
  }

  // 同步读、同步写变量:首帧就是用户上次的宽度。
  apply(readStored());
  doc.defaultView?.addEventListener?.("storage", (event) => {
    if (event.key !== null && event.key !== SIDEBAR_WIDTH_KEY) return;
    apply(readStored());
  });

  const api = {
    width: readStored,
    /// 设宽度;persist 时以夹完后的实际宽度落盘(抽屉不可见量不到时按请求值,仍不低于下限)。
    setWidth(px, { persist: save = true } = {}) {
      if (px === null) { apply(null); if (save) persist(null); return; }
      apply(Math.max(SIDEBAR_WIDTH_MIN, px));
      if (!save) return;
      const actual = renderedWidth();
      const final = actual >= SIDEBAR_WIDTH_MIN ? actual : Math.max(SIDEBAR_WIDTH_MIN, Math.round(px));
      apply(final);
      persist(final);
      syncAria();
    },
    reset() { api.setWidth(null); syncAria(); }
  };
  if (!drawer || !handle) return api;

  handle.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
  let drag = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // 指针相对抽屉右缘的偏移:按在把手的哪一点,拖动时就保持在哪一点,不会一按先跳几像素。
    const rect = drawer.getBoundingClientRect();
    drag = { pointerId: event.pointerId, left: rect.left, offset: event.clientX - rect.right };
    handle.setPointerCapture?.(event.pointerId);
    body.classList.add(RESIZING_CLASS);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    api.setWidth(event.clientX - drag.offset - drag.left, { persist: false });
    syncAria({ withMax: false });
  });
  function finish(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    handle.releasePointerCapture?.(event.pointerId);
    body.classList.remove(RESIZING_CLASS);
    // 拖过上限时变量里是指针位置,这里收敛成看得见的宽度再存。
    api.setWidth(renderedWidth());
  }
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("lostpointercapture", finish);
  handle.addEventListener("dblclick", (event) => { event.preventDefault(); api.reset(); });
  handle.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
    if (step) {
      event.preventDefault();
      api.setWidth(renderedWidth() + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      api.reset();
    }
  });
  handle.addEventListener("focus", syncAria);
  return api;
}
