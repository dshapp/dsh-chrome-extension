// 助手正文里的链接点击:文件链接走宿主打开,网页链接开新标签页。
//
// 对齐 web MarkdownText 的两条出口:
// - 文件目标([a.tsx:12](<src/a.tsx#L12>))→ openFile(path, { line })。web 在右侧
//   预览栏打开;侧栏是扩展页,file: 打不开,所以走宿主 openPath(默认应用),
//   与工具行、交付卡的文件点击同一条路。相对路径按会话 cwd 解析由调用方负责。
// - 网页链接(显式 [x](https://…)、裸 URL、整段是网址的行内 code)→ openUrl。
//   web 的 openExternalLink 优先开在内置浏览器侧栏;这里浏览器本身就是 Chrome,
//   所以用 chrome.tabs.create 在当前窗口开新标签页。带修饰键(⌘/Ctrl/Shift/Alt)
//   或非左键的点击交还给浏览器默认行为 —— 与 web 一致,用户要后台打开、新窗口
//   打开时不被拦。
//
// 监听挂在正文容器上做委托:增量渲染每帧重建尾部 DOM,逐个 <a> 绑定会丢。
import { fileTypeIconName, lucideIconSvg } from "./file-icons.js";

function plainClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/// 浏览器扩展环境里在新标签页打开;没有 chrome.tabs(单测/普通页)时退回 window.open。
export function openUrlInNewTab(url) {
  const tabs = globalThis.chrome?.tabs;
  if (typeof tabs?.create === "function") {
    void Promise.resolve(tabs.create({ url, active: true })).catch(() => {
      globalThis.open?.(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

/**
 * 在容器上装(一次)链接点击委托;handlers 每次调用都会更新,
 * 所以上下文(cwd、回调)变化后无需重绑。
 * @param {Element} root 正文容器。
 * @param {{openFile?: (path: string, options?: {line?: number}) => void, openUrl?: (url: string) => void}} handlers
 */
export function bindLinkActions(root, handlers = {}) {
  if (!root) return;
  root.__linkHandlers = handlers;
  if (root.__linkBound) return;
  root.__linkBound = true;
  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest("a");
    if (!anchor || !root.contains(anchor)) return;
    const current = root.__linkHandlers ?? {};
    if (anchor.classList.contains("md-file-link")) {
      // href="#" 只为可聚焦,无论如何都不能让它跳页。
      event.preventDefault();
      event.stopPropagation();
      const path = anchor.dataset.path;
      if (!path || typeof current.openFile !== "function") return;
      const line = Number(anchor.dataset.line);
      current.openFile(path, Number.isInteger(line) && line > 0 ? { line } : undefined);
      return;
    }
    const href = anchor.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href) || !plainClick(event)) return;
    event.preventDefault();
    (typeof current.openUrl === "function" ? current.openUrl : openUrlInNewTab)(href);
  });
}

/// 文件链接前补一个文件类型图标(web MarkdownText 的 FileTypeIcon 字形)。
/// 增量渲染里冻结前缀的链接已带图标,靠 data-icon 跳过。
export function decorateFileLinks(root) {
  if (!root?.querySelectorAll) return;
  for (const link of root.querySelectorAll("a.md-file-link:not([data-icon])")) {
    link.dataset.icon = "1";
    // 标签整段是图片时不加字形(web: glyph = !children.every(image))。
    if (link.querySelector("img") && !link.textContent.trim()) continue;
    const icon = document.createElement("span");
    icon.className = "md-file-link-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = lucideIconSvg(fileTypeIconName(link.dataset.path ?? ""), { size: 12 });
    link.prepend(icon);
  }
}
