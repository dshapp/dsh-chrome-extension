// 点开输入框顶部的附件胶囊。
//
// 图片胶囊在侧栏里用查看器(lightbox)放大,由 app 层接;这里只管**非图片文件**。
//
// 打开顺序:
// 1. 知道真实路径(拖入 / 从访达粘贴时由 native host 读 pasteboard 得到,见
//    composer-attachments.js)→ 交给宿主 openPath,用系统默认应用打开,与对话里
//    点文件链接、交付卡同一条路。路径失效(文件已被移走)时退回 2。
// 2. 没有路径(文件选择器选的、宿主读不到 pasteboard)→ 浏览器只有 File 字节:
//    包成 blob: URL 在新标签页打开。浏览器能显示的(PDF、常见位图、音视频、文本)
//    直接显示;显示不了的(docx/zip 等)下载一份副本,下载栏里可以直接打开。
//
// ⚠️ blob: URL 继承侧栏的扩展源。HTML / SVG 这类能带脚本的内容一律按纯文本
// 显示,绝不以原类型在扩展源下渲染。

/// 浏览器能原样显示、且不会执行脚本的类型。
const RASTER_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif", "image/x-icon", "image/vnd.microsoft.icon"
]);
const SNIFF_BYTES = 8192;
const TEXT_TYPE = "text/plain;charset=utf-8";

/// 文件开头像不像文本:没有 NUL,且是合法 UTF-8(末尾被截断的多字节字符不算错)。
export async function looksLikeText(file) {
  if (!file || typeof file.slice !== "function") return false;
  let bytes;
  try {
    bytes = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  } catch {
    return false;
  }
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/// 在新标签页里用什么类型显示这个文件;null = 浏览器显示不了。
/// 文本嗅探排在音视频之前:.ts 源码会被浏览器标成 video/mp2t。
export async function browserViewType(file) {
  const type = String(file?.type ?? "").toLowerCase().split(";")[0].trim();
  if (type === "application/pdf" || RASTER_IMAGE_TYPES.has(type)) return type;
  if (await looksLikeText(file)) return TEXT_TYPE;
  if (type.startsWith("audio/") || type.startsWith("video/")) return type;
  return null;
}

function defaultDownload(url, name) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || "file";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * 管理打开附件时创建的 blob: URL。同一个 File 反复点开复用同一条 URL;
 * 附件从输入框移走(或整条发出)后由 release() 回收。
 * @param {object} options
 * @param {(url: string) => void} options.openUrl 新标签页打开
 * @param {(url: string, name: string) => void} [options.download] 浏览器显示不了时下载副本
 */
export function createAttachmentOpener({ openUrl, download = defaultDownload } = {}) {
  const urls = new Map();   // File → { url, viewType }

  async function urlFor(file) {
    const cached = urls.get(file);
    if (cached) return cached;
    const viewType = await browserViewType(file);
    // 重新包一层 Blob 只为换 type:字节仍由原 File 承载,不复制。
    const blob = new Blob([file], { type: viewType ?? (file.type || "application/octet-stream") });
    const entry = { url: URL.createObjectURL(blob), viewType };
    urls.set(file, entry);
    return entry;
  }

  return {
    /// 返回 "tab"(新标签页里显示)或 "download"(下载了一份副本)。
    async openInBrowser(file) {
      const { url, viewType } = await urlFor(file);
      if (viewType) {
        openUrl(url);
        return "tab";
      }
      download(url, file.name);
      return "download";
    },
    /// 回收不再在输入框里的文件的 URL;不传 keep 则全部回收。
    release(keep = []) {
      const alive = new Set(keep);
      for (const [file, { url }] of urls) {
        if (alive.has(file)) continue;
        URL.revokeObjectURL(url);
        urls.delete(file);
      }
    }
  };
}
