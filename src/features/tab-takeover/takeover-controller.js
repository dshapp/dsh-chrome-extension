/**
 * 标签页「受插件控制 / 正在被操作」指示 —— 决定每个标签页该显示什么。
 *
 * 纯逻辑,不直接碰 chrome.*:注入、取 favicon、持久化、计时器全部由调用方传入,
 * 以便单测用假时钟驱动。Service Worker 侧的装配见 sw/tab-takeover.js。
 *
 * 每个标签页处于三种状态之一,对应页面脚本的三个命令:
 *   - active(呼吸灯):正在被操作 ——
 *       有进行中的工具调用,其会话当前指向它(begin 的 getter 实时求值,
 *       navigate 中途新开的标签页也能认出来),或它在 lingerMs 内被触碰过
 *       (工具调用结束、任一条 CDP 命令打到它)。余韵让连续调用之间不闪。
 *   - idle(静止圈):受控 —— 被操作过,或被某个会话选为当前标签页(会被操作)。
 *       一直保持,直到标签页关闭或会话把它交还(release)。
 *   - 无:从没被插件碰过,或已交还。
 *
 * 受控集合持久化(chrome.storage.session):MV3 Service Worker 随时会被回收,
 * 重启后要能把静止圈恢复出来。
 */

/**
 * 这个 favicon URL 是不是我们自己画的标记帧。
 *
 * 页面脚本给每个 PNG 帧插了一个 tEXt 块(Software=dsh-takeover),SVG 兜底帧在根元素
 * 上带 data-dsh-takeover。凭内容认,而不是凭"我们记得画过":换页、扩展重载、SW 重启后
 * 内存里的记录都没了,戳还在。
 */
export function isTakeoverFrame(url) {
  if (typeof url !== "string" || !url.startsWith("data:image/")) return false;
  const comma = url.indexOf(",");
  if (comma < 0) return false;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  try {
    const text = meta.endsWith(";base64") ? atob(payload) : decodeURIComponent(payload);
    return text.includes("dsh-takeover");
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   inject: (tabId: number, command: "active"|"idle"|"stop", options?: object) => Promise<unknown>,
 *   captureFavicon?: (tabId: number) => Promise<string|null>,
 *   pulse?: (tabId: number) => void,
 *   persist?: (tabIds: number[]) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   lingerMs?: number, sessionLingerMs?: number, tickMs?: number, refreshMs?: number, pageTtlMs?: number,
 *   pulseMs?: number, reinjectDelays?: number[],
 * }} deps
 */
