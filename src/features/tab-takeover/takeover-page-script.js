/**
 * 标签页「正在被接管」的 favicon 动效 —— 注入页面的那一半。
 *
 * 由 sw/tab-takeover.js 通过 chrome.scripting.executeScript 注入到隔离世界。
 * 函数会被序列化后送进页面,所以必须完全自包含:不能引用模块里的任何其它绑定。
 *
 * Chrome 的标签栏不播放 GIF/SVG favicon 动画,能动起来的唯一办法是不停地换
 * <link rel="icon"> 的 href。这里预先用 canvas 画好一圈旋转的帧,再按定时器轮播。
 *
 * 期间页面自己的 icon link 被暂时"停用"(rel 改名并记下原值),否则 Chrome
 * 可能在多个候选里挑中页面的那个;页面中途新加/改回的 icon link 也会被
 * MutationObserver 立刻停用。stop 时把 rel 全部还原,Chrome 随之换回原图标。
 *
 * 看门狗:每次 start 都把截止时间往后推 ttlMs。Service Worker 被回收、来不及
 * 发 stop 时,页面到点自己收尾,不会永远转下去。
 *
 * @param {"start"|"stop"} command
 * @param {{ favicon?: string|null, ttlMs?: number }} [options]
 */
export function tabTakeoverPageScript(command, options) {
  const KEY = "__dshTabTakeover";
  const existing = globalThis[KEY];
  if (command === "stop") {
    if (existing && existing.alive) existing.stop();
    return { stopped: Boolean(existing && existing.alive === false) };
  }
  const opts = options || {};
  const ttlMs = typeof opts.ttlMs === "number" && opts.ttlMs > 0 ? opts.ttlMs : 15000;
  const favicon = typeof opts.favicon === "string" && opts.favicon ? opts.favicon : null;
  if (existing && existing.alive) {
    existing.refresh(ttlMs, favicon);
    return { refreshed: true };
  }

  const doc = document;
  if (!doc.documentElement) return { skipped: "no-document" };

  const MARK = "data-dsh-takeover";
  const SAVED = "data-dsh-takeover-rel";
  const SUSPENDED_REL = "dsh-takeover-suspended";
  const SIZE = 32;
  const FRAME_COUNT = 12;
  const FRAME_MS = 90;
  const BLUE = "26,115,232";
  // 注意:不能给 data: URL 加 MIME 参数作记号(如 image/png;x=1;base64),
  // Chrome 会静默丢弃这种 favicon。要认出"这是我们的帧",用 isOwnFrame。
  const FALLBACK =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<circle cx="16" cy="16" r="13.5" fill="none" stroke="rgba(' + BLUE + ',.25)" stroke-width="3.5"/>' +
        '<path d="M16 2.5a13.5 13.5 0 0 1 13.5 13.5" fill="none" stroke="rgb(' + BLUE + ')" stroke-width="3.5" stroke-linecap="round"/>' +
        '<circle cx="16" cy="16" r="5.5" fill="rgb(' + BLUE + ')"/></svg>',
    );

  const isPageIcon = (node) =>
    node && node.nodeType === 1 && node.localName === "link" && !node.hasAttribute(MARK) &&
    node.relList && node.relList.contains("icon");
  const suspend = (link) => {
    link.setAttribute(SAVED, link.getAttribute("rel") || "");
    link.setAttribute("rel", SUSPENDED_REL);
  };

  const state = {
    alive: true,
    deadline: Date.now() + ttlMs,
    favicon: null,
    frames: [FALLBACK],
    index: 0,
    timer: 0,
    watchdog: 0,
    worker: null,
    pulse: false,
    lastTick: 0,
    observer: null,
    link: null,
    renderToken: 0,
    /** 换过的旧帧,isOwnFrame 用。 */
    history: new Set(),
  };

  function host() {
    return doc.head || doc.documentElement;
  }

  function ensureLink() {
    if (!state.link) {
      const link = doc.createElement("link");
      link.setAttribute(MARK, "");
      link.setAttribute("rel", "icon");
      state.link = link;
    }
    // 页面框架(react-helmet 之类)可能整块重写 <head>,把我们的 link 一起带走。
    if (!state.link.isConnected) host().appendChild(state.link);
  }

  function show(href) {
    if (!state.link) return;
    if (state.link.getAttribute("href") !== href) {
      state.link.setAttribute("type", href.startsWith("data:image/svg") ? "image/svg+xml" : "image/png");
      state.link.setAttribute("href", href);
    }
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      const timer = setTimeout(() => resolve(null), 1500);
      img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0 ? img : null); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  }

  function drawFrame(ctx, img, step) {
    const c = SIZE / 2;
    const radius = 13.5;
    const phase = (step / FRAME_COUNT) * Math.PI * 2;
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (img) {
      // 原站图标缩在圈里,用户仍认得出是哪个页面。
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, 10, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 8, 8, 16, 16);
      ctx.restore();
    } else {
      // 没有原图标时画一个呼吸的实心圆点。
      const pulse = 0.5 + 0.5 * Math.sin(phase);
      ctx.beginPath();
      ctx.arc(c, c, 4.5 + pulse * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(" + BLUE + "," + (0.65 + 0.35 * pulse) + ")";
      ctx.fill();
    }
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(c, c, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(" + BLUE + ",0.2)";
    ctx.stroke();
    // 彗星尾巴:一段从透明渐到实色的弧,头部圆角,整体旋转。
    const start = phase - Math.PI / 2;
    const sweep = Math.PI * 1.4;
    // 渐变原点比弧起点再往回退一点:尾端的圆角帽会伸到起点之前,若正落在
    // 渐变 1.0 处就会是一颗实色小点;退出这段让它落在透明区里。
    const lead = 0.35;
    const turn = Math.PI * 2;
    const conic = typeof ctx.createConicGradient === "function" ? ctx.createConicGradient(start - lead, c, c) : null;
    if (conic) {
      conic.addColorStop(0, "rgba(" + BLUE + ",0)");
      conic.addColorStop(lead / turn, "rgba(" + BLUE + ",0)");
      conic.addColorStop((lead + sweep) / turn, "rgba(" + BLUE + ",1)");
      conic.addColorStop(1, "rgba(" + BLUE + ",1)");
    }
    ctx.beginPath();
    ctx.arc(c, c, radius, start, start + sweep);
    ctx.strokeStyle = conic || "rgb(" + BLUE + ")";
    ctx.stroke();
  }

  async function render(src) {
    const token = ++state.renderToken;
    state.favicon = src;
    let canvas;
    let ctx = null;
    try {
      canvas = doc.createElement("canvas");
      canvas.width = SIZE;
      canvas.height = SIZE;
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return; // 无 canvas 时停在静态兜底图标上。
    const img = await loadImage(src);
    if (token !== state.renderToken || !state.alive) return;
    const frames = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      drawFrame(ctx, img, i);
      try {
        frames.push(canvas.toDataURL("image/png"));
      } catch {
        // 画布被污染(理论上 data: 源不会),退回不带原图标的版本。
        if (img) return void render(null);
        return;
      }
    }
    for (const frame of state.frames) state.history.add(frame);
    state.frames = frames;
  }

  function tick() {
    if (!state.alive) return;
    const at = Date.now();
    if (at > state.deadline) return void stop();
    // 节拍可能同时来自多个来源(主线程定时器 + SW 脉冲),按时间去重,不至于转得更快。
    if (at - state.lastTick < FRAME_MS * 0.6) return;
    state.lastTick = at;
    ensureLink();
    state.index = (state.index + 1) % state.frames.length;
    show(state.frames[state.index]);
  }

  function stop() {
    if (!state.alive) return;
    state.alive = false;
    clearInterval(state.timer);
    clearInterval(state.watchdog);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // 无 chrome.runtime(测试环境)或上下文失效。
    }
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
    if (state.observer) state.observer.disconnect();
    if (state.link) state.link.remove();
    for (const link of doc.querySelectorAll("link[" + SAVED + "]")) {
      link.setAttribute("rel", link.getAttribute(SAVED) || "icon");
      link.removeAttribute(SAVED);
    }
  }

  /**
   * 拿不到 Worker(页面 CSP 不放行 blob:)时的后备:主线程定时器照跑(前台够用),
   * 同时请 SW 发 tick 消息 —— 消息投递不受后台定时器节流,后台标签页也能流畅转。
   */
  function fallbackToPulse() {
    if (!state.alive) return;
    if (!state.timer) state.timer = setInterval(tick, FRAME_MS);
    state.pulse = true;
    requestPulse();
  }

  function requestPulse() {
    try {
      chrome.runtime.sendMessage({ type: "dsh-tab-takeover-pulse" }).catch(() => {});
    } catch {
      // 扩展上下文已失效(扩展被重载):只剩主线程定时器。
    }
  }

  function onRuntimeMessage(message) {
    if (message && message.type === "dsh-tab-takeover-tick") tick();
  }

  function refresh(nextTtl, nextFavicon) {
    state.deadline = Date.now() + nextTtl;
    // SW 可能被回收重启过,丢了脉冲登记:续命时顺带再报一次。
    if (state.pulse) requestPulse();
    if (nextFavicon && nextFavicon !== state.favicon) void render(nextFavicon);
  }

  for (const link of doc.querySelectorAll("link")) if (isPageIcon(link)) suspend(link);
  ensureLink();
  show(FALLBACK);

  if (typeof MutationObserver === "function") {
    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (isPageIcon(record.target)) suspend(record.target);
          continue;
        }
        for (const node of record.addedNodes) {
          if (isPageIcon(node)) suspend(node);
          // 只在整块 <head> 被换掉时才深搜,别为页面每次插 DOM 都扫一遍。
          else if (node.nodeType === 1 && node.localName === "head") {
            for (const inner of node.querySelectorAll("link")) if (isPageIcon(inner)) suspend(inner);
          }
        }
      }
    });
    state.observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["rel"],
    });
  }

  state.stop = stop;
  state.refresh = refresh;
  // stop 之后 Chrome 可能短暂还挂着最后一帧,所以停了也照样能认。
  state.isOwnFrame = (url) => url === FALLBACK || state.frames.includes(url) || state.history.has(url);
  // 节拍器:后台标签页主线程的定时器会被 Chrome 压到 1Hz,动效只剩一秒一帧;
  // 专用 Worker 里的定时器不受这层节流,由它发 message 驱动换帧。页面 CSP
  // 不允许 blob: Worker 时退回主线程 setInterval(前台照样流畅)。
  try {
    const source = "setInterval(function(){postMessage(0)}," + FRAME_MS + ")";
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = tick;
    worker.onerror = () => {
      // CSP 拒绝等异步失败。
      worker.terminate();
      if (state.worker === worker) state.worker = null;
      fallbackToPulse();
    };
    state.worker = worker;
  } catch {
    fallbackToPulse();
  }
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    // 无 chrome.runtime(测试环境)。
  }
  // 看门狗独立跑在主线程:哪怕节拍器静默失效,到点也一定收尾。
  state.watchdog = setInterval(() => {
    if (Date.now() > state.deadline) stop();
  }, 1000);
  globalThis[KEY] = state;
  void render(favicon);
  return { started: true };
}
