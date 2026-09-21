// 后台任务通知:轮询 session.list 观察运行态变化,经 chrome.notifications 提醒。
// 运行在 service worker。observeStatus 由轮询驱动(幂等)。
//
// MV3 会回收空闲 worker,运行集合若只驻内存,短任务在两次轮询之间完成就会
// 漏报。所以把 running 集合持久化到 storage.local,worker 重启后先恢复再轮询。
import { notificationIdForSession } from "./notification-click.js";
import { RPC } from "../../platform/dsh/rpc-methods.js";
import { setLang, t } from "../../shared/i18n.js";

const RUNNING_KEY = "dsh_running_sessions";

/// 拉取宿主的会话状态并喂给通知边沿检测器。独立成纯函数，避免 service worker
/// 的静默 catch 把端点拼写或参数信封回归永久藏起来。
export async function pollSessionStatuses(api, notifier) {
  const value = await api.call(RPC.sessionList, { _request: {} });
  for (const item of value?.items ?? []) {
    // 子代理的 running→idle 是父轮内部的一步,不是"用户的任务跑完了":
    // 会话行上的 origin 是权威判定(与 Mac 的 subject.isSubagent 同源)。
    // 标题也从同一行取,完成通知的标题才能是具体任务内容而非通用文案。
    notifier.observeStatus(
      item.sessionId,
      item.running,
      item.origin === "subagent",
      item.projections?.values?.title ?? null
    );
  }
}

export function createBackgroundNotifier({ notifications, settings, storage }) {
  const area = storage ?? (typeof chrome !== "undefined" ? chrome.storage?.local : null);
  const running = new Set();
  // 记住恢复用的 promise 而不是一个 bool。用 bool 的话它必须在 await 之前置位,
  // 于是并发的第二个调用者会在集合还空着的时候就拿到"已加载",把 s1 的
  // running→idle 边沿判成"本来就不在集合里",通知被丢掉;更糟的是 storage 里
  // s1 仍标着 running,后续轮询再也见不到这个边沿,通知永久丢失。
  // 启动轮询与 alarm tick 恰好会这样并发(见 sw/session-notify.js)。
  let loadPromise = null;

  /// 幂等:首次调用从 storage 恢复运行集合,并发调用共享同一次恢复。
  function loadRunning() {
    loadPromise ??= (async () => {
      if (!area) return;
      try {
        const value = await area.get([RUNNING_KEY]);
        const list = value?.[RUNNING_KEY];
        if (Array.isArray(list)) for (const id of list) running.add(id);
      } catch { /* 无 storage 时退化为纯内存 */ }
    })();
    return loadPromise;
  }

  function persistRunning() {
    if (!area) return;
    area.set({ [RUNNING_KEY]: [...running] }).catch(() => {});
  }

  // 通知标题的上限:会话标题由模型按首条用户消息生成,偶尔很长,直接塞进
  // 通知气泡会溢出;与失败详情一样按字符截断。
  const MAX_TITLE_CHARS = 80;

  /// 通知标题优先用会话标题 —— 它是具体任务内容,原样展示(不翻译);
  /// 会话还没有标题时(冷启动、模型尚未生成)才退回通用文案。
  function notificationTitle(title, fallbackKey) {
    const trimmed = typeof title === "string" ? title.trim() : "";
    if (!trimmed) return t(fallbackKey);
    return trimmed.length > MAX_TITLE_CHARS
      ? `${trimmed.slice(0, MAX_TITLE_CHARS)}…`
      : trimmed;
  }

  async function notify(sessionId, { title, fallbackKey, messageKey, params }) {
    // 非扩展环境(dev web 模式、测试)没有 notifications API:静默跳过。
    if (!notifications?.create) return;
    if (!(await settings.getNotificationsEnabled())) return;
    // service worker 有自己的模块作用域,侧栏切语言不会传播过来 —— 每次发通知
    // 都从扩展本地设置取一次语言,文案才跟得上用户的选择。
    const lang = await settings.getLang?.();
    if (lang) setLang(lang);
    // id 携带会话 id:点击通知时 service worker 靠它定位要打开的会话。
    notifications.create(notificationIdForSession(sessionId), {
      type: "basic",
      title: notificationTitle(title, fallbackKey),
      message: t(messageKey, params),
      iconUrl: globalThis.chrome?.runtime?.getURL?.("icons/icon128.png")
    });
  }

  return {
    loadRunning,
    // 轮询喂入:running=true 进入运行集合;false 且曾在集合 → 完成通知。
    // 第三个参数 subagent=true 时只清账、不通知:子代理的结束从来不是用户的
    // 任务的结束(对齐 Mac AgentNotificationCenter 的 isSubagent 闸门)。
    observeStatus(sessionId, isRunning, subagent = false, title = null) {
      if (subagent) {
        // 仍然从集合里摘掉:持久化的运行集合可能还留着修复前写进去的子代理 id,
        // 不清就永远留着,worker 每次重启都要白读一遍。
        if (running.delete(sessionId)) persistRunning();
        return;
      }
      if (isRunning) {
        if (!running.has(sessionId)) {
          running.add(sessionId);
          persistRunning();
        }
      } else if (running.delete(sessionId)) {
        persistRunning();
        // 标题取本次名单里的具体任务名;拿不到才退回通用文案。
        notify(sessionId, {
          title,
          fallbackKey: "notif.running_title",
          messageKey: "notif.finished"
        });
      }
    },
    /// 后台会话的轮以错误结束:由侧栏帧偷看驱动(轮询只报"完成",区分不了失败)。
    /// 丢帧策略下这是失败信息唯一的出口,详情截断防止通知气泡溢出。
    reportFailure(sessionId, detail, title = null) {
      const trimmed = detail ? String(detail).slice(0, 160) : "";
      notify(sessionId, {
        title,
        fallbackKey: "notif.error_title",
        messageKey: trimmed ? "notif.failedWithDetail" : "notif.failed",
        params: { detail: trimmed }
      });
    },
    reset() {
      running.clear();
      persistRunning();
    }
  };
}
