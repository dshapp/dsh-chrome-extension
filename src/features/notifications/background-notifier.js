// 后台任务通知:轮询 session.list 观察运行态变化,经 chrome.notifications 提醒。
// 运行在 service worker。observeStatus 由轮询驱动(幂等)。
export function createBackgroundNotifier({ notifications, settings }) {
  const running = new Set();

  async function notify(sessionId, title, message) {
    // 非扩展环境(dev web 模式、测试)没有 notifications API:静默跳过。
    if (!notifications?.create) return;
    if (!(await settings.getNotificationsEnabled())) return;
    notifications.create(`dsh-${sessionId}-${Date.now()}`, {
      type: "basic",
      title,
      message,
      iconUrl: globalThis.chrome?.runtime?.getURL?.("icons/icon128.png")
    });
  }

  return {
    // 轮询喂入:running=true 进入运行集合;false 且曾在集合 → 完成通知。
    observeStatus(sessionId, isRunning) {
      if (isRunning) {
        running.add(sessionId);
      } else if (running.delete(sessionId)) {
        notify(sessionId, "CodeMax DSH", "后台任务已完成");
      }
    },
    /// 后台会话的轮以错误结束:由侧栏帧偷看驱动(轮询只报"完成",区分不了失败)。
    /// 丢帧策略下这是失败信息唯一的出口,详情截断防止通知气泡溢出。
    reportFailure(sessionId, detail) {
      const text = detail
        ? `后台任务失败:${String(detail).slice(0, 160)}`
        : "后台任务失败";
      notify(sessionId, "CodeMax DSH", text);
    },
    reset() {
      running.clear();
    }
  };
}
