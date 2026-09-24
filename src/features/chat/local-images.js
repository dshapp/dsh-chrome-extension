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

function entryFor(path, load) {
  const cached = cache.get(path);
  if (cached) { touch(path, cached); return cached; }
  const entry = { url: null, failed: false, pending: null };
  entry.pending = Promise.resolve()
    .then(() => load(path))
    .then((blob) => {
      // 只认图片 MIME:宿主按扩展名给 Content-Type,非图片文件不该进 <img>。
      if (!blob || !String(blob.type).startsWith("image/")) throw new Error("not an image");
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
