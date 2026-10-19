/**
 * 标签页「受插件控制 / 正在被操作」的 favicon 标记 —— 注入页面的那一半。
 *
 * 由 sw/tab-takeover.js 通过 chrome.scripting.executeScript 注入到隔离世界。
 * 函数会被序列化后送进页面,所以必须完全自包含:不能引用模块里的任何其它绑定。
 *
 * 两种模式,同一圈蓝色弧线包住原站图标:
 *   - idle:   静止的整圈 —— 这个标签页受插件控制(操作过 / 会被操作);
 *   - active: 旋转的弧线 —— 插件此刻正在操作它。
 *
 * Chrome 的标签栏不播放 GIF/SVG favicon 动画,能动起来的唯一办法是不停地换
 * <link rel="icon"> 的 href。这里预先用 canvas 画好静止帧和 12 帧旋转帧。
 *
 * 期间页面自己的 icon link 被暂时"停用"(rel 改名并记下原值),否则 Chrome
 * 可能在多个候选里挑中页面的那个;页面中途新加/改回的 icon link 也会被
 * MutationObserver 立刻停用。stop 时把 rel 全部还原,Chrome 随之换回原图标。
 *
 * 两道兜底:
 *   - active 带截止时间,每次注入往后推 ttlMs;Service Worker 被回收、没来得及
 *     切回 idle 时,页面到点自己停转,退回静止圈;
 *   - 扩展被重载/卸载后,这段脚本所在的上下文失效(chrome.runtime.id 消失),
 *     页面自行拆掉标记,不留下一个无主的圈。
 *
 * @param {"active"|"idle"|"stop"} command  "start" 是 "active" 的旧名。
 * @param {{ favicon?: string|null, ttlMs?: number }} [options]
 */
