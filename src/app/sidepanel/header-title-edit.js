// 顶栏会话标题:单击开关左侧会话抽屉,双击原地改名(对齐 Mac 标题栏的行内重命名)。
//
// 单击与双击落在同一颗按钮上,浏览器总是先派发 click(detail=1)再派发
// click(detail=2) + dblclick。若单击立刻开抽屉,双击就会让抽屉开了又关、
// 闪一下再进编辑。所以**可改名时**把鼠标单击推迟一个双击判定窗口:窗口内
// 等来了第二击就取消开抽屉、进入编辑。键盘回车/空格与 ⌘K 的 entry.click()
// 派发的是 detail=0 的 click,不是鼠标连击的一部分,照旧立即响应;当前还没有
// 会话(新会话空态)时没有可改的标题,也不必等。
//
// 编辑框不能放进按钮里(交互内容不能嵌套在 <button> 内,光标与按键都会被
// 按钮吞掉),所以编辑期间把整颗入口按钮藏起来,在它原位插一个 input。
import { t } from "../../shared/i18n.js";

/// 双击判定窗口。系统默认值通常是 500ms,但绝大多数双击两击间隔 < 250ms;
/// 取得太长会让单击开抽屉显得迟钝。
export const DOUBLE_CLICK_WINDOW_MS = 250;

/**
 * @param {object} options
 * @param {HTMLElement} options.entry 顶栏标题入口按钮(#hdr-title-wrap)。
 * @param {HTMLElement} options.title 标题文本节点(#hdr-title)。
 * @param {() => string|null} options.sessionId 当前会话 id;为空表示没有可改名的会话。
 * @param {(sessionId: string, title: string) => Promise<unknown>} options.rename
 * @param {() => void} options.toggle 单击时开关抽屉。
 * @param {() => void} [options.beforeEdit] 进入编辑前调用(收起抽屉)。
 * @param {(message: string) => void} [options.showToast]
 */
export function mountHeaderTitleEdit({ entry, title, sessionId, rename, toggle, beforeEdit = null, showToast = null }) {
  let clickTimer = null;
  /** @type {{ input: HTMLInputElement, sessionId: string, original: string } | null} */
  let editing = null;

  function cancelPendingClick() {
    clearTimeout(clickTimer);
    clickTimer = null;
  }

  entry.addEventListener("click", (event) => {
    // 连击的第二、三击:由 dblclick 接管,别让它再开关一次抽屉。
    if (event.detail > 1) { cancelPendingClick(); return; }
    if (event.detail === 0 || !sessionId()) { cancelPendingClick(); toggle(); return; }
    cancelPendingClick();
    clickTimer = setTimeout(() => { clickTimer = null; toggle(); }, DOUBLE_CLICK_WINDOW_MS);
  });

  entry.addEventListener("dblclick", (event) => {
    event.preventDefault();
    cancelPendingClick();
    start();
  });

  /// 进入编辑。返回 false 表示当前没有可改名的会话。
  function start() {
    if (editing) { editing.input.focus(); editing.input.select(); return true; }
    const id = sessionId();
    if (!id) return false;
    cancelPendingClick();
    beforeEdit?.();
    const original = title.textContent ?? "";
    const input = document.createElement("input");
    input.id = "hdr-title-input";
    input.type = "text";
    input.value = original;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", t("session.renamePrompt"));
    input.placeholder = t("session.renamePrompt");
    editing = { input, sessionId: id, original };
    entry.hidden = true;
    entry.after(input);
    input.addEventListener("keydown", (event) => {
      // 输入法组字时的回车/Esc 是选字或撤销组字,不是提交/取消。
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    // 点到别处 = 提交(对齐 Mac / Web 的行内改名)。
    input.addEventListener("blur", () => finish(true, { restoreFocus: false }));
    input.focus();
    input.select();
    return true;
  }

  /// 结束编辑。commit=true 且标题确有变化时才发 rename。
  function finish(commit, { restoreFocus = true } = {}) {
    if (!editing) return;
    const { input, sessionId: id, original } = editing;
    editing = null;
    const next = input.value.trim();
    // 先清 editing 再摘 input:remove 可能触发 blur,此时 finish 直接返回,不会重入。
    input.remove();
    entry.hidden = false;
    if (restoreFocus) entry.focus({ preventScroll: true });
    // 编辑期间换了会话,这次输入属于旧会话的标题,不要改到新会话上。
    if (!commit || !next || next === original || sessionId() !== id) return;
    // 乐观显示新标题;宿主回包后 session-service 会以权威标题回写快照。
    title.textContent = next;
    Promise.resolve()
      .then(() => rename(id, next))
      .catch((error) => {
        if (sessionId() === id && title.textContent === next) title.textContent = original;
        showToast?.(error?.message ?? String(error));
      });
  }

  return {
    start,
    isEditing: () => editing !== null,
    /// 会话切换时放弃编辑(不提交),焦点交给新会话的流程。
    cancel() { cancelPendingClick(); finish(false, { restoreFocus: false }); }
  };
}
