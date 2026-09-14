// 复制按钮反馈。对齐 web MessageIconActions / CodeBlock 的共同语义:
// 1) 只有写入成功才切到 ✓;2) 反馈窗口 1000ms;3) 窗口内重复点击不重复写、
// 不叠加计时器;4) 切换时 title/aria-label 同步成 "已复制"。
import { t } from "../../shared/i18n.js";

export const COPY_FEEDBACK_MS = 1000;

/// @param {HTMLButtonElement} button
/// @param {() => string} getText
/// @param {{render: (copied: boolean) => void}} options
export function attachCopyFeedback(button, getText, { render, labels } = {}) {
  const doneLabel = labels?.done ?? t("copied");
  const idleLabel = labels?.idle ?? t("copy");
  let copied = false;
  let timer = null;
  button.addEventListener("click", () => {
    if (copied) return;
    const pending = navigator.clipboard?.writeText(getText() || "");
    if (!pending?.then) return;
    void pending.then(() => {
      copied = true;
      render?.(true);
      setLabel(doneLabel);
      timer = setTimeout(() => {
        timer = null;
        copied = false;
        render?.(false);
        setLabel(idleLabel);
      }, COPY_FEEDBACK_MS);
    }).catch(() => {});
  });

  function setLabel(label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}