export function tabTakeoverPageScript(command, options) {
  const KEY = "__dshTabTakeover";
  const existing = globalThis[KEY];
  if (command === "stop") {
    if (existing && existing.alive) existing.stop();
    return { stopped: true };
  }
  const mode = command === "idle" ? "idle" : "active";
  const opts = options || {};
  const ttlMs = typeof opts.ttlMs === "number" && opts.ttlMs > 0 ? opts.ttlMs : 15000;
  const favicon = typeof opts.favicon === "string" && opts.favicon ? opts.favicon : null;
  if (existing && existing.alive) {
    existing.apply(mode, ttlMs, favicon);
    return { refreshed: true, mode };
  }

  const doc = document;
  if (!doc.documentElement) return { skipped: "no-document" };

  const MARK = "data-dsh-takeover";
  const SAVED = "data-dsh-takeover-rel";
  const SUSPENDED_REL = "dsh-takeover-suspended";
  const SIZE = 32;
  const RADIUS = 13.5;
  const FRAME_COUNT = 12;
  const FRAME_MS = 90;
  const BLUE = "26,115,232";
  // 注意:不能给 data: URL 加 MIME 参数作记号(如 image/png;x=1;base64),
  // Chrome 会静默丢弃这种 favicon。要认出"这是我们的帧",用 isOwnFrame。
  const svg = (body) =>
    "data:image/svg+xml," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' + body + "</svg>");
  const DOT = '<circle cx="16" cy="16" r="5.5" fill="rgb(' + BLUE + ')"/>';
  const FALLBACK_IDLE = svg(
    '<circle cx="16" cy="16" r="13.5" fill="none" stroke="rgb(' + BLUE + ')" stroke-width="3.5"/>' + DOT,
  );
  const FALLBACK_ACTIVE = svg(
    '<circle cx="16" cy="16" r="13.5" fill="none" stroke="rgba(' + BLUE + ',.25)" stroke-width="3.5"/>' +
      '<path d="M16 2.5a13.5 13.5 0 0 1 13.5 13.5" fill="none" stroke="rgb(' + BLUE + ')" stroke-width="3.5" stroke-linecap="round"/>' +
      DOT,
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
    mode,
    deadline: Date.now() + ttlMs,
    favicon: null,
    idleFrame: FALLBACK_IDLE,
    frames: [FALLBACK_ACTIVE],
    index: 0,
    timer: 0,
    watchdog: 0,
    worker: null,
    workerFailed: false,
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
    ensureLink();
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

  /** 圈里的内容:原站图标(缩小裁圆),没有就画一个实心圆点。 */
  function drawCenter(ctx, img) {
    const c = SIZE / 2;
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, 10, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 8, 8, 16, 16);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(c, c, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(" + BLUE + ")";
      ctx.fill();
    }
  }

  /** 静止帧:一整圈实色蓝环。 */
  function drawIdle(ctx, img) {
    const c = SIZE / 2;
    ctx.clearRect(0, 0, SIZE, SIZE);
    drawCenter(ctx, img);
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(c, c, RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = "rgb(" + BLUE + ")";
    ctx.stroke();
  }

  /** 旋转帧:淡色底圈上,一段彗星尾巴似的弧线绕圈转。 */
  function drawActive(ctx, img, step) {
    const c = SIZE / 2;
    const phase = (step / FRAME_COUNT) * Math.PI * 2;
    ctx.clearRect(0, 0, SIZE, SIZE);
    drawCenter(ctx, img);
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(c, c, RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(" + BLUE + ",0.2)";
    ctx.stroke();
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
    ctx.arc(c, c, RADIUS, start, start + sweep);
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
    if (!ctx) return; // 无 canvas 时停在 SVG 兜底图标上。
    const img = await loadImage(src);
    if (token !== state.renderToken || !state.alive) return;
    let idle;
    const frames = [];
    try {
      drawIdle(ctx, img);
      idle = canvas.toDataURL("image/png");
      for (let i = 0; i < FRAME_COUNT; i++) {
        drawActive(ctx, img, i);
        frames.push(canvas.toDataURL("image/png"));
      }
    } catch {
      // 画布被污染(理论上 data: 源不会),退回不带原图标的版本。
      if (img) void render(null);
      return;
    }
    state.history.add(state.idleFrame);
    for (const frame of state.frames) state.history.add(frame);
    state.idleFrame = idle;
    state.frames = frames;
    if (state.mode === "idle") show(state.idleFrame);
  }

  function tick() {
    if (!state.alive || state.mode !== "active") return;
    const at = Date.now();
    if (at > state.deadline) return void setMode("idle");
    // 节拍可能同时来自多个来源(主线程定时器 + SW 脉冲),按时间去重,不至于转得更快。
    if (at - state.lastTick < FRAME_MS * 0.6) return;
    state.lastTick = at;
    state.index = (state.index + 1) % state.frames.length;
    show(state.frames[state.index]);
  }

  function requestPulse() {
    try {
      chrome.runtime.sendMessage({ type: "dsh-tab-takeover-pulse" }).catch(() => {});
    } catch {
      // 扩展上下文已失效:只剩主线程定时器。
    }
  }

  function onRuntimeMessage(message) {
    if (message && message.type === "dsh-tab-takeover-tick") tick();
  }

  /**
   * 拿不到 Worker(页面 CSP 不放行 blob:)时的后备:主线程定时器照跑(前台够用),
   * 同时请 SW 发 tick 消息 —— 消息投递不受后台定时器节流,后台标签页也能流畅转。
   */
  function fallbackToPulse() {
    state.workerFailed = true;
    if (!state.alive || state.mode !== "active") return;
    if (!state.timer) state.timer = setInterval(tick, FRAME_MS);
    state.pulse = true;
    requestPulse();
  }

  /**
   * 节拍器:后台标签页主线程的定时器会被 Chrome 压到 1Hz,动效只剩一秒一帧;
   * 专用 Worker 里的定时器不受这层节流,由它发 message 驱动换帧。
   */
  function startTicking() {
    if (state.worker || state.timer) return;
    if (state.workerFailed) return void fallbackToPulse();
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
  }

  function stopTicking() {
    clearInterval(state.timer);
    state.timer = 0;
    state.pulse = false;
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }
  }

  function setMode(next) {
    state.mode = next;
    if (next === "active") {
      show(state.frames[state.index % state.frames.length]);
      startTicking();
    } else {
      stopTicking();
      show(state.idleFrame);
    }
  }

  function stop() {
    if (!state.alive) return;
    state.alive = false;
    stopTicking();
    clearInterval(state.watchdog);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // 无 chrome.runtime(测试环境)或上下文失效。
    }
    if (state.observer) state.observer.disconnect();
    if (state.link) state.link.remove();
    for (const link of doc.querySelectorAll("link[" + SAVED + "]")) {
      link.setAttribute("rel", link.getAttribute(SAVED) || "icon");
      link.removeAttribute(SAVED);
    }
  }

  function apply(nextMode, nextTtl, nextFavicon) {
    state.deadline = Date.now() + nextTtl;
    if (nextFavicon && nextFavicon !== state.favicon) void render(nextFavicon);
    if (nextMode !== state.mode) setMode(nextMode);
    // SW 可能被回收重启过,丢了脉冲登记:续命时顺带再报一次。
    else if (state.pulse) requestPulse();
  }

  /** 扩展被重载/卸载后 chrome.runtime.id 消失,这时标记已无主。 */
  function extensionGone() {
    try {
      return !(typeof chrome === "object" && chrome.runtime && chrome.runtime.id);
    } catch {
      return true;
    }
  }

  for (const link of doc.querySelectorAll("link")) if (isPageIcon(link)) suspend(link);

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
  state.apply = apply;
  // stop 之后 Chrome 可能短暂还挂着最后一帧,所以停了也照样能认。
  state.isOwnFrame = (url) =>
    url === FALLBACK_IDLE || url === FALLBACK_ACTIVE || url === state.idleFrame ||
    state.frames.includes(url) || state.history.has(url);
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    // 无 chrome.runtime(测试环境)。
  }
  // 看门狗跑在主线程,一秒一次足够:旋转超时退回静止;扩展没了就整个拆掉。
  const checkRuntime = typeof chrome === "object" && chrome && chrome.runtime;
  state.watchdog = setInterval(() => {
    if (checkRuntime && extensionGone()) return void stop();
    if (state.mode === "active" && Date.now() > state.deadline) setMode("idle");
  }, 1000);
  globalThis[KEY] = state;
  setMode(mode);
  void render(favicon);
  return { started: true, mode };
}
