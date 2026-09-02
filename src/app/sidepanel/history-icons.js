// 历史行的行内操作图标(分叉 / 重命名 / 归档)。
//
// 从 sidepanel-overlays.js 抽出来:这是**静态呈现数据**,与浮层的搜索、
// 键盘导航、排序等行为没有关系,而那个文件已经贴着 400 行的硬上限。
//
// 图标取自 Lucide(https://github.com/lucide-icons/lucide,ISC),沿用官方 24×24
// 网格的原始路径,stroke-width 从 2 调到 1.7 以适配 13px 的渲染尺寸。
// 之前这里用的是 Unicode 字形(⑂ ✎ 🗄)—— 字形随系统字体变化、基线对不齐,
// 🗄 在部分平台还会被渲染成彩色 emoji。
const actionIcon = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const HISTORY_ACTION_ICONS = Object.freeze({
  // lucide: git-fork
  fork: actionIcon('<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>'),
  // lucide: pencil-line
  rename: actionIcon('<path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>'),
  // lucide: archive
  archive: actionIcon('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>')
});
