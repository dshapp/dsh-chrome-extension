// 任务未读(工具栏圆点)的存活规则与判定。纯函数,单测直接驱动。
//
// 未读只该表达「刚发生、你还没看」。所以每条都带 createdAt,过期自动消失:
//   - 完成(绿点)2 小时:超过这个时间就不算「刚完成」了;
//   - 失败(红点)/ 等你处理(黄点)12 小时:更要紧,留久一点,但也不能永远挂着。
// 没有过期的话,定时任务跑出来的会话、在 Mac / Web 里看过的会话、打开侧栏扫一眼没点进去的会话,
// 会让工具栏上一直挂着一个几小时前的「完成」。

export const UNREAD_TTL_MS = Object.freeze({
  success: 2 * 3_600_000,
  attention: 12 * 3_600_000,
  failure: 12 * 3_600_000
});

/** 圆点颜色与优先级:同一时刻只画一个点,取最要紧的那一类。 */
export const INDICATORS = Object.freeze({
  failure: Object.freeze({ color: "#DC2626", priority: 3, titleKey: "taskIndicator.failure" }),
  attention: Object.freeze({ color: "#F5B400", priority: 2, titleKey: "taskIndicator.attention" }),
  success: Object.freeze({ color: "#16A34A", priority: 1, titleKey: "taskIndicator.success" })
});

export function unreadKey(sessionId, status) {
  return `${status}:${sessionId}`;
}

function timeOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 一条未读的过期时刻;没有 createdAt 或状态不认识 → 0,即已过期。 */
export function unreadExpiresAt(event) {
  const created = timeOf(event?.createdAt);
  const ttl = UNREAD_TTL_MS[event?.status];
  return created && ttl ? created + ttl : 0;
}

/** 原地清掉过期的未读,返回清了几条。 */
export function pruneExpired(unread, now) {
  let removed = 0;
  for (const [key, event] of Object.entries(unread)) {
    if (unreadExpiresAt(event) > now) continue;
    delete unread[key];
    removed += 1;
  }
  return removed;
}

/** 下一条未读过期的时刻,没有未读回 null。用来排 chrome.alarms,到点把圆点撤掉。 */
export function nextUnreadExpiry(unread) {
  let next = Infinity;
  for (const event of Object.values(unread)) {
    const at = unreadExpiresAt(event);
    if (at) next = Math.min(next, at);
  }
  return Number.isFinite(next) ? next : null;
}

/**
 * 每个会话持有哪几类未读:{ [sessionId]: { success, attention, failure } }。
 * 侧栏会话行的绿 / 红点读的就是它,所以行上和工具栏上报的是同一份数据。
 */
export function unreadBySession(unread) {
  const out = {};
  for (const event of Object.values(unread ?? {})) {
    if (!event?.sessionId || !INDICATORS[event.status]) continue;
    (out[event.sessionId] ??= { success: false, attention: false, failure: false })[event.status] = true;
  }
  return out;
}

/** 每个会话最要紧的一条未读状态:{ [sessionId]: "failure" | "attention" | "success" }。 */
export function topStatusBySession(unread) {
  const top = {};
  for (const event of Object.values(unread ?? {})) {
    const spec = INDICATORS[event?.status];
    if (!spec || !event.sessionId) continue;
    const current = INDICATORS[top[event.sessionId]];
    if (!current || spec.priority > current.priority) top[event.sessionId] = event.status;
  }
  return top;
}

/**
 * 工具栏该画哪个点:{ status, color, titleKey, count } 或 null。
 * count = 处于这一档的会话数(不是事件数:同一会话先等审批后完成只算一个)。
 */
export function resolveIndicator(unread) {
  let best = null;
  let count = 0;
  for (const status of Object.values(topStatusBySession(unread))) {
    if (!best || INDICATORS[status].priority > INDICATORS[best].priority) {
      best = status;
      count = 1;
    } else if (status === best) {
      count += 1;
    }
  }
  if (!best) return null;
  const { color, titleKey } = INDICATORS[best];
  return { status: best, color, titleKey, count };
}
