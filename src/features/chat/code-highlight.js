// 代码块语法着色。
//
// mdToHtml 是纯字符串函数,不碰 DOM —— 所以着色不在它里面做,而是在
// innerHTML 落地**之后**对 DOM 走一趟。入口是 chat-view 的 renderMarkdownInto,
// 那是全部 markdown 正文的唯一收口。
//
// 三件必须做对的事:
//
// 1. **流式不重复劳动。** 助手消息边流边渲染,同一条消息会被重画几十次。
//    已着色的块打上 data-highlighted 标记,重画时跳过 —— 否则每帧都要把
//    整条消息里所有代码块重新扫一遍,长回答里这是实打实的卡顿源。
//
// 2. **未闭合的块不着色。** 流到一半的代码块语法上是残缺的(字符串没收尾、
//    括号没配对),着色结果会随每个新字符大幅跳变,看起来像在抽搐。
//    mdToHtml 对未闭合 fence 也会产出 <pre>,所以这里靠"是不是最后一个块 +
//    消息是否还在流"来判断,由调用方传入 streaming 位。
//
// 3. **未知语言不报错。** hljs.highlight 遇到没注册的语言会抛
//    "Unknown language",而 data-language 里是模型随手写的任意字符串。
//    抛出来会中断整个渲染 —— 所以先查注册表,查不到就原样留着。

let hljsPromise = null;

/// 按需加载 hljs。与 KaTeX 同样的理由:~170KB(42 种语言)不该挡住侧栏首帧,
/// 而多数消息里没有代码块。
async function loadHljs() {
  if (!hljsPromise) {
    hljsPromise = import("../../vendor/highlight/highlight.esm.js")
      .then((mod) => mod.default ?? mod)
      // 加载失败降级成"不着色",不影响代码块本身的显示。
      .catch(() => null);
  }
  return hljsPromise;
}

/// 把 data-language 归一到 hljs 的语言名。模型常写 sh/shell/zsh、js、ts、yml 这类别名。
const LANGUAGE_ALIASES = Object.freeze({
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  yml: "yaml", html: "xml", htm: "xml", py: "python",
  golang: "go", rs: "rust", patch: "diff", md: "markdown",
  jsonc: "json", json5: "json", vue: "xml", svelte: "xml", svg: "xml",
  "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", h: "c",
  cs: "csharp", "c#": "csharp", kt: "kotlin", kts: "kotlin", rb: "ruby",
  ps1: "powershell", pwsh: "powershell", toml: "ini", conf: "ini",
  docker: "dockerfile", make: "makefile", mk: "makefile",
  objc: "objectivec", "objective-c": "objectivec", proto: "protobuf",
  gql: "graphql", hs: "haskell", ex: "elixir", exs: "elixir", pl: "perl",
  gradle: "groovy", txt: "plaintext"
});

function resolveLanguage(hljs, raw) {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!name || name === "text" || name === "plain") return null;
  const mapped = LANGUAGE_ALIASES[name] ?? name;
  // getLanguage 是查询,不抛;highlight 才抛。先查再用。
  return hljs.getLanguage(mapped) ? mapped : null;
}

/**
 * 给一棵子树里的代码块着色。
 *
 * @param {Element} root 容器(通常是 .msg-agent)。
 * @param {{streaming?: boolean}} options streaming 为 true 时跳过最后一个代码块 ——
 *        它可能还没流完,着色结果会随每个字符跳变。
 */
/// 单个块的着色。未知语言标记 skipped,免得每帧重试一个永远不会成功的块。
function highlightOne(hljs, code) {
  const language = resolveLanguage(hljs, code.parentElement?.dataset.language);
  if (!language) { code.dataset.highlighted = "skipped"; return; }
  try {
    const text = code.textContent ?? "";
    const { value } = hljs.highlight(text, { language, ignoreIllegals: true });
    code.innerHTML = value;
    code.dataset.highlighted = language;
  } catch {
    // 单个块着色失败不影响其余块,也不影响这条消息的其他内容。
    code.dataset.highlighted = "failed";
  }
}

/// 视口门控(web CodeBlock 的 lazy highlight):长记录里几十个代码块,
/// 只在滚到附近时才着色,避免首帧把整篇扫一遍。观察器按容器缓存。
const VIEW_MARGIN = "200px 0px";

function ensureObserver(root, hljs) {
  if (root.__hlObserver) return root.__hlObserver;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      delete entry.target.dataset.hlObserved;
      const code = entry.target.matches?.("pre")
        ? entry.target.querySelector("code")
        : entry.target;
      if (code && !code.dataset.highlighted) highlightOne(hljs, code);
    }
  }, { rootMargin: VIEW_MARGIN });
  root.__hlObserver = observer;
  return observer;
}

export async function highlightCodeBlocks(root, { streaming = false } = {}) {
  if (!root?.querySelectorAll) return;
  const all = [...root.querySelectorAll("pre[data-language] > code")];
  // 已着色的跳过:流式重画时这是绝大多数。
  const pending = all.filter((code) => !code.dataset.highlighted);
  if (!pending.length) return;

  const hljs = await loadHljs();
  if (!hljs) return;

  // 真浏览器里走视口门控;jsdom/离屏容器没有 IntersectionObserver 时立即着色。
  if (typeof IntersectionObserver === "function" && root.isConnected) {
    const observer = ensureObserver(root, hljs);
    for (const code of pending) {
      // 还在流的时候,最后一个块很可能没收尾 —— 留到收尾那一帧再观察。
      if (streaming && code === all[all.length - 1]) continue;
      const target = code.parentElement ?? code;
      if (target.dataset.hlObserved) continue;
      target.dataset.hlObserved = "1";
      observer.observe(target);
    }
    return;
  }

  for (const code of pending) {
    // 还在流的时候,最后一个块很可能没收尾 —— 留到收尾那一帧再着色。
    if (streaming && code === all[all.length - 1]) continue;
    highlightOne(hljs, code);
  }
}
