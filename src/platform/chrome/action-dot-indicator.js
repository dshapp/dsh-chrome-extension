// 工具栏图标上的状态圆点(任务未读:红 / 黄 / 绿,见 features/notifications/unread-policy.js)。
//
// chrome.action 的角标只能放文字、形状是一个胶囊,放不下一个「点」。所以把圆点直接画进图标:
// 取 manifest 的 16 / 32px 原图,右上角先挖一圈透明(浅色、深色工具栏都分得开),再画实心圆点,
// 经 action.setIcon({ imageData }) 换上;撤掉时换回原图。画不出来(取图 / OffscreenCanvas 失败)
// 时退回角标:一个空格 + 背景色,颜色至少还在。悬停提示同步写成「N 个任务…」。
//
// 平台层:只认 { color, title } 或 null,不认识「未读」是什么。

const ICON_PATHS = Object.freeze({ 16: "icons/icon16.png", 32: "icons/icon32.png" });

/** 圆点几何(像素):半径约占边长 1/5,外面挖一圈 gap 宽的透明,贴右上角。 */
export function dotGeometry(size) {
  const r = size * 0.21;
  const inset = size * 0.02;
  return { cx: size - r - inset, cy: r + inset, r, gap: size * 0.09 };
}

/**
 * 撤点时换回的原图。必须是以 / 开头的扩展根路径:SW 里 setIcon 的相对路径按 SW 脚本所在目录
 * (sw/)解析,"icons/icon16.png" 会变成 sw/icons/icon16.png → Failed to fetch,点就撤不掉。
 */
export function rootedIconPaths(paths) {
  return Object.fromEntries(Object.entries(paths).map(([size, path]) => [size, "/" + String(path).replace(/^\/+/, "")]));
}

export function createActionDotIndicator({
  api,
  log = () => {},
  iconPaths = ICON_PATHS,
  fetchImpl = (url) => fetch(url),
  createBitmap = (blob) => createImageBitmap(blob),
  CanvasImpl = globalThis.OffscreenCanvas
} = {}) {
  let bases = null;
  let shown;
  let chain = Promise.resolve();

  async function loadBases() {
    if (bases) return bases;
    if (typeof CanvasImpl !== "function") throw new Error("OffscreenCanvas unavailable");
    bases = await Promise.all(Object.entries(iconPaths).map(async ([size, path]) => {
      const response = await fetchImpl(api.runtime.getURL(path));
      if (!response.ok) throw new Error(`icon${size} status=${response.status}`);
      return [Number(size), await createBitmap(await response.blob())];
    })).catch((error) => {
      bases = null;
      throw error;
    });
    return bases;
  }

  function paint(bitmap, size, color) {
    const canvas = new CanvasImpl(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, size, size);
    const { cx, cy, r, gap } = dotGeometry(size);
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(cx, cy, r + gap, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    return ctx.getImageData(0, 0, size, size);
  }

  function defaultIconPaths() {
    const declared = api.runtime.getManifest?.()?.action?.default_icon;
    return rootedIconPaths(declared && typeof declared === "object" ? declared : iconPaths);
  }

  function defaultTitle() {
    return api.runtime.getManifest?.()?.name || "";
  }

  async function apply(dot) {
    const key = dot ? dot.color + "|" + (dot.title || "") : "";
    if (key === shown) return;
    shown = key;
    try {
      if (dot) {
        const imageData = {};
        for (const [size, bitmap] of await loadBases()) imageData[size] = paint(bitmap, size, dot.color);
        await api.action.setIcon({ imageData });
      } else {
        await api.action.setIcon({ path: defaultIconPaths() });
      }
      await api.action.setBadgeText({ text: "" });
    } catch (error) {
      log("TASK_DOT_WARN", dot ? "on" : "off", String(error?.message || error));
      try {
        await api.action.setBadgeText({ text: dot ? " " : "" });
        if (dot) await api.action.setBadgeBackgroundColor({ color: dot.color });
      } catch (badgeError) {
        log("TASK_BADGE_WARN", String(badgeError?.message || badgeError));
      }
    }
    try {
      const title = dot?.title || defaultTitle();
      if (title) await api.action.setTitle({ title });
    } catch (error) {
      log("TASK_TITLE_WARN", String(error?.message || error));
    }
  }

  return Object.freeze({
    /** dot: { color, title } 或 null(撤掉)。串行执行,相同的点不重画。 */
    show(dot) {
      chain = chain.then(() => apply(dot));
      return chain;
    }
  });
}
