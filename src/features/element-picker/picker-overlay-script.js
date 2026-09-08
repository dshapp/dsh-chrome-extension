// 注入到目标页面的元素选取脚本。整个函数经 chrome.scripting.executeScript 序列化后
// 在页面 JS 引擎里执行,因此必须自包含:不得引用模块作用域的任何变量,不得 eval/new Function。
// 视觉对齐 Chrome DevTools 的 inspect 模式:蓝色半透明蒙层 + 元素标签气泡。
//
// 交互是「圈选即批注」的两态机:
//   hovering   —— 跟随鼠标画蒙层,点击选中一个元素后进入 annotating
//   annotating —— 在该元素上方就地弹出批注框,三个出口(提交 / 下一个 / 关闭)
// 批注文本合并进元素摘要后 push 进 __cmPickerQueue,由侧栏轮询 drain 取走;
// 「提交」「关闭」额外置一个标志位,让侧栏知道该发送还是该退出圈选模式。

/**
 * @param {{ maxTextLength?: number, labels?: object }} options 由调用方序列化传入。
 *   labels 里是已本地化的文案 —— 注入体拿不到模块作用域的 t(),只能由外部传进来。
 * @returns {{ ok: true, restarted: boolean }}
 */
export function elementPickerPageScript(options) {
  const maxTextLength = (options && options.maxTextLength) || 120;
  const rawLabels = (options && options.labels) || {};
  const labels = {
    submit: rawLabels.submit || "提交",
    next: rawLabels.next || "下一个",
    close: rawLabels.close || "退出圈选",
    placeholder: rawLabels.placeholder || "对这个元素说点什么…",
    annotated: rawLabels.annotated || "已批注 {n} 个",
  };
  const OVERLAY_ID = "__cm-element-picker-overlay";
  const LABEL_ID = "__cm-element-picker-label";
  const PANEL_ID = "__cm-element-picker-annotate";
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
  // "hovering" | "annotating"。annotating 期间蒙层锁定在 pendingNode 上,
  // 不再跟随鼠标 —— 否则用户往弹窗移动鼠标的路上高亮就跑了。
  let mode = "hovering";
  let pendingElement = null;
  let pendingNode = null;
  // 用户点击的那一点,存**页面坐标**(pageX/pageY):视口坐标会随滚动失效,
  // 页面滚动后弹窗就会跑到别的地方去。
  let pendingPoint = null;
  let panel = null;
  let textarea = null;
  // 本次圈选模式内已收下(点过「下一个」)的条数,只用于弹窗里的计数提示。
  let annotatedCount = 0;

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

  // 批注弹窗是真实可交互 DOM:所有 capture 阶段的吞噬必须对它整棵子树豁免,
  // 否则输入框既点不进也打不了字。composedPath 兜住 shadow DOM 里的转发。
  const isInPanel = event => {
    if (!panel) return false;
    const path = typeof event.composedPath === "function" ? event.composedPath() : null;
    if (path && path.indexOf(panel) !== -1) return true;
    const target = event.target;
    return Boolean(target && target.nodeType === 1 && panel.contains(target));
  };

  const targetAt = event => {
    const el = deepestAt(event.clientX, event.clientY);
    // 自己的浮层不可选;root/body 太大,选中它们没有意义。
    if (!el || el === overlay || el === label || el === root || el === doc.body) return null;
    if (panel && (el === panel || panel.contains(el))) return null;
    return el;
  };

  const onMouseMove = event => {
    if (mode === "annotating" || isInPanel(event)) return;
    const el = targetAt(event);
    if (!el) {
      hide();
      return;
    }
    hovered = el;
    paint(el);
  };

  // ---- 批注弹窗 ----

  const shortName = el => {
    let text = el.tagName ? el.tagName.toLowerCase() : "element";
    if (el.id) text += "#" + el.id;
    else if (typeof el.className === "string" && el.className.trim()) {
      text += "." + el.className.trim().split(/\s+/)[0];
    }
    return text.length > 40 ? text.slice(0, 40) + "…" : text;
  };

  const styleButton = (button, primary) => {
    // 同 panel:先把页面继承来的样式打回默认,再叠自己的。
    button.style.all = "revert";
    Object.assign(button.style, {
      opacity: "1", filter: "none", transform: "none", visibility: "visible",
      flex: "0 0 auto",
      padding: "5px 12px",
      borderRadius: "6px",
      border: primary ? "1px solid #3b82f6" : "1px solid #475569",
      background: primary ? "#3b82f6" : "transparent",
      color: primary ? "#ffffff" : "#e2e8f0",
      font: "500 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      cursor: "pointer",
    });
  };

  /// 弹窗锚在**用户点击的那一点**上:默认左上角与点击点对齐 ——
  /// 视线本来就在那儿,弹窗跟着手走比贴着元素边框更跟手(元素可能很大,
  /// 贴边框会把弹窗甩到离视线很远的地方)。
  ///
  /// 点击点可能落在视口边缘,直接对齐会把弹窗推出屏外。所以每个方向各留一手:
  /// 右边放不下就翻到点击点左侧(右下角对齐),下边放不下就翻到上方(左下角对齐)。
  /// 翻转后仍然放不下(视口比弹窗还小)就夹进视口,宁可盖住点击点也不能让用户看不见。
  const placePanel = () => {
    if (!panel || !pendingPoint) return;
    const width = panel.offsetWidth || 280;
    const height = panel.offsetHeight || 150;
    const gap = 8;
    // 存的是页面坐标,换算回视口坐标,弹窗才能随页面滚动一起移动。
    const x = pendingPoint.pageX - win.scrollX;
    const y = pendingPoint.pageY - win.scrollY;

    // 优先右下展开(左上角对齐点击点);右边不够就往左翻,让弹窗右缘贴住点击点。
    let left = x;
    if (left + width + gap > win.innerWidth) left = x - width;
    // 两侧都放不下(视口太窄):夹进视口,至少完整可见。
    left = Math.max(gap, Math.min(left, win.innerWidth - width - gap));

    let top = y;
    if (top + height + gap > win.innerHeight) top = y - height;
    top = Math.max(gap, Math.min(top, win.innerHeight - height - gap));

    panel.style.left = left + "px";
    panel.style.top = top + "px";
  };

  const closePanel = () => {
    if (panel) panel.remove();
    panel = null;
    textarea = null;
    pendingElement = null;
    pendingNode = null;
    pendingPoint = null;
    mode = "hovering";
  };

  /// 把当前批注合并进元素摘要并落进待取队列。
  /// 队列是可靠的真相来源:executeScript 注入体发出的 runtime 消息未必能被侧栏收到
  /// (它不是声明式 content script),侧栏会主动 drain 这个队列。
  const commit = () => {
    if (!pendingElement) return;
    const note = textarea && typeof textarea.value === "string" ? textarea.value.trim() : "";
    const element = {};
    for (const key in pendingElement) {
      if (Object.prototype.hasOwnProperty.call(pendingElement, key)) element[key] = pendingElement[key];
    }
    if (note) element.note = note;
    win.__cmPickerQueue = win.__cmPickerQueue || [];
    win.__cmPickerQueue.push(element);
    annotatedCount += 1;
    try {
      // 快通道:能收到就即时更新,收不到也不影响,drain 会兜住。
      chrome.runtime.sendMessage({ type: "ELEMENT_PICKED", element });
    } catch {
      // 扩展已重载(context invalidated)时静默失败,不干扰页面。
    }
  };

  /// 「下一个」:收下这一条,回到 hover 圈选态继续选。
  const commitNext = () => {
    commit();
    closePanel();
    hide();
  };

  /// 「提交」:收下这一条,再置标志位让侧栏把整轮发出去,然后自我收尾 ——
  /// 页面立刻恢复可用,不必等侧栏那一次异步往返。
  /// 顺序有意义:必须先 push 元素再置标志位,否则 drain 可能读到 submit 时元素还没入队。
  const commitSubmit = () => {
    commit();
    win.__cmPickerSubmit = true;
    stop();
  };

  /// 右上角关闭:丢弃这一条未提交的批注并退出圈选模式。
  /// 已经点过「下一个」收下的元素不受影响 —— 它们早已进了队列,侧栏药丸里留着。
  const cancelClose = () => {
    pendingElement = null;
    win.__cmPickerCancel = true;
    stop();
  };

  const buildPanel = el => {
    panel = doc.createElement("div");
    panel.id = PANEL_ID;
    // 宿主页面可能给通配选择器挂了 opacity / filter / transform / visibility,
    // 那些属性会继承下来,把弹窗变成半透明甚至看不见(example.com 上实测到过)。
    // 先用 all:revert 把继承来的一切打回浏览器默认值,再叠自己的样式 ——
    // 这比逐条列出要覆盖的属性可靠,新出现的干扰属性也一并挡住。
    panel.style.all = "revert";
    Object.assign(panel.style, {
      position: "fixed",
      zIndex: "2147483647",
      inlineSize: "280px",
      boxSizing: "border-box",
      padding: "10px",
      borderRadius: "8px",
      border: "1px solid #334155",
      background: "#1e293b",
      color: "#f8fafc",
      font: "400 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      boxShadow: "0 8px 24px rgba(0,0,0,.45)",
      // 弹窗自己要收事件,不能像蒙层那样 pointerEvents:none。
      pointerEvents: "auto",
      cursor: "auto",
      // 把这几条钉死:页面上的 opacity/filter/transform 会让弹窗透出底下的正文,
      // 文字叠在一起根本没法读。
      opacity: "1",
      filter: "none",
      transform: "none",
      visibility: "visible",
      // 独立成一个层叠上下文,免得页面的 mix-blend-mode 之类把它揉进背景。
      isolation: "isolate",
    });

    const head = doc.createElement("div");
    Object.assign(head.style, {
      display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px",
    });

    const title = doc.createElement("span");
    Object.assign(title.style, {
      flex: "1 1 auto", minInlineSize: "0",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      color: "#93c5fd", font: "600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    });
    title.textContent = shortName(el);

    const close = doc.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", labels.close);
    close.title = labels.close;
    Object.assign(close.style, {
      flex: "0 0 auto", inlineSize: "18px", blockSize: "18px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      padding: "0", border: "0", borderRadius: "50%",
      background: "transparent", color: "#94a3b8",
      font: "500 14px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      cursor: "pointer",
    });
    close.textContent = "×";
    close.addEventListener("click", cancelClose);

    head.appendChild(title);
    head.appendChild(close);

    textarea = doc.createElement("textarea");
    textarea.rows = 3;
    textarea.placeholder = labels.placeholder;
    textarea.style.all = "revert";
    Object.assign(textarea.style, {
      opacity: "1", filter: "none", transform: "none", visibility: "visible",
      inlineSize: "100%", boxSizing: "border-box", resize: "vertical",
      minBlockSize: "56px", padding: "6px 8px",
      borderRadius: "6px", border: "1px solid #475569",
      background: "#0f172a", color: "#f8fafc",
      font: "400 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      outline: "none",
    });

    const foot = doc.createElement("div");
    Object.assign(foot.style, {
      display: "flex", alignItems: "center", gap: "6px", marginTop: "8px",
    });

    const count = doc.createElement("span");
    Object.assign(count.style, {
      flex: "1 1 auto", minInlineSize: "0",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      color: "#94a3b8", fontSize: "11px",
    });
    count.textContent = annotatedCount > 0
      ? labels.annotated.replace("{n}", String(annotatedCount))
      : "";

    const next = doc.createElement("button");
    next.type = "button";
    next.textContent = labels.next;
    styleButton(next, false);
    next.addEventListener("click", commitNext);

    const submit = doc.createElement("button");
    submit.type = "button";
    submit.textContent = labels.submit;
    styleButton(submit, true);
    submit.addEventListener("click", commitSubmit);

    foot.appendChild(count);
    foot.appendChild(next);
    foot.appendChild(submit);

    // Escape 退出、⌘/Ctrl+Enter 提交。Enter 留给 textarea 换行 —— 批注可能是多行。
    // stopPropagation:别让这些键落到页面自身的快捷键上。
    panel.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelClose();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commitSubmit();
      }
    });

    panel.appendChild(head);
    panel.appendChild(textarea);
    panel.appendChild(foot);
    root.appendChild(panel);
  };

  const openPanel = (el, point) => {
    let element;
    try {
      // 摘要构建器由 picker-element-summary.js 作为独立注入体先挂到页面上。
      element = win.__cmPickerSummary.build(el);
    } catch {
      // 摘要失败(异常 DOM 或构建器缺失)时退化为最小信息,不静默丢掉这次选取。
      element = { tag: (el.tagName || "element").toLowerCase(), name: "", selector: "", xpath: "", ref: "" };
    }
    pendingElement = element;
    pendingNode = el;
    pendingPoint = point;
    mode = "annotating";
    // 高亮锁定在这个元素上,给「我正在批注它」一个持续的视觉锚点。
    paint(el);
    buildPanel(el);
    placePanel();
    try { textarea.focus(); } catch { /* 页面可能拦截 focus,不致命 */ }
  };

  const onClick = event => {
    // 弹窗内部的点击是正常交互,原样放行。
    if (isInPanel(event)) return;
    // 选取模式下吞掉页面自身的点击行为,避免误跳链接、误提交表单。
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    // 弹窗开着时点页面别处不换目标:先给出三个出口的答复,避免批注写到一半被顶掉。
    if (mode === "annotating") return;
    const el = targetAt(event) || hovered;
    if (!el) return;
    // 记下点击点(页面坐标)作为弹窗的锚。合成事件可能没有坐标,
    // 那就退回元素左上角,不至于把弹窗甩到视口原点。
    const hasPoint = typeof event.clientX === "number" && typeof event.clientY === "number"
      && (event.clientX !== 0 || event.clientY !== 0);
    const rect = el.getBoundingClientRect();
    const clientX = hasPoint ? event.clientX : rect.left;
    const clientY = hasPoint ? event.clientY : rect.top;
    openPanel(el, { pageX: clientX + win.scrollX, pageY: clientY + win.scrollY });
  };

  const swallow = event => {
    if (isInPanel(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  };

  const onScrollOrResize = () => {
    if (mode === "annotating") {
      // 元素随页面滚走时,锁定高亮要跟着一起动。
      if (pendingNode && pendingNode.isConnected) paint(pendingNode);
      // 弹窗锚在点击点上,与元素是否还连着无关 —— 它自己按页面坐标重新落位,
      // 顺带在窗口尺寸变化后重新做一次边缘避让。
      placePanel();
      return;
    }
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

  function stop() {
    doc.removeEventListener("mousemove", onMouseMove, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("mousedown", swallow, true);
    doc.removeEventListener("mouseup", swallow, true);
    root.removeEventListener("mouseleave", hide);
    win.removeEventListener("scroll", onScrollOrResize, true);
    win.removeEventListener("resize", onScrollOrResize, true);
    root.style.cursor = previousCursor;
    closePanel();
    overlay.remove();
    label.remove();
    win.__cmElementPicker = null;
  }

  win.__cmElementPicker = { stop };

  return { ok: true, restarted };
}
