// 聊天记录里图片的放大查看(lightbox)。
//
// 覆盖范围:用户自己发送的消息(附件图 .msg-imgs、通知正文图 .context-imgs)与
// agent 回复(图片块 .msg-agent-img、Markdown 图片 .md-body img、工具结果图
// .tool-result-img)。点击任意一张即打开全屏查看器。
//
// 用**委托**而不是给每张 <img> 挂监听:流式正文每帧 innerHTML 重建,Markdown 图片
// 由 md-to-html 直接产出字符串,逐个挂监听既漏又贵。查看器是全局唯一的 <dialog>,
// 走 showModal 进 top layer —— 即使是从卡片详情弹窗里点开的工具结果图,也会叠在
// 那个弹窗之上,Esc 只关最上面这一层。
//
// 交互:滚轮 / 触控板捏合缩放(以指针为中心),双击在「适应窗口 ↔ 放大」间切换,
// 放大后拖拽平移;同一条消息里有多张图时 ← / → 切换;Esc、点空白处或关闭键退出。
import { t } from "../../shared/i18n.js";
import { lucideIconSvg } from "./file-icons.js";

/// 可放大的图片。只认这几类容器里的 <img>,输入框附件 chip、插件图标等不参与。
export const ZOOMABLE_IMAGE_SELECTOR = [
  ".msg-imgs img",
  ".context-imgs img",
  "img.msg-agent-img",
  ".md-body img",
  "img.tool-result-img"
].join(", ");

/// 一组可切换的图:同一条消息 / 同一组图片里的兄弟。
const GALLERY_SELECTOR = [
  ".msg-user-turn",
  ".msg-img-group",
  ".context-imgs",
  ".md-body",
  ".tool-detail",
  ".card-detail-body"
].join(", ");

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const STEP = 1.25;
const EPSILON = 1e-3;

let singleton = null;
let installed = null;

/// 这张图现在能不能放大:必须真的画出来了(加载中 / 失败 / 无 src 都不算),
/// 且不在链接里(链接图片点击应当跟随链接)。
export function isZoomableImage(target) {
  if (!(target instanceof Element) || target.tagName !== "IMG") return false;
  if (!target.matches(ZOOMABLE_IMAGE_SELECTOR)) return false;
  if (target.closest("a[href]")) return false;
  if (target.closest("dialog.image-viewer")) return false;
  if (target.classList.contains("img-loading") || target.classList.contains("img-failed")) return false;
  return Boolean(target.currentSrc || target.getAttribute("src"));
}

/// 与 target 同组、可放大的图片列表(含 target 自己)。
export function galleryFor(target) {
  const scope = target.closest(GALLERY_SELECTOR) ?? target.parentElement;
  const list = scope ? [...scope.querySelectorAll(ZOOMABLE_IMAGE_SELECTOR)].filter(isZoomableImage) : [];
  return list.includes(target) ? list : [target];
}

/**
 * 在 root 上装一次点击委托(幂等)。返回卸载函数。
 * @param {Document|Element} root
 */
export function installImageViewer(root = document) {
  if (installed?.root === root) return installed.dispose;
  installed?.dispose();
  const onClick = (event) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const target = event.target;
    if (!isZoomableImage(target)) return;
    event.preventDefault();
    event.stopPropagation();
    const images = galleryFor(target);
    openImageViewer(images, images.indexOf(target));
  };
  root.addEventListener("click", onClick);
  const dispose = () => {
    root.removeEventListener("click", onClick);
    if (installed?.root === root) installed = null;
  };
  installed = { root, dispose };
  return dispose;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function iconButton(className, icon, label) {
  const button = el("button", "image-viewer-btn " + className);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = lucideIconSvg(icon, { size: 16 });
  return button;
}

