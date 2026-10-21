// 流式 Markdown 的增量渲染。
//
// 对齐 web 的 incremental.ts:把出现较早的块冻结成"前缀",每帧只重解析尾部
// UNSTABLE_TAIL_BLOCKS 个块。冻结靠一个容器对做:head 只在切点变化时重建,
// 其上的 DOM(含代码着色的 <span>)原地保留;tail 每帧重建。
//
// 切点必须落在**代码围栏之外的空白行之后**:renderTextBlock 在空白行会重置
// 段落/列表/表格,而围栏内换行是代码内容,不能切。
import { mdToHtml, readFence, isClosingFence } from "../../shared/md-to-html.js";
import { decorateCodeBlocks, mayContainMath } from "./chat-view.js";
import { highlightCodeBlocks } from "./code-highlight.js";
import { ensureKatex, isKatexReady } from "./katex-loader.js";
import { hydrateLocalImages, settleFailedImages } from "./local-images.js";

/// 与 web 一致:最后这两个块视为仍在变化,不做冻结。
export const UNSTABLE_TAIL_BLOCKS = 2;

/// 找一个安全切点(尾部块的起点),找不到返回 null。
export function stableCut(markdown, unstableBlocks = UNSTABLE_TAIL_BLOCKS) {
  const text = String(markdown ?? "");
  const starts = [0];
  let offset = 0;
  let inCode = false;
  let fenceRun = 0;
  for (const line of text.split("\n")) {
    const length = line.length + 1;   // 含被 split 掉的换行
    // 与 md-to-html 共用同一套围栏判定:开栅栏记下反引号个数,只有不短于它
    // 且不带信息串的纯反引号行才算关闭。否则 4 反引号块里的 ``` 行会被当成
    // 关闭,切点落进代码块,head/tail 各渲染半块。
    if (inCode) {
      if (isClosingFence(line, fenceRun)) inCode = false;
    } else {
      const fence = readFence(line);
      if (fence) { inCode = true; fenceRun = fence.run; }
      else if (line.trim() === "") starts.push(offset + length);
    }
    offset += length;
  }
  // 尾随空白不构成"块":流式中的末尾空行不该把倒数第二个真块算成不稳定。
  while (starts.length > 1 && text.slice(starts[starts.length - 1]).trim() === "") starts.pop();
  if (starts.length <= unstableBlocks) return null;
  return starts[starts.length - unstableBlocks];
}

/// 渲染/更新一个"增量 markdown"宿主元素(内部自建 .md-head + .md-tail)。
/// loadLocalImage:给了就开 md-to-html 的 localImages,把本地路径占位图经它读成
/// blob:(local-images.js,对齐 web AssistantMarkdown pathImages);只有助手正文传。
export function renderIncrementalMarkdown(host, text, { streaming = false, force = false, loadLocalImage = null } = {}) {
  const source = String(text ?? "");
  const md = loadLocalImage ? { localImages: true } : undefined;
  let state = host.__inc;
  if (!state) {
    state = host.__inc = { text: null, cut: undefined, head: null, tail: null };
    state.head = document.createElement("div");
    state.head.className = "md-head";
    state.tail = document.createElement("div");
    state.tail.className = "md-tail";
    host.append(state.head, state.tail);
  }
  if (!force && state.text === source) return;
  const cut = stableCut(source);
  if (cut !== state.cut) {
    state.head.innerHTML = cut == null ? "" : mdToHtml(source.slice(0, cut), md);
    state.tail.innerHTML = mdToHtml(cut == null ? source : source.slice(cut), md);
    state.cut = cut;
  } else {
    state.tail.innerHTML = mdToHtml(source.slice(cut ?? 0), md);
  }
  state.text = source;
  // "](/" 或 "](</" 是占位图产出的必要条件,没有就不扫 DOM(流式每帧都会走到这里)。
  if (md && (source.includes("](/") || source.includes("](</"))) hydrateLocalImages(host, loadLocalImage);
  settleFailedImages(host);

  decorateCodeBlocks(host);
  void highlightCodeBlocks(host, { streaming });

  // 首次出现公式时按需拉 KaTeX,到位后整体重画一次 head+tail。
  if (mayContainMath(source) && !isKatexReady()) {
    void ensureKatex().then((ready) => {
      if (!ready || !host.isConnected) return;
      state.cut = undefined;
      state.text = null;
      renderIncrementalMarkdown(host, source, { streaming, force: true, loadLocalImage });
    });
  }
}
