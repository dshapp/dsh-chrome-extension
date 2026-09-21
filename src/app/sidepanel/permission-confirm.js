// full-access 的二次确认。Mac 侧是 PermissionFullAccessConfirmation(见
// Settings/SettingsRoot.swift 的 PermissionRow):授予 `danger-full-access` 等于
// 授予"不再询问"的权力,误点一次,之后所有危险操作都会静默放行。
//
// 对话框本体是 index.html 里的 #perm-confirm,由 composer 底栏与设置页通用页共用
// —— 同一时刻只有一个入口在等它,两个入口不会并发打开,所以不需要所有权令牌。

/// 需要二次确认的权限值。宿主用不同命名发过同样的语义,所以按子串识别。
const FULL_ACCESS_PATTERN = /(full[-_ ]?access|danger|bypass|yolo)/i;

export function isFullAccessOption(value) {
  return FULL_ACCESS_PATTERN.test(String(value ?? ""));
}

/// 弹确认框,resolve 用户是否确认。没有对话框(dev web、单元测试)时放行 ——
/// 这里不是安全边界,只是防误点;真正的授权由宿主裁定。
export function confirmFullAccess(dialog) {
  if (!dialog) return Promise.resolve(true);
  const acknowledge = dialog.querySelector("#perm-confirm-ack");
  const enable = dialog.querySelector("#perm-confirm-enable");
  const cancel = dialog.querySelector("#perm-confirm-cancel");
  if (!acknowledge || !enable || !cancel) return Promise.resolve(true);
  acknowledge.checked = false;
  enable.disabled = true;

  return new Promise((resolve) => {
    const onAck = () => { enable.disabled = !acknowledge.checked; };
    const finish = (value) => {
      acknowledge.removeEventListener("change", onAck);
      enable.removeEventListener("click", onEnable);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onCancel);
      dialog.close();
      resolve(value);
    };
    const onEnable = () => finish(true);
    const onCancel = () => finish(false);
    acknowledge.addEventListener("change", onAck);
    enable.addEventListener("click", onEnable);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onCancel);
    dialog.showModal();
  });
}