function createViewer() {
  const dialog = el("dialog", "image-viewer");
  dialog.setAttribute("aria-label", t("imageViewer.title"));

  const stage = el("div", "image-viewer-stage");
  const img = el("img", "image-viewer-img");
  img.draggable = false;
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  stage.append(img);

  const bar = el("div", "image-viewer-bar");
  const counter = el("span", "image-viewer-counter");
  const zoomOut = iconButton("image-viewer-zoom-out", "minus", t("imageViewer.zoomOut"));
  const zoomLabel = el("button", "image-viewer-btn image-viewer-zoom-label");
  zoomLabel.type = "button";
  zoomLabel.title = t("imageViewer.fit");
  zoomLabel.setAttribute("aria-label", t("imageViewer.fit"));
  const zoomIn = iconButton("image-viewer-zoom-in", "plus", t("imageViewer.zoomIn"));
  const close = iconButton("image-viewer-close", "x", t("card.close"));
  bar.append(counter, zoomOut, zoomLabel, zoomIn, close);

  const prev = iconButton("image-viewer-nav image-viewer-prev", "chevron-left", t("imageViewer.previous"));
  const next = iconButton("image-viewer-nav image-viewer-next", "chevron-right", t("imageViewer.next"));
  const caption = el("div", "image-viewer-caption");

  dialog.append(stage, bar, prev, next, caption);
  document.body.append(dialog);

  const state = { images: [], index: 0, scale: MIN_SCALE, tx: 0, ty: 0, ownedUrl: null, drag: null, moved: false };

  function revokeOwned() {
    if (state.ownedUrl) URL.revokeObjectURL(state.ownedUrl);
    state.ownedUrl = null;
  }

  /// 「适应窗口」时图片的布局尺寸(CSS 已按舞台限高限宽,transform 不影响它)。
  function baseSize() {
    return { width: img.offsetWidth || 1, height: img.offsetHeight || 1 };
  }

  function clampPan() {
    const { width, height } = baseSize();
    const maxX = Math.max(0, (width * state.scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (height * state.scale - stage.clientHeight) / 2);
    state.tx = Math.min(maxX, Math.max(-maxX, state.tx));
    state.ty = Math.min(maxY, Math.max(-maxY, state.ty));
  }

  function apply() {
    clampPan();
    img.style.transform = "translate(" + state.tx + "px, " + state.ty + "px) scale(" + state.scale + ")";
    dialog.classList.toggle("zoomed", state.scale > MIN_SCALE + EPSILON);
    // 百分比相对原图像素:适应窗口时小于 100% 一眼可见图被缩了多少。
    const natural = img.naturalWidth || baseSize().width;
    zoomLabel.textContent = Math.round((baseSize().width * state.scale / natural) * 100) + "%";
    zoomOut.disabled = state.scale <= MIN_SCALE + EPSILON;
    zoomIn.disabled = state.scale >= MAX_SCALE - EPSILON;
  }

  /// 以舞台坐标 (cx, cy)(相对舞台中心)为不动点缩放到 scale。
  function zoomTo(scale, cx = 0, cy = 0) {
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const ratio = nextScale / state.scale;
    state.tx = cx - (cx - state.tx) * ratio;
    state.ty = cy - (cy - state.ty) * ratio;
    state.scale = nextScale;
    apply();
  }

  function resetZoom() {
    state.scale = MIN_SCALE;
    state.tx = 0;
    state.ty = 0;
    apply();
  }

  function stagePoint(event) {
    const box = stage.getBoundingClientRect();
    return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
  }

  /// 源图的 blob: URL 可能已被 LRU 回收(local-images.js 淘汰时 revoke),
  /// 但源 <img> 上的解码结果还在:从它画一份查看器自己持有的副本。
  function copyFromSource(source) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      if (!canvas.width || !canvas.height) return;
      canvas.getContext("2d").drawImage(source, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob || state.images[state.index] !== source) return;
        revokeOwned();
        state.ownedUrl = URL.createObjectURL(blob);
        img.src = state.ownedUrl;
      });
    } catch {
      // 跨源图片会污染画布:无从复制,保持失败态。
    }
  }

  function show(index) {
    const count = state.images.length;
    if (!count) return;
    state.index = (index + count) % count;
    const source = state.images[state.index];
    revokeOwned();
    img.onerror = () => {
      img.onerror = null;
      copyFromSource(source);
    };
    img.onload = () => resetZoom();
    img.src = source.currentSrc || source.getAttribute("src");
    img.alt = source.alt || "";
    caption.textContent = source.alt || "";
    caption.hidden = !source.alt;
    counter.textContent = count > 1 ? (state.index + 1) + " / " + count : "";
    counter.hidden = count <= 1;
    prev.hidden = count <= 1;
    next.hidden = count <= 1;
    resetZoom();
  }

  function hide() {
    if (typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    if (!dialog.open) return;
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
  }

  dialog.addEventListener("close", () => {
    revokeOwned();
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
    state.images = [];
    state.drag = null;
    dialog.classList.remove("panning", "zoomed");
  });

  close.addEventListener("click", hide);
  prev.addEventListener("click", () => show(state.index - 1));
  next.addEventListener("click", () => show(state.index + 1));
  zoomIn.addEventListener("click", () => zoomTo(state.scale * STEP));
  zoomOut.addEventListener("click", () => zoomTo(state.scale / STEP));
  zoomLabel.addEventListener("click", resetZoom);

  // 查看器内的按键不外泄给侧栏的全局快捷键(方向键、+/- 在这里有自己的含义)。
  dialog.addEventListener("keydown", (event) => {
    let handled = true;
    if (event.key === "ArrowLeft") show(state.index - 1);
    else if (event.key === "ArrowRight") show(state.index + 1);
    else if (event.key === "+" || event.key === "=") zoomTo(state.scale * STEP);
    else if (event.key === "-" || event.key === "_") zoomTo(state.scale / STEP);
    else if (event.key === "0") resetZoom();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  // 滚轮 / 触控板捏合(Chrome 里捏合是 ctrl+wheel):以指针为中心缩放。
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const { x, y } = stagePoint(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomTo(state.scale * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), x, y);
  }, { passive: false });

  img.addEventListener("dblclick", (event) => {
    event.preventDefault();
    if (state.scale > MIN_SCALE + EPSILON) {
      resetZoom();
      return;
    }
    // 放大到原图 1:1;原图本来就不比窗口大多少时放大一倍。
    const natural = img.naturalWidth / baseSize().width;
    const { x, y } = stagePoint(event);
    zoomTo(natural > 1.25 ? natural : 2, x, y);
  });

  // 放大后拖拽平移。moved 用来区分「拖完松手」与「单击空白关闭」。
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    state.moved = false;
    if (event.target !== img || state.scale <= MIN_SCALE + EPSILON) return;
    state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, tx: state.tx, ty: state.ty };
    stage.setPointerCapture?.(event.pointerId);
    dialog.classList.add("panning");
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    const drag = state.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
    state.tx = drag.tx + dx;
    state.ty = drag.ty + dy;
    apply();
  });
  const endDrag = (event) => {
    if (!state.drag || state.drag.id !== event.pointerId) return;
    state.drag = null;
    dialog.classList.remove("panning");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // 点图片以外的空白处关闭(拖拽结束不算)。
  stage.addEventListener("click", (event) => {
    if (state.moved) {
      state.moved = false;
      return;
    }
    if (event.target === stage) hide();
  });

  window.addEventListener("resize", () => {
    if (dialog.open) apply();
  });

  return {
    dialog,
    open(images, index) {
      state.images = images;
      if (!dialog.open) {
        // jsdom 没实现 showModal,测试里退化成普通打开。
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.open = true;
      }
      show(index);
      close.focus({ preventScroll: true });
    },
    hide
  };
}

function ensureViewer() {
  if (singleton?.dialog.isConnected) return singleton;
  singleton = createViewer();
  return singleton;
}

/**
 * 打开查看器。
 * @param {HTMLImageElement[]} images 可切换的一组图
 * @param {number} index 起始下标
 */
export function openImageViewer(images, index = 0) {
  const list = (images ?? []).filter(Boolean);
  if (!list.length) return null;
  const viewer = ensureViewer();
  viewer.open(list, Math.max(0, Math.min(list.length - 1, index)));
  return viewer.dialog;
}

/// 关闭查看器(会话切换 / 重置时调用)。
export function closeImageViewer() {
  if (singleton?.dialog.open) singleton.hide();
}

/// 只在测试里用:丢弃单例与委托。
export function _resetImageViewer() {
  installed?.dispose();
  singleton?.dialog.remove();
  singleton = null;
}
