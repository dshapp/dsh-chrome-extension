// 把 Native Messaging 的失败翻译成"用户该做什么"。
//
// chrome.runtime.sendNativeMessage 失败时只给一句英文原文(lastError.message),
// 例如新用户最常见的 "Specified native messaging host not found."。这句话对用户
// 毫无指导意义:它真正的意思是"这台电脑还没装 dsh / dsh-chrome-control 插件,
// 或者装了但从没启动过"。这里把原文归类成稳定的 code,上层据此展示安装引导,
// 而不是把原文 toast 出去。
//
// 原文来自 Chromium 的 native_message_process_host.cc / messaging_delegate,
// 多年未变;仍按关键词宽松匹配,措辞微调不至于整体失配。

export const NativeHostIssue = Object.freeze({
  /// 宿主清单不存在:没装 dsh、没装 dsh-chrome-control,或装了还没启动过 dsh。
  MISSING: "host-missing",
  /// 宿主存在但不授权本扩展(allowed_origins 不含本扩展 id,或宿主自检拒绝调用方)。
  FORBIDDEN: "host-forbidden",
  /// 宿主清单在,但进程起不来/中途退出:通常是 node 或 dsh 被移动、卸载。
  BROKEN: "host-broken",
  /// 运行环境里根本没有 Native Messaging(缺权限或非扩展上下文)。
  UNAVAILABLE: "native-messaging-unavailable"
});

const SETUP_ISSUES = new Set(Object.values(NativeHostIssue));

/** 原文 → issue code;不认识的返回 null(交给上层按普通错误处理)。 */
export function classifyNativeFailure(message) {
  const text = String(message ?? "").toLowerCase();
  if (!text) return null;
  if (text.includes("host not found") || text.includes("invalid native messaging host name")) {
    return NativeHostIssue.MISSING;
  }
  if (text.includes("forbidden") || text.includes("caller-not-allowed")) return NativeHostIssue.FORBIDDEN;
  if (text.includes("native host has exited")
    || text.includes("failed to start native messaging host")
    || text.includes("error when communicating with the native messaging host")) {
    return NativeHostIssue.BROKEN;
  }
  if (text.includes("native-messaging-unavailable")) return NativeHostIssue.UNAVAILABLE;
  return null;
}

/**
 * 需要用户在本机做安装/修复动作才能继续的错误。message 保留可读说明,
 * detail 保留浏览器原文,方便排错时对照。
 */
export class NativeHostError extends Error {
  constructor(issue, detail) {
    super(issue === NativeHostIssue.MISSING
      ? "DSH is not set up on this computer yet"
      : "The local DSH launcher cannot be used (" + issue + ")");
    this.name = "NativeHostError";
    this.issue = issue;
    this.detail = detail ? String(detail) : "";
    // 侧栏 format() 认 i18nKey:即便某条路径漏接了引导页,toast 也是人话。
    this.i18nKey = "setup.toast." + issue;
  }
}

export function isNativeHostSetupError(error) {
  return Boolean(error && error.name === "NativeHostError" && SETUP_ISSUES.has(error.issue));
}

/** 把 sendNativeMessage 的异常或宿主回包里的 reason 统一成 NativeHostError(认不出则 null)。 */
export function toNativeHostError(errorOrReason) {
  const message = typeof errorOrReason === "string"
    ? errorOrReason
    : errorOrReason?.message ?? String(errorOrReason ?? "");
  const issue = classifyNativeFailure(message);
  return issue ? new NativeHostError(issue, message) : null;
}
