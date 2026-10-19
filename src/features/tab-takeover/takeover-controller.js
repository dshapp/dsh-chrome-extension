/**
 * 标签页「正在被接管」指示 —— 决定哪些标签页该转圈。
 *
 * 纯逻辑,不直接碰 chrome.*:注入、取 favicon、计时器全部由调用方传入,
 * 以便单测用假时钟驱动。Service Worker 侧的装配见 sw/tab-takeover.js。
 *
 * 一个标签页"忙"当且仅当:
 *   - 有进行中的工具调用,其会话当前指向这个标签页(begin 的 getter 实时求值,
 *     因此 navigate 中途新开的标签页也能被认出来);或
 *   - 它在 lingerMs 内被触碰过(工具调用结束、或任一条 CDP 命令打到它)。
 * 余韵让连续的工具调用之间不会一闪一闪。
 */

/**
 * @param {{
 *   inject: (tabId: number, command: "start"|"stop", options?: object) => Promise<unknown>,
 *   captureFavicon?: (tabId: number) => Promise<string|null>,
 *   pulse?: (tabId: number) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   lingerMs?: number, tickMs?: number, refreshMs?: number, pageTtlMs?: number,
 * }} deps
 */
export function createTabTakeover(deps) {
  const {
    inject,
    captureFavicon = async () => null,
    pulse = () => {},
    pulseMs = 90,
    reinjectDelays = [250, 700, 1500],
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    lingerMs = 2500,
    tickMs = 400,
    refreshMs = 5000,
    pageTtlMs = 15000,
  } = deps;

  /** 进行中的工具调用,各自带一个"会话当前标签页"的 getter。 */
  const calls = new Set();
  /** tabId → 余韵截止时间。 */
  const lingerUntil = new Map();
  /** tabId → 激活记录。 */
  const active = new Map();
  /** tabId → 串行化的注入链,保证 stop 不会被更早发出的 start 反超。 */
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

  function desiredTabs(at) {
    const busy = new Set();
    for (const getter of calls) {
      const id = resolveTab(getter);
      if (id != null) busy.add(id);
    }
    for (const [id, until] of lingerUntil) {
      if (until > at) busy.add(id);
      else lingerUntil.delete(id);
    }
    return busy;
  }

  function start(tabId, record) {
    return enqueue(tabId, async () => {
      if (active.get(tabId) !== record) return;
      if (record.favicon === undefined) record.favicon = await captureFavicon(tabId).catch(() => null);
      if (active.get(tabId) !== record) return;
      await inject(tabId, "start", { favicon: record.favicon, ttlMs: pageTtlMs });
    });
  }

  function stopPulse(record) {
    if (record?.pulse != null) clearTimer(record.pulse);
    if (record) record.pulse = null;
  }

  function activate(tabId) {
    const record = { favicon: undefined, refresh: null, pulse: null };
    active.set(tabId, record);
    // 定期续命页面侧看门狗;SW 若被回收,页面 pageTtlMs 后自行收尾。
    const loop = () => {
      record.refresh = setTimer(() => {
        if (active.get(tabId) !== record) return;
        start(tabId, record);
        loop();
      }, refreshMs);
    };
    loop();
    start(tabId, record);
  }

  function deactivate(tabId) {
    const record = active.get(tabId);
    if (!record) return;
    active.delete(tabId);
    if (record.refresh != null) clearTimer(record.refresh);
    stopPulse(record);
    enqueue(tabId, () => inject(tabId, "stop"));
  }

  function reconcile() {
    if (wake != null) {
      clearTimer(wake);
      wake = null;
    }
    const at = now();
    const busy = desiredTabs(at);
    for (const id of busy) if (!active.has(id)) activate(id);
    for (const id of [...active.keys()]) if (!busy.has(id)) deactivate(id);

    let delay = null;
    if (calls.size > 0) delay = tickMs;
    for (const until of lingerUntil.values()) {
      const left = Math.max(until - at, 0) + 5;
      if (delay == null || left < delay) delay = left;
    }
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
     * @returns {() => void} 调用结束时调用,标签页进入余韵。
     */
    begin(getter) {
      const entry = () => getter();
      calls.add(entry);
      reconcile();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        calls.delete(entry);
        linger(resolveTab(getter));
        reconcile();
      };
    },
    /** 有命令打到了这个标签页(例如每条 CDP 命令)。 */
    touch(tabId) {
      if (!Number.isInteger(tabId)) return;
      linger(tabId);
      if (!active.has(tabId)) reconcile();
    },
    /**
     * 页面拿不到不受节流的 Worker 节拍器(CSP),请求由这里定时发 tick。
     * 仅限激活中的标签页,结束或换页即停。
     */
    requestPulse(tabId) {
      const record = active.get(tabId);
      if (!record || record.pulse != null) return;
      const loop = () => {
        record.pulse = setTimer(() => {
          if (active.get(tabId) !== record || record.pulse == null) return;
          pulse(tabId);
          loop();
        }, pulseMs);
      };
      loop();
    },
    /** chrome.tabs.onUpdated 转发:换页后重新注入,页面换了图标就跟着换。 */
    tabUpdated(tabId, changeInfo) {
      const record = active.get(tabId);
      if (!record || !changeInfo) return;
      if (changeInfo.url) {
        record.favicon = undefined;
        // 新文档也许允许 Worker;需要的话它会自己再来要脉冲。
        stopPulse(record);
      }
      // 激活期间页面自己的 icon 已被停用,data: 的变化基本都是我们自己的动效帧,
      // 每帧都会触发一次 onUpdated,必须忽略;新文档的真实图标多为 http(s) URL,
      // 再加上换页的 status 事件兜底,足以重新取到原图标。
      if (changeInfo.favIconUrl && !changeInfo.favIconUrl.startsWith("data:")) record.favicon = undefined;
      if (changeInfo.status === "complete" || changeInfo.status === "loading" || record.favicon === undefined) {
        start(tabId, record);
      }
      // "loading" 常在新文档提交之前就到,那次注入落在即将卸载的旧文档里;
      // 再补几次,让新页面不必等到 "complete"(重页面可能要好几秒)才转起来。
      // start 对同一文档是幂等的,多注入几次无副作用。
      if (changeInfo.status === "loading") {
        for (const delay of reinjectDelays) {
          setTimer(() => {
            if (active.get(tabId) === record) start(tabId, record);
          }, delay);
        }
      }
    },
    /** chrome.tabs.onRemoved 转发。 */
    tabRemoved(tabId) {
      const record = active.get(tabId);
      if (record?.refresh != null) clearTimer(record.refresh);
      stopPulse(record);
      active.delete(tabId);
      lingerUntil.delete(tabId);
      queues.delete(tabId);
    },
    isActive(tabId) {
      return active.has(tabId);
    },
    activeTabs() {
      return [...active.keys()];
    },
  };
}
