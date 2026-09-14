// 历史行的行内操作图标(分叉 / 重命名 / 归档)。
//
// 从 sidepanel-overlays.js 抽出来:这是**静态呈现数据**,与浮层的搜索、
// 键盘导航、排序等行为没有关系,而那个文件已经贴着 400 行的硬上限。
//
// 图标取自 Lucide(https://github.com/lucide-icons/lucide,ISC),统一走共享图标表,
// 不再在这里自建一份 svg 字符串。之前用的是 Unicode 字形(⑂ ✎ 🗄)—— 字形随系统
// 字体变化、基线对不齐,🗄 在部分平台还会被渲染成彩色 emoji。
import { lucideIconSvg } from "../../features/chat/file-icons.js";

export const HISTORY_ACTION_ICONS = Object.freeze({
  fork: lucideIconSvg("git-fork", { size: 13 }),
  rename: lucideIconSvg("pencil-line", { size: 13 }),
  archive: lucideIconSvg("archive", { size: 13 })
});
