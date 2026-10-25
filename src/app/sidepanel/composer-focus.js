// 侧栏打开即可打字:启动时把焦点交给聊天输入框。
//
// Chrome 每次打开侧栏都会重新加载整页,所以"打开侧栏"就是 app 启动;焦点
// 默认停在 <body>,用户得先点一下输入框才能敲字。这里只在焦点**无主**时接管:
// 用户已经点进了别的控件、或安装引导 / API Key 引导等模态框开着时都不抢;
// 输入框让位给交互卡片(composer.hidden)或子代理只读(disabled)时也不聚焦。

/**
 * @param {{ composer: HTMLElement, input: HTMLTextAreaElement }} elements
 * @param {Document} [doc]
 * @returns {boolean} 是否把焦点放进了输入框
 */
export function focusComposerOnOpen({ composer, input }, doc = input?.ownerDocument) {
  if (!doc || !input || !composer) return false;
  if (composer.hidden || input.disabled || input.readOnly) return false;
  if (doc.body?.classList.contains("setup-required")) return false;
  if (doc.querySelector("dialog[open]")) return false;
  const active = doc.activeElement;
  if (active === input) return true;
  if (active && active !== doc.body && active !== doc.documentElement) return false;
  input.focus({ preventScroll: true });
  return doc.activeElement === input;
}
