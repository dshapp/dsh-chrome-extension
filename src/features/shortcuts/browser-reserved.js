// 修饰键掩码、和弦构造,以及浏览器/系统保留的和弦清单。
//
// 单独成文件的理由:这三样是**数据与词汇表**,命令表是**策略**。保留清单会随
// Chrome 版本变动而单独增删,把它和命令声明混在一个文件里,每次核对保留键都要
// 在几百行命令中间翻找。command-table.js 只 import 这里的词汇表。
//
// ⚠️ 这张清单是整套键位的承重墙:落在其上的和弦拿不到事件,或者会双重触发
// (用户既得到我们的动作又得到浏览器的)。新增键位前先在真机侧栏按一次确认,
// 不要凭印象往里加。

/// 修饰键位掩码。与 EventModifiers 无关,只要能做集合比较与冲突检测。
export const MOD = {
  none: 0,
  primary: 1 << 0, // mac ⌘ / win Ctrl
  alt: 1 << 1, // ⌥ / Alt
  shift: 1 << 2, // ⇧ / Shift
  control: 1 << 3 // mac ⌃(win 无独立位,Ctrl 走 primary)
};

/// 一条和弦。key 用 KeyboardEvent.key 的小写形式(方向键与 Escape 用其标准名)。
export function chord(key, mods = MOD.none) {
  return { key: String(key).toLowerCase(), mods };
}

/// 浏览器/系统保留的和弦:拿不到事件,或双重触发。命令不得落在其上。
/// 这是整张表的承重墙,新增键位前先在真机侧栏按一次确认。
export const BROWSER_RESERVED_MAC = [
  // Chrome 完全不下发给页面
  chord("n", MOD.primary), chord("n", MOD.primary | MOD.shift),
  chord("t", MOD.primary), chord("t", MOD.primary | MOD.shift),
  chord("w", MOD.primary), chord("w", MOD.primary | MOD.shift),
  chord("q", MOD.primary), chord("m", MOD.primary), chord("h", MOD.primary),
  chord("h", MOD.primary | MOD.alt), chord(",", MOD.primary),
  chord("a", MOD.primary | MOD.shift),
  chord("arrowleft", MOD.primary | MOD.alt), chord("arrowright", MOD.primary | MOD.alt),
  chord("0", MOD.primary), chord("=", MOD.primary), chord("-", MOD.primary),
  // ⌘1…⌘9 切标签
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => chord(d, MOD.primary)),
  // 发得下来但会双重触发
  chord("l", MOD.primary), chord("f", MOD.primary), chord("d", MOD.primary),
  chord("r", MOD.primary), chord("p", MOD.primary), chord("s", MOD.primary),
  chord("o", MOD.primary), chord("j", MOD.primary),
  // macOS 系统级
  chord("f", MOD.primary | MOD.control), chord("q", MOD.primary | MOD.control),
  chord(" ", MOD.primary | MOD.control),
  // DevTools / 查看源码
  chord("i", MOD.primary | MOD.alt), chord("j", MOD.primary | MOD.alt),
  chord("u", MOD.primary | MOD.alt), chord("c", MOD.primary | MOD.alt),
  // manifest 全局 command:open_sidepanel
  chord("d", MOD.primary | MOD.shift)
];

export const BROWSER_RESERVED_WIN = [
  chord("n", MOD.primary), chord("n", MOD.primary | MOD.shift),
  chord("t", MOD.primary), chord("t", MOD.primary | MOD.shift),
  chord("w", MOD.primary), chord("w", MOD.primary | MOD.shift),
  chord("tab", MOD.primary), chord("tab", MOD.primary | MOD.shift),
  chord("0", MOD.primary), chord("=", MOD.primary), chord("-", MOD.primary),
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => chord(d, MOD.primary)),
  chord("l", MOD.primary), chord("k", MOD.primary), chord("e", MOD.primary),
  chord("j", MOD.primary), chord("d", MOD.primary), chord("h", MOD.primary),
  chord("p", MOD.primary), chord("s", MOD.primary), chord("o", MOD.primary),
  chord("f", MOD.primary), chord("g", MOD.primary), chord("u", MOD.primary),
  chord("delete", MOD.primary | MOD.shift),
  // 浏览器前进/后退与地址栏
  chord("arrowleft", MOD.alt), chord("arrowright", MOD.alt), chord("d", MOD.alt),
  // DevTools
  chord("i", MOD.primary | MOD.shift), chord("j", MOD.primary | MOD.shift),
  chord("c", MOD.primary | MOD.shift),
  // manifest 全局 command:open_sidepanel
  chord("d", MOD.primary | MOD.shift)
];
