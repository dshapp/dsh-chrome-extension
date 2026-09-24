// Markdown 图片的 src 白名单。
//
// 为什么单独成模块:这是一条**安全边界**,不是渲染细节。md-to-html 把整段文本
// 先转义再套标签,所以正文里的 <img> 永远逃不出去;但 ![](...) 是我们**主动**
// 生成的标签,src 的内容直接来自模型输出 —— 那是唯一一处"用户可控字符串进入
// 属性位置"的地方,判定必须能被单独测、单独审。
//
// 放行的只有两类:
//
// 1. https: —— 侧栏是扩展页(chrome-extension:),MV3 默认 CSP 的 img-src 允许
//    https 与 data:。http: 明确**不放行**:它在扩展页里属于混合内容,会被浏览器
//    直接拦掉,渲染成一个碎图标比不渲染更糟(用户以为图挂了,其实是协议问题)。
// 2. data:image/<png|jpeg|gif|webp>;base64, —— 工具结果里的截图就是这个形状。
//    限定 base64 且限定四种图片 MIME:data:image/svg+xml 不在其中,SVG 能带
//    <script>,是图片里唯一能执行代码的格式。
//
// 第三类是 isLocalImagePath 放行的**绝对本地路径**(dsh 0.1.7,对齐 web
// AssistantMarkdown.localPathMediaUrl):它不直接进 src,而是由调用方经宿主
// 鉴权路由 /api/file?path=… 读成 blob: 再挂上去(见 features/chat/local-images.js)。
// 读哪些文件由宿主的文件系统策略裁决,这里只保证它形如本地绝对路径。
//
// 其余一律拒绝(javascript:、vbscript:、file:、blob:、相对路径……)。拒绝的做法
// 是让调用方**按字面文本输出**,而不是生成一个空 src 的 <img> —— 前者用户看得见
// 原文,后者只留一个碎图标,把模型写错的链接藏了起来。

// data URI:只认四种位图 MIME + base64。参数段(charset 之类)不放行,
// 多一个可变位置就多一处要论证的地方,而截图这条路径根本不需要它。
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

// https 且必须有主机名。裸 "https:" 或 "https://" 不是地址。
const HTTPS_URL = /^https:\/\/[^\s/?#]+[^\s]*$/i;

/**
 * 这个 src 能否安全地进入 <img src="...">。
 *
 * 输入是**已被 escapeHtml 转义过**的片段(& → &amp;),因为 md-to-html 先整体
 * 转义再匹配行内语法。转义只会把 & < > " 变长,不会凭空造出新的协议前缀,
 * 所以在转义态上判协议是安全的;而 & 保持转义态直接进属性也正是我们要的。
 *
 * @param {string} src 待检查的地址(转义态)。
 * @returns {boolean} 放行为 true。
 */
export function isSafeImageSrc(src) {
  const value = String(src ?? "").trim();
  if (!value) return false;
  // 控制字符会被浏览器在解析协议时忽略,于是 "java\0script:" 这类写法能绕过
  // 朴素的前缀检查。这里直接拒绝,而不是先清洗再判断 —— 清洗要考虑清洗顺序,
  // 拒绝不用。
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return HTTPS_URL.test(value) || DATA_IMAGE.test(value);
}

/**
 * 这个图片地址是否是宿主能按 /api/file 读的**绝对 POSIX 路径**。
 *
 * 规则逐字对齐 web localPathMediaUrl:以 "/" 开头且不是 "//"(协议相对地址,
 * 指向别的主机)。file:// 与 Windows 路径(C:\…)同 web 一样不放行,原样按
 * 文字输出。输入同样是转义态;"/" 前缀不受转义影响。控制字符照 isSafeImageSrc
 * 的理由直接拒绝(宿主对 \0 也回 400)。
 *
 * @param {string} src 待检查的地址(转义态)。
 * @returns {boolean} 放行为 true。
 */
export function isLocalImagePath(src) {
  const value = String(src ?? "");
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}
