// 助手正文里的本地绝对路径图片(dsh 0.1.7,对齐 web AssistantMarkdown 的
// localPathMediaUrl / pathImages 与 Mac 7d3e1cd 的 DSWImageProvider.displayURL)。
//
// md-to-html 在 localImages 模式下把 ![alt](/abs/path.png) 产出成无 src 的
// <img class="md-local-img" data-local-path>;这里把它们经宿主 GET /api/file?path=…
// 读成 blob: 再挂上 src。为什么不直接 <img src="http://127.0.0.1:3080/api/file?…">:
// 这条路由要 cookie 鉴权(无 cookie 401),而扩展页发起的图片请求带
// Sec-Fetch-Site: cross-site,会被宿主 api-request-trust 直接 403 —— DNR 围栏规则
// 只对 xmlhttprequest/websocket 摘头。走 connection.getBlob 就复用了 fetch 的
// 鉴权重试与围栏绕行。
//
// 失败(404/403/413/非图片/解码失败)时换成 alt 文字(web MarkdownImage 的
// imageAlt:alt 为空时显示原路径)。
//
// 是不是图片按**字节**判,不只看 Content-Type:宿主 /api/file 按扩展名给 MIME,
// 无扩展名的文件一律 application/octet-stream —— 截图附件 ~/.dsh/attachments/v1/
// objects/<sha256> 正是这种(present / read_image 产出的路径)。web 直接
// <img src=/api/file…> 由浏览器按内容嗅探解码,Mac RemoteMarkdownImageLoader 用
// NSImage(data:) 也按内容解码,两端都能显示;只认 MIME 的话只有扩展里会退化成 alt。

/// blob: URL 缓存上限。每条都钉着一份图片字节,与 node-views 的附件图片缓存
/// 同一上限;淘汰时 revoke,已画出的 <img> 不受影响(解码结果留在元素上),
/// 之后再渲染同一路径就重读一次。
const LOCAL_IMAGE_CACHE_MAX = 32;
/// path → { url, failed, pending }。插入序即最近使用序,命中时移到队尾。
/// 失败也缓存:流式期间尾部每帧重建,不缓存失败会每帧打一次宿主。
const cache = new Map();

function touch(path, entry) {
  cache.delete(path);
  cache.set(path, entry);
}

function trim() {
  while (cache.size > LOCAL_IMAGE_CACHE_MAX) {
    let victim = null;
    for (const [key, value] of cache) {
      // 在途条目不淘汰:删了会让同一张图读两遍。
      if (!value.pending) { victim = key; break; }
    }
    if (victim === null) return;
    const { url } = cache.get(victim);
    cache.delete(victim);
    if (url) URL.revokeObjectURL(url);
  }
}

/// 位图签名,取自 WHATWG MIME Sniffing §6.1 的图片模式表(浏览器 <img> 嗅探
/// 认的就是这一组)。SVG 不在表里:它是文本,不按内容嗅探,web 端同样不显示。
const IMAGE_SIGNATURES = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
  // RIFF????WEBPVP:中间 4 字节是长度,null 表示任意。
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50] },
  { type: "image/bmp", bytes: [0x42, 0x4d] },
  { type: "image/x-icon", bytes: [0x00, 0x00, 0x01, 0x00] },
  { type: "image/x-icon", bytes: [0x00, 0x00, 0x02, 0x00] }
];
const SNIFF_LENGTH = 14;

/// 按文件头识别位图类型;不是已知位图返回 null。
export function sniffImageType(bytes) {
  for (const { type, bytes: pattern } of IMAGE_SIGNATURES) {
    if (bytes.length < pattern.length) continue;
    if (pattern.every((b, i) => b === null || bytes[i] === b)) return type;
  }
  return null;
}

/// 读回的 Blob → 可进 <img> 的图片 Blob;不是图片抛错(调用方换成 alt)。
/// 宿主已给出 image/* 时照用;给的是"类型未知"(octet-stream / 空,即无扩展名)时
/// 按文件头嗅探并改写类型;明确的非图片类型(text/plain 等)直接拒。
/// 已知类型同步返回,不为嗅探多付几个微任务。
const UNKNOWN_TYPES = new Set(["", "application/octet-stream"]);
function asImageBlob(blob) {
  if (!blob) throw new Error("not found");
  const mediaType = String(blob.type).toLowerCase().split(";")[0].trim();
  if (mediaType.startsWith("image/")) return blob;
  if (!UNKNOWN_TYPES.has(mediaType)) throw new Error("not an image");
  return blob.slice(0, SNIFF_LENGTH).arrayBuffer().then((buffer) => {
    const type = sniffImageType(new Uint8Array(buffer));
    if (!type) throw new Error("not an image");
    return blob.slice(0, blob.size, type);
  });
}

function entryFor(path, load) {
  const cached = cache.get(path);
  if (cached) { touch(path, cached); return cached; }
  const entry = { url: null, failed: false, pending: null };
  entry.pending = Promise.resolve()
    .then(() => load(path))
    // 非图片文件不该进 <img>:MIME 不是 image/* 时按文件头再判一次(见文件头注释)。
    .then(asImageBlob)
    .then((blob) => {
      entry.url = URL.createObjectURL(blob);
    })
    .catch(() => { entry.failed = true; })
    // 不在这里 trim:刚结算的条目可能被立刻淘汰并 revoke,紧接着的 paint 就挂了个
    // 失效地址。超界留给下一次插入时裁。
    .finally(() => { entry.pending = null; });
  cache.set(path, entry);
  trim();
  return entry;
}

function showAlt(img, path) {
  const span = document.createElement("span");
  span.className = "md-img-alt";
  span.textContent = img.alt || path;
  img.replaceWith(span);
}

function paint(img, path, entry) {
  if (entry.url) {
    img.addEventListener("error", () => showAlt(img, path), { once: true });
    img.src = entry.url;
  } else {
    showAlt(img, path);
  }
}

/**
 * 给 root 下尚未处理的本地路径占位图挂上 blob: src。
 * 处理过的占位会摘掉 data-local-path,冻结前缀(md-head)里的图不会被反复扫描。
 * @param {ParentNode} root 渲染容器。
 * @param {(path: string) => Promise<Blob|null>} load 读宿主 /api/file 的函数。
 */
export function hydrateLocalImages(root, load) {
  if (typeof load !== "function") return;
  for (const img of root.querySelectorAll("img[data-local-path]")) {
    // getAttribute 拿到的是 HTML 解码后的原始路径(md-to-html 写入的是转义态)。
    const path = img.getAttribute("data-local-path");
    img.removeAttribute("data-local-path");
    const entry = entryFor(path, load);
    if (entry.pending) void entry.pending.then(() => paint(img, path, entry));
    else paint(img, path, entry);
  }
}

/// 仅供测试观察缓存上限。
export function localImageCacheSize() { return cache.size; }
export const LOCAL_IMAGE_CACHE_LIMIT = LOCAL_IMAGE_CACHE_MAX;
