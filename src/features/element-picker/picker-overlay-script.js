// 注入到目标页面的元素选取脚本。整个函数经 chrome.scripting.executeScript 序列化后
// 在页面 JS 引擎里执行,因此必须自包含:不得引用模块作用域的任何变量,不得 eval/new Function。
// 视觉对齐 Chrome DevTools 的 inspect 模式:蓝色半透明蒙层 + 元素标签气泡。

/**
 * @param {{ maxTextLength?: number }} options 由调用方序列化传入。
 * @returns {{ ok: true, restarted: boolean }}
 */
export function elementPickerPageScript(options) {
  const maxTextLength = (options && options.maxTextLength) || 120;
  const OVERLAY_ID = "__cm-element-picker-overlay";
  const LABEL_ID = "__cm-element-picker-label";
  const win = window;
  const doc = document;

  // 幂等:重复注入(切换标签页、页面导航后重注入)先拆掉上一份。
  const restarted = Boolean(win.__cmElementPicker);
  if (win.__cmElementPicker && typeof win.__cmElementPicker.stop === "function") {
    win.__cmElementPicker.stop();
  }

  const overlay = doc.createElement("div");
  overlay.id = OVERLAY_ID;
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483645",
    background: "rgba(59,130,246,.35)",
    outline: "1px solid #3b82f6",
    pointerEvents: "none",
    display: "none",
    borderRadius: "2px",
    transition: "none",
  });

  const label = doc.createElement("div");
  label.id = LABEL_ID;
  Object.assign(label.style, {
    position: "fixed",
    zIndex: "2147483646",
    background: "#1e293b",
    color: "#f8fafc",
    font: "500 11px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "3px 6px",
    borderRadius: "4px",
    pointerEvents: "none",
    display: "none",
    whiteSpace: "nowrap",
    boxShadow: "0 2px 8px rgba(0,0,0,.35)",
  });

  const root = doc.documentElement;
  root.appendChild(overlay);
  root.appendChild(label);

  let hovered = null;

  const paint = el => {
    const rect = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = Math.max(0, rect.width) + "px";
    overlay.style.height = Math.max(0, rect.height) + "px";
    let text = el.tagName.toLowerCase();
    if (el.id) text += "#" + el.id;
    else if (typeof el.className === "string" && el.className.trim()) {
      text += "." + el.className.trim().split(/\s+/)[0];
    }
    label.textContent = text + "  " + Math.round(rect.width) + "×" + Math.round(rect.height);
    label.style.display = "block";
    const above = rect.top >= 22;
    label.style.left = Math.max(2, Math.min(rect.left, win.innerWidth - 160)) + "px";
    label.style.top = (above ? rect.top - 20 : Math.min(rect.bottom + 4, win.innerHeight - 20)) + "px";
  };

  const hide = () => {
    overlay.style.display = "none";
    label.style.display = "none";
    hovered = null;
  };

  // 命中最内层元素:elementFromPoint 只返回宿主节点,需要逐层进 shadow root,
  // 否则 Web Component 内部的小元素永远只能选到外层宿主。
  const deepestAt = (x, y) => {
    let el = doc.elementFromPoint(x, y);
    if (!el) return null;
    for (let depth = 0; depth < 20; depth++) {
      const shadow = el.shadowRoot;
      if (!shadow || typeof shadow.elementFromPoint !== "function") break;
      const inner = shadow.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  const targetAt = event => {
    const el = deepestAt(event.clientX, event.clientY);
    // 自己的浮层不可选;root/body 太大,选中它们没有意义。
    if (!el || el === overlay || el === label || el === root || el === doc.body) return null;
    return el;
  };

  const onMouseMove = event => {
    const el = targetAt(event);
    if (!el) {
      hide();
      return;
    }
    hovered = el;
    paint(el);
  };

  const onClick = event => {
    const el = targetAt(event) || hovered;
    // 选取模式下吞掉页面自身的点击行为,避免误跳链接、误提交表单。
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    if (!el) return;
    let element;
    try {
      // 摘要构建器由 picker-element-summary.js 作为独立注入体先挂到页面上。
      element = win.__cmPickerSummary.build(el);
    } catch {
      // 摘要失败(异常 DOM 或构建器缺失)时退化为最小信息,不静默丢掉这次选取。
      element = { tag: (el.tagName || "element").toLowerCase(), name: "", selector: "", xpath: "", ref: "" };
    }
    // 先落进页面上的待取队列:这是可靠的真相来源。
    // executeScript 注入体发出的 runtime 消息未必能被 side panel 收到(它不是声明式
    // content script),所以不能只靠 sendMessage —— side panel 会主动 drain 这个队列。
    win.__cmPickerQueue = win.__cmPickerQueue || [];
    win.__cmPickerQueue.push(element);
    try {
      // 快通道:能收到就即时更新,收不到也不影响,drain 会兜住。
      chrome.runtime.sendMessage({ type: "ELEMENT_PICKED", element });
    } catch {
      // 扩展已重载(context invalidated)时静默失败,不干扰页面。
    }
  };

  const swallow = event => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  };

  const onScrollOrResize = () => {
    if (hovered && hovered.isConnected) paint(hovered);
    else hide();
  };

  doc.addEventListener("mousemove", onMouseMove, true);
  doc.addEventListener("click", onClick, true);
  // mousedown/mouseup 也吞掉,否则页面可能在 mousedown 阶段就响应。
  doc.addEventListener("mousedown", swallow, true);
  doc.addEventListener("mouseup", swallow, true);
  // 只在指针真正离开文档时隐藏。mouseleave 不冒泡,若用 capture 监听 document,
  // 指针在嵌套元素之间移动时每离开一个子元素都会触发,导致小元素刚 hover 上就被隐藏、
  // 根本选不中(必须用 documentElement 上的非 capture 监听)。
  root.addEventListener("mouseleave", hide);
  win.addEventListener("scroll", onScrollOrResize, true);
  win.addEventListener("resize", onScrollOrResize, true);

  const previousCursor = root.style.cursor;
  root.style.cursor = "crosshair";

  win.__cmElementPicker = {
    stop() {
      doc.removeEventListener("mousemove", onMouseMove, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("mousedown", swallow, true);
      doc.removeEventListener("mouseup", swallow, true);
      root.removeEventListener("mouseleave", hide);
      win.removeEventListener("scroll", onScrollOrResize, true);
      win.removeEventListener("resize", onScrollOrResize, true);
      root.style.cursor = previousCursor;
      overlay.remove();
      label.remove();
      win.__cmElementPicker = null;
    },
  };

  return { ok: true, restarted };
}