export function createTabTakeover(deps) {
  const {
    inject,
    captureFavicon = async () => null,
    pulse = () => {},
    persist = () => {},
    pulseMs = 90,
    reinjectDelays = [250, 700, 1500],
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    lingerMs = 2500,
    sessionLingerMs = 20000,
    tickMs = 400,
    refreshMs = 5000,
    pageTtlMs = 15000,
  } = deps;

  /** 进行中的工具调用,各自带一个"会话当前标签页"的 getter。 */
  const calls = new Set();
  /**
   * 会话 → { getter, until }:会话最近一次调用结束后的一段时间里,它当前的标签页仍算
   * "正在操作"。agent 两次工具调用之间要花好几秒到几十秒思考,只按单次调用计算的话,
   * 呼吸灯只会在零星几秒里亮一下,看上去像没有动效。会话转去别的标签页时,getter
   * 随之指向新标签页,旧标签页立即只剩短余韵,随后回到静止圈。
   */
  const sessions = new Map();
  /** tabId → 余韵截止时间。 */
  const lingerUntil = new Map();
  /** 受控的标签页(静止圈)。 */
  const controlled = new Set();
  /** tabId → 已应用到页面的状态 { mode, favicon, refresh, pulse }。 */
  const applied = new Map();
  /** tabId → 串行化的注入链,保证后发的命令不会被先发的反超。 */
  const queues = new Map();
  let wake = null;

  function enqueue(tabId, job) {
    const prev = queues.get(tabId) ?? Promise.resolve();
    const next = prev.then(job).catch(() => {
      // 页面换了、关了、或是 chrome:// 之类注入不进去的页面 —— 指示只是锦上添花。
    });
    queues.set(tabId, next);
    next.then(() => {
      if (queues.get(tabId) === next) queues.delete(tabId);
    });
    return next;
  }

  function resolveTab(getter) {
    try {
      const id = getter();
      return Number.isInteger(id) ? id : null;
    } catch {
      return null;
    }
  }

  function busyTabs(at) {
    const busy = new Set();
    for (const getter of calls) {
      const id = resolveTab(getter);
      if (id != null) busy.add(id);
    }
    for (const [id, until] of lingerUntil) {
      if (until > at) busy.add(id);
      else lingerUntil.delete(id);
    }
    for (const [key, entry] of sessions) {
      if (entry.until <= at) {
        sessions.delete(key);
        continue;
      }
      const id = resolveTab(entry.getter);
      if (id != null) busy.add(id);
    }
    return busy;
  }

  function save() {
    try {
      persist([...controlled]);
    } catch {
      // 持久化失败只影响 SW 重启后的恢复。
    }
  }

  /** 把记录当前的模式推到页面(执行时再读 record.mode,中途改了就推最新的)。 */
  function push(tabId, record) {
    return enqueue(tabId, async () => {
      if (applied.get(tabId) !== record) return;
      if (record.favicon === undefined) {
        const epoch = record.faviconEpoch;
        const captured = await captureFavicon(tabId).catch(() => null);
        // 取图标期间页面换了(tabUpdated 把 favicon 作废):这次取到的属于旧页面,
        // 甚至可能是旧页面上我们的帧,丢掉;换页触发的下一次推送会重新取。
        if (record.faviconEpoch === epoch) record.favicon = captured;
      }
      if (applied.get(tabId) !== record) return;
      await inject(tabId, record.mode, { favicon: record.favicon, ttlMs: pageTtlMs });
    });
  }

  function stopPulse(record) {
    if (record?.pulse != null) clearTimer(record.pulse);
    if (record) record.pulse = null;
  }

  function stopRefresh(record) {
    if (record?.refresh != null) clearTimer(record.refresh);
    if (record) record.refresh = null;
  }

  function setMode(tabId, mode) {
    let record = applied.get(tabId);
    if (mode == null) {
      if (!record) return;
      applied.delete(tabId);
      stopRefresh(record);
      stopPulse(record);
      enqueue(tabId, () => inject(tabId, "stop"));
      return;
    }
    if (record?.mode === mode) return;
    if (!record) {
      record = { mode, favicon: undefined, faviconEpoch: 0, refresh: null, pulse: null };
      applied.set(tabId, record);
    }
    record.mode = mode;
    stopRefresh(record);
    if (mode === "active") {
      // 定期续命页面侧的呼吸截止时间;SW 若被回收,页面到点自己退回静止圈。
      const loop = () => {
        record.refresh = setTimer(() => {
          if (applied.get(tabId) !== record || record.mode !== "active") return;
          push(tabId, record);
          loop();
        }, refreshMs);
      };
      loop();
    } else {
      stopPulse(record);
    }
    push(tabId, record);
  }

  function reconcile() {
    if (wake != null) {
      clearTimer(wake);
      wake = null;
    }
    const at = now();
    const busy = busyTabs(at);
    // 操作过就算受控:转完之后留下静止圈。
    let grew = false;
    for (const id of busy) {
      if (!controlled.has(id)) {
        controlled.add(id);
        grew = true;
      }
    }
    if (grew) save();
    for (const id of new Set([...controlled, ...applied.keys()])) {
      setMode(id, busy.has(id) ? "active" : controlled.has(id) ? "idle" : null);
    }

    let delay = null;
    if (calls.size > 0) delay = tickMs;
    for (const until of lingerUntil.values()) {
      const left = Math.max(until - at, 0) + 5;
      if (delay == null || left < delay) delay = left;
    }
    // 会话余韵期间它的 getter 可能改指别的标签页,按 tick 复查;到期也要醒来。
    if (sessions.size > 0 && (delay == null || delay > tickMs)) delay = tickMs;
    if (delay != null) wake = setTimer(reconcile, delay);
  }

  function linger(tabId) {
    if (!Number.isInteger(tabId)) return;
    const until = now() + lingerMs;
    if ((lingerUntil.get(tabId) ?? 0) < until) lingerUntil.set(tabId, until);
  }

  return {
    /**
     * 一次工具调用开始。getter 返回该调用此刻作用的标签页(可能中途变化)。
     * sessionKey 标识发起调用的会话:调用结束后 sessionLingerMs 内,该会话当前的
     * 标签页仍保持呼吸(agent 在两次调用之间思考)。
     * @returns {() => void} 调用结束时调用,标签页进入余韵,之后留在静止圈。
     */
    begin(getter, sessionKey) {
      const entry = () => getter();
      calls.add(entry);
      if (sessionKey != null) sessions.delete(sessionKey);
      reconcile();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        calls.delete(entry);
        linger(resolveTab(getter));
        // agent 正在思考下一步:会话当前的标签页继续呼吸一会儿。
        if (sessionKey != null) sessions.set(sessionKey, { getter, until: now() + sessionLingerMs });
        reconcile();
      };
    },
    /** 会话结束(close_session):不再让它的标签页呼吸。 */
    endSession(sessionKey) {
      if (sessions.delete(sessionKey)) reconcile();
    },
    /** 有命令打到了这个标签页(例如每条 CDP 命令)。 */
    touch(tabId) {
      if (!Number.isInteger(tabId)) return;
      linger(tabId);
      if (applied.get(tabId)?.mode !== "active") reconcile();
    },
    /** 标记受控但不闪:会话选中了这个标签页,接下来会操作它。 */
    mark(tabId) {
      if (!Number.isInteger(tabId) || controlled.has(tabId)) return;
      controlled.add(tabId);
      save();
      reconcile();
    },
    /** 会话把标签页交还给用户(close_session 留下的借用标签页):拆掉标记。 */
    release(tabId) {
      if (!Number.isInteger(tabId)) return;
      lingerUntil.delete(tabId);
      if (controlled.delete(tabId)) save();
      reconcile();
    },
    /** SW 重启后恢复受控集合(调用方负责过滤掉已不存在的标签页)。 */
    restore(tabIds) {
      for (const id of tabIds) if (Number.isInteger(id)) controlled.add(id);
      reconcile();
    },
    /**
     * 页面拿不到不受节流的 Worker 节拍器(CSP),请求由这里定时发 tick。
     * 仅限呼吸中的标签页,停下或换页即停。
     */
    requestPulse(tabId) {
      const record = applied.get(tabId);
      if (!record || record.mode !== "active" || record.pulse != null) return;
      const loop = () => {
        record.pulse = setTimer(() => {
          if (applied.get(tabId) !== record || record.mode !== "active" || record.pulse == null) {
            if (record.pulse != null) record.pulse = null;
            return;
          }
          pulse(tabId);
          loop();
        }, pulseMs);
      };
      loop();
    },
    /** chrome.tabs.onUpdated 转发:换页后重新注入,页面换了图标就跟着换。 */
    tabUpdated(tabId, changeInfo) {
      const record = applied.get(tabId);
      if (!record || !changeInfo) return;
      const resetFavicon = () => {
        record.favicon = undefined;
        record.faviconEpoch += 1;
      };
      if (changeInfo.url) {
        resetFavicon();
        // "loading" 阶段新文档的 <head> 往往还没解析完,取到的只能是猜测的
        // /favicon.ico;加载完再取一次页面真正声明的图标。
        record.recaptureOnComplete = true;
        // 新文档也许允许 Worker;需要的话它会自己再来要脉冲。
        stopPulse(record);
      }
      if (changeInfo.status === "complete" && record.recaptureOnComplete) {
        record.recaptureOnComplete = false;
        resetFavicon();
      }
      // 标记期间页面自己的 icon 已被停用,data: 的变化基本都是我们自己的帧,
      // 呼吸时每帧都会触发一次 onUpdated,必须忽略;新文档的真实图标多为
      // http(s) URL,再加上换页的 status 事件兜底,足以重新取到原图标。
      if (changeInfo.favIconUrl && !changeInfo.favIconUrl.startsWith("data:")) resetFavicon();
      // 页面自己用 data: 声明的真图标(不是我们的帧)出现了,也要重新取。
      else if (changeInfo.favIconUrl && !isTakeoverFrame(changeInfo.favIconUrl) && record.favicon == null) resetFavicon();
      if (changeInfo.status === "complete" || changeInfo.status === "loading" || record.favicon === undefined) {
        push(tabId, record);
      }
      // "loading" 常在新文档提交之前就到,那次注入落在即将卸载的旧文档里;
      // 再补几次,让新页面不必等到 "complete"(重页面可能要好几秒)才有标记。
      // 注入对同一文档是幂等的,多注入几次无副作用。
      if (changeInfo.status === "loading") {
        for (const delay of reinjectDelays) {
          setTimer(() => {
            if (applied.get(tabId) === record) push(tabId, record);
          }, delay);
        }
      }
    },
    /** chrome.tabs.onRemoved 转发。 */
    tabRemoved(tabId) {
      const record = applied.get(tabId);
      stopRefresh(record);
      stopPulse(record);
      applied.delete(tabId);
      lingerUntil.delete(tabId);
      queues.delete(tabId);
      if (controlled.delete(tabId)) save();
    },
    /** "active" | "idle" | null */
    modeOf(tabId) {
      return applied.get(tabId)?.mode ?? null;
    },
    isActive(tabId) {
      return applied.get(tabId)?.mode === "active";
    },
    activeTabs() {
      return [...applied].filter(([, r]) => r.mode === "active").map(([id]) => id);
    },
    controlledTabs() {
      return [...controlled];
    },
  };
}
