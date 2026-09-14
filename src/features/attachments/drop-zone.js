// 侧栏拖放:把文件拖到侧栏任意位置即加进附件区 —— 图片走 base64 内联,
// 非图片走 session/uploadFileBinary 真上传(见 attachments.js)。
//
// 这一层只认 DOM 与 DataTransfer,不认识附件的内部结构 —— 文件交给 onFiles,
// 文件夹交给 onRejected,校验/上传/预览全由 attachments 那边复用粘贴的同一条路。
//
// ⚠️ 为什么非图片能收:浏览器**刻意不暴露**拖入文件的真实路径。File 没有 .path
// (那是 Electron 的私有补丁),webkitGetAsEntry().fullPath 是沙箱虚拟路径,
// file input 的 value 规范强制为 "C:\\fakepath\\…"。所以靠路径打不开 .pdf,
// 但把文件字节真传给宿主(上传换 receiptId),agent 拿 receipt 就能读,不再依赖路径。

/// 拖的是文件吗?
///
/// 必须看 types 而不是 files:出于安全,dragover/dragenter 阶段读不到文件内容,
/// dataTransfer.files 在拖拽途中恒为空。想在"还没松手"时就决定要不要亮覆盖层,
/// 只有 types 可用。拖页面里选中的文字进来时 types 是 text/plain,据此天然排除。
export function hasFiles(dataTransfer) {
  const types = dataTransfer?.types;
  if (!types) return false;
  // types 可能是 DOMStringList(没有 includes),也可能是数组。
  return Array.from(types).includes("Files");
}

/// 把 drop 下来的文件分成"能收的图片"与"收不了的其余"。
export function partitionDropped(dataTransfer) {
  const files = Array.from(dataTransfer?.files ?? []);
  const images = files.filter((file) => String(file.type).startsWith("image/"));
  const others = files.filter((file) => !String(file.type).startsWith("image/"));
  // 拖**文件夹**时 dataTransfer.files 通常是空的,只有 items 里留下一条 kind="file"。
  // 不看 items 的话,拖文件夹会静默无反应 —— 用户以为侧栏坏了。
  if (!files.length) {
    const items = Array.from(dataTransfer?.items ?? []);
    if (items.some((item) => item.kind === "file")) return { images, others, opaque: true };
  }
  return { images, others, opaque: false };
}

/**
 * @param {HTMLElement} root 监听拖放的根(整个侧栏)
 * @param {object} options
 * @param {HTMLElement} options.overlay 拖拽中显示的覆盖层
 * @param {(files: File[]) => void} options.onFiles 收到图片
 * @param {() => void} options.onRejected 收到非图片/文件夹
 * @param {() => boolean} [options.isEnabled] false 时完全不响应(会话未就绪等)
 */
export function mountDropZone(root, { overlay, onFiles, onRejected, isEnabled = () => true }) {
  // dragenter/dragleave 在掠过**每一个子元素**时都会成对触发,直接在 dragleave
  // 里关覆盖层会让拖拽经过按钮/消息卡时疯狂闪烁。维护一个深度计数,归零才关。
  let depth = 0;

  function show() {
    overlay.hidden = false;
  }
  function hide() {
    depth = 0;
    overlay.hidden = true;
  }

  function onDragEnter(event) {
    if (!isEnabled() || !hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth += 1;
    show();
  }

  function onDragOver(event) {
    if (!isEnabled() || !hasFiles(event.dataTransfer)) return;
    // 不 preventDefault 的话浏览器不认这里是放置目标,drop 根本不会触发。
    event.preventDefault();
    // 让光标显示 "+" 而不是禁止符号。
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    // dragenter 可能先落在 window 兜底那层而没记到数,这里补一次显示。
    show();
  }

  function onDragLeave(event) {
    if (!hasFiles(event.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  }

  function onDrop(event) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    hide();
    if (!isEnabled()) return;
    const { images, others, opaque } = partitionDropped(event.dataTransfer);
    // 非图片文件现在走 session/uploadFileBinary 真上传,和图片同一条 onFiles 路;
    // 文件夹仍提示一次,拖 10 个文件夹不该刷 10 条 toast。
    if (images.length || others.length) onFiles([...images, ...others]);
    if (opaque) onRejected();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") hide();
  }

  /// window 兜底:浏览器对**未处理的**文件拖放的默认行为是用当前标签页打开该文件,
  /// 在侧栏里表现为整个侧栏被替换成一张图片 —— 最难看的失败模式。
  /// 所以即便落点不在响应区,也要在 window 级把默认行为吃掉。
  function swallow(event) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
  }

  root.addEventListener("dragenter", onDragEnter);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("dragover", swallow);
  window.addEventListener("drop", swallow);

  return {
    destroy() {
      root.removeEventListener("dragenter", onDragEnter);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
      hide();
    }
  };
}
