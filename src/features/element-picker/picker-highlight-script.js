// 注入到目标页面的元素高亮脚本。与 picker-overlay-script.js 同样是自包含注入体:
// 不得引用模块作用域变量、不得 eval。独立于选取模式的 overlay,因此选取模式开或关都能用。

/**
 * 注入体:侧栏列表 hover 时在页面上高亮对应元素。
 * 与选取模式的 overlay 分开,自己一层独立蒙层,因此选取模式开或关都能用。
 * @param {{ ref?: string, selector?: string, scroll?: boolean }} target 传 null/空对象则清除高亮。
 */
export function elementPickerHighlightScript(target) {
  const HIGHLIGHT_ID = "__cm-element-picker-highlight";
  const win = window;
  const doc = document;
  const existing = doc.getElementById(HIGHLIGHT_ID);

  const clear = () => {
    if (existing) existing.remove();
    return { highlighted: false };
  };

  if (!target || (!target.ref && !target.selector)) return clear();

  // 优先用 picker 自己的 ref 表(不会被 read_page 重置),失效再退回 selector。
  let el = null;
  if (target.ref) {
    const handle = (win.__cmPickerMap || {})[target.ref];
    el = handle && handle.deref ? handle.deref() : handle;
  }
  if ((!el || !el.isConnected) && target.selector) {
    try {
      el = doc.querySelector(target.selector);
    } catch {
      el = null;
    }
  }
  if (!el || !el.isConnected) return clear();

  const box = existing || doc.createElement("div");
  if (!existing) {
    box.id = HIGHLIGHT_ID;
    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483644",
      background: "rgba(59,130,246,.28)",
      outline: "2px solid #3b82f6",
      pointerEvents: "none",
      borderRadius: "2px",
    });
    doc.documentElement.appendChild(box);
  }

  if (target.scroll) el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  box.style.left = rect.left + "px";
  box.style.top = rect.top + "px";
  box.style.width = Math.max(0, rect.width) + "px";
  box.style.height = Math.max(0, rect.height) + "px";
  return {
    highlighted: true,
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
}