// 长用户消息的折叠策略。
//
// 用户把一大段文本(日志 / 报错 / 整份文件)贴给 AI 时,消息气泡会把滚动区
// 撑得极长,历史无法浏览。这里只做"策略判定 + 切片",不碰 DOM —— 渲染层
// 拿判定结果决定是否加"查看全部"入口,弹窗内容由 card-detail 惰性构建。
//
// 性能上有两条硬约束:
//   1. 气泡里永远只放 FOLD_LIMIT 个字符,不管原文多长 —— 折叠不是 CSS
//      max-height(那样全文仍在 DOM 里,依旧卡),而是真的不建这部分节点。
//   2. 弹窗全文按 CHUNK_SIZE 分片渲染,避免一次性把百万字符塞进一个文本节点
//      触发同步 layout 卡死主线程。

/// 超过这个字符数才折叠。用户诉求就是 1000 字。
export const FOLD_LIMIT = 1000;

/// 弹窗里每个文本分片的大小。单个 Text 节点过大时浏览器换行计算会明显掉帧,
/// 切成 4k 一片能让首屏立刻可见,余下分片逐帧补齐。
export const CHUNK_SIZE = 4000;

/// 判定一段消息文本要不要折叠,并给出气泡里该显示的前缀。
///
/// 返回 { folded, preview, hidden, total }:
/// - folded:是否需要折叠(true 时渲染层才加"查看全部")
/// - preview:气泡里实际渲染的文本(未折叠时即原文)
/// - hidden:被折叠掉的字符数,用于文案提示
export function foldMessageText(text, limit = FOLD_LIMIT) {
  const full = typeof text === "string" ? text : "";
  const total = full.length;
  if (total <= limit) {
    return { folded: false, preview: full, hidden: 0, total };
  }
  // JS 字符串按 UTF-16 码元索引,emoji 这类星际字符占两个码元。正好切在中间会
  // 在气泡末尾留下一个孤立的高位代理,浏览器渲染成 "�"。切点退一格,让整个
  // 代理对留到折叠区去。
  const cut = isHighSurrogate(full.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return {
    folded: true,
    // 只切前 cut 字符:后面的内容不进气泡的 DOM。
    preview: full.slice(0, cut),
    hidden: total - cut,
    total
  };
}

/// 高位代理(U+D800..U+DBFF)必须和紧随其后的低位代理成对出现才是一个字符。
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/// 把长文本切成分片列表。渲染层按帧逐片 append,主线程不会被单次巨量
/// 文本布局堵住。空文本返回空数组(不产出一个空片)。
export function chunkText(text, size = CHUNK_SIZE) {
  const full = typeof text === "string" ? text : "";
  if (!full) return [];
  const step = Number.isInteger(size) && size > 0 ? size : CHUNK_SIZE;
  const chunks = [];
  let index = 0;
  while (index < full.length) {
    let end = Math.min(index + step, full.length);
    // 切点落在代理对中间时退一格,让整个字符进下一片。相邻 Text 节点排版时会
    // 重新拼合,所以弹窗里看不出来;但每一片单独拿出去(复制、逐片外发)就是
    // 一个非法 Unicode 串。退格不会吞字:被让出的码元是下一片的开头。
    if (end < full.length && isHighSurrogate(full.charCodeAt(end - 1))) end -= 1;
    // step 为 1 且正好卡在代理对上时 end 会退回 index,只能整对一起放行,
    // 否则循环不前进。
    if (end <= index) end = Math.min(index + step + 1, full.length);
    chunks.push(full.slice(index, end));
    index = end;
  }
  return chunks;
}
