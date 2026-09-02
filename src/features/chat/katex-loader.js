// KaTeX 的加载与安装。
//
// 为什么不在 index.html 里写 <script src>:那是 268KB 的同步脚本,会挡住侧栏
// 首帧,而绝大多数会话里一条公式都没有。这里改成**按需异步加载** —— 首次遇到
// 公式时才拉,拉到之前公式降级成原文(renderMath 返回 null 时 md-to-html 已经
// 会这么做),拉到之后重绘一次。
//
// CSS 是另一回事:它只有 24KB,且必须在公式出现的**同一帧**就位,否则会看到
// 一瞬间的无样式公式(FOUC)。所以样式表由 index.html 静态引入,脚本异步来。
//
// KaTeX 0.16 提供 ESM 构建(katex.mjs),但我们 vendor 的是 katex.min.js(UMD,
// 268KB vs 588KB)。UMD 在 <script> 下会挂 window.katex —— 用动态 import() 加载
// UMD 会拿到空对象,所以这里走注入 <script> 标签这条路。

const SCRIPT_ID = "katex-vendor-script";

let loadPromise = null;

/// KaTeX 是否已可用。math-render 每次渲染都会自己查 globalThis.katex,
/// 这里只是给调用方一个不必碰全局的问法。
export function isKatexReady() {
  return Boolean(globalThis.katex?.renderToString);
}

/**
 * 确保 KaTeX 已加载。重复调用共享同一个 promise(不会重复注入脚本)。
 *
 * @returns {Promise<boolean>} 加载成功为 true;失败为 false(调用方降级,不抛)。
 */
export function ensureKatex() {
  if (isKatexReady()) return Promise.resolve(true);
  if (loadPromise) return loadPromise;
  // 没有 document 的环境(单测的纯 node 用例)直接判定不可用,而不是抛错。
  if (typeof document === "undefined") return Promise.resolve(false);

  loadPromise = new Promise((resolve) => {
    const existing = document.getElementById(SCRIPT_ID);
    const script = existing ?? document.createElement("script");
    script.id = SCRIPT_ID;
    script.addEventListener("load", () => resolve(isKatexReady()), { once: true });
    // 加载失败不抛:公式降级成原文,消息的其余部分照常显示。
    // loadPromise 保持 resolved(false),不再重试 —— 反复注入一个拉不到的
    // 脚本只会在每条消息上重复失败。
    script.addEventListener("error", () => resolve(false), { once: true });
    if (!existing) {
      script.src = new URL("../../vendor/katex/katex.min.js", import.meta.url).href;
      document.head.appendChild(script);
    }
  });
  return loadPromise;
}
