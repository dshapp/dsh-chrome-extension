// 侧栏里通用的「确认 / 取消」模态(归档会话等防误触的二次确认)。
//
// 不用 window.confirm:原生框样式与侧栏不符、会阻塞 UI 线程,且标题栏显示的是
// 扩展 id。这里懒建一个 <dialog> 挂进调用方给的宿主节点 —— 会话抽屉把它挂在
// 抽屉自身里,这样点弹窗(含 backdrop)时 composedPath 仍落在抽屉内,不会被
// 抽屉的「点外面就收起」误关。
//
// 结果只有两种:确认 → true;取消按钮 / Esc / 点 backdrop → false。

/**
 * @param {() => Element|null} host 弹窗挂载点(调用时现取,缺省 body)。
 */
export function createConfirmDialog(host = () => document.body) {
  let dialog = null;
  let pending = null;   // 当前在等答案的 resolve;同一时刻只有一个

  function ensure() {
    const parent = host?.() ?? document.body;
    if (dialog && dialog.parentNode === parent) return dialog;
    dialog?.remove();
    dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML =
      '<h2 class="confirm-dialog-title"></h2>' +
      '<p class="confirm-dialog-body"></p>' +
      '<div class="dialog-actions">' +
        '<button class="btn" type="button" data-confirm="cancel"></button>' +
        '<button class="btn primary" type="button" data-confirm="ok"></button>' +
      '</div>';
    const titleId = "confirm-dialog-title-" + Math.random().toString(36).slice(2, 8);
    dialog.querySelector(".confirm-dialog-title").id = titleId;
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.addEventListener("click", (event) => {
      const choice = event.target.closest?.("[data-confirm]")?.dataset.confirm;
      if (choice) { settle(choice === "ok"); return; }
      // 点在 dialog 自身矩形之外即 backdrop:当作取消。
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right
        && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) settle(false);
    });
    // Esc 走原生 cancel → close;任何关闭路径都按取消结算(已结算的是空操作)。
    dialog.addEventListener("close", () => settle(false));
    parent.append(dialog);
    return dialog;
  }

  function settle(value) {
    const resolve = pending;
    pending = null;
    if (dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.open = false;   // jsdom 没实现 close/showModal
    }
    resolve?.(value);
  }

  /**
   * 弹出确认框,resolve 用户是否确认。
   * @param {{title: string, body?: string, confirmLabel: string, cancelLabel: string}} options
   * @returns {Promise<boolean>}
   */
  function confirm({ title, body = "", confirmLabel, cancelLabel }) {
    // 上一个还没答就又来一个(理论上不会):旧的按取消结算,不留悬挂的 promise。
    if (pending) settle(false);
    const node = ensure();
    node.querySelector(".confirm-dialog-title").textContent = title;
    const bodyNode = node.querySelector(".confirm-dialog-body");
    bodyNode.textContent = body;
    bodyNode.hidden = !body;
    const ok = node.querySelector('[data-confirm="ok"]');
    ok.textContent = confirmLabel;
    node.querySelector('[data-confirm="cancel"]').textContent = cancelLabel;
    return new Promise((resolve) => {
      pending = resolve;
      if (typeof node.showModal === "function") node.showModal();
      else node.open = true;
      ok.focus();
    });
  }

  return {
    confirm,
    /// 弹窗开着时,外层的键盘导航(方向键/回车/Esc)要让给它。
    isOpen: () => Boolean(dialog?.open),
    /// 程序化取消(抽屉被别的路径收起时)。
    cancel: () => { if (pending) settle(false); }
  };
}
