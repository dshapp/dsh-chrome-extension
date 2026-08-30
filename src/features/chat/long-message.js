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
  return {
    folded: true,
    // 只切前 limit 字符:后面的内容不进气泡的 DOM。
    preview: full.slice(0, limit),
    hidden: total - limit,
    total
  };
}

/// 把长文本切成分片列表。渲染层按帧逐片 append,主线程不会被单次巨量
/// 文本布局堵住。空文本返回空数组(不产出一个空片)。
export function chunkText(text, size = CHUNK_SIZE) {
  const full = typeof text === "string" ? text : "";
  if (!full) return [];
  const step = Number.isInteger(size) && size > 0 ? size : CHUNK_SIZE;
  const chunks = [];
  for (let index = 0; index < full.length; index += step) {
    chunks.push(full.slice(index, index + step));
  }
  return chunks;
}
