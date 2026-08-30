// 后台任务通知:轮询 session.list 观察运行态变化,经 chrome.notifications 提醒。
// 运行在 service worker。observeStatus 由轮询驱动(幂等)。
//
// MV3 会回收空闲 worker,运行集合若只驻内存,短任务在两次轮询之间完成就会
// 漏报。所以把 running 集合持久化到 storage.local,worker 重启后先恢复再轮询。
const RUNNING_KEY = "codemax_dsh_running_sessions";

export function createBackgroundNotifier({ notifications, settings, storage }) {
  const area = storage ?? (typeof chrome !== "undefined" ? chrome.storage?.local : null);
  const running = new Set();
  let loaded = false;

  /// 幂等:首次调用从 storage 恢复运行集合,后续直接返回。
  async function loadRunning() {
    if (loaded) return;
    loaded = true;
    if (!area) return;
    try {
      const value = await area.get([RUNNING_KEY]);
      const list = value?.[RUNNING_KEY];
      if (Array.isArray(list)) for (const id of list) running.add(id);
    } catch { /* 无 storage 时退化为纯内存 */ }
  }

  function persistRunning() {
    if (!area) return;
    area.set({ [RUNNING_KEY]: [...running] }).catch(() => {});
  }

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
    loadRunning,
    // 轮询喂入:running=true 进入运行集合;false 且曾在集合 → 完成通知。
    observeStatus(sessionId, isRunning) {
      if (isRunning) {
        if (!running.has(sessionId)) {
          running.add(sessionId);
          persistRunning();
        }
      } else if (running.delete(sessionId)) {
        persistRunning();
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
      persistRunning();
    }
  };
}
