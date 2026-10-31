// 左侧栏三档的「用户意图」与档位读取。
//
// 档位(窄 / 中 / 宽)与每一档长什么样,**全部**由 foundation.css 的两条 @media 决定:
// 拖动侧栏宽度时浏览器自己切换,JS 不挂 resize / matchMedia、不量宽度。这里只做两件事:
//
// 1. 维护 body 上的两个意图 class(第三个 —— 窄档浮层的 #session-drawer.open —— 归抽屉):
//    - sidebar-expanded:中档下用户主动展开(只在本页面实例里有效,不持久化);
//    - sidebar-collapsed:宽档下用户主动收起(持久化,刷新 / 再拖宽也不自动展开,
//      直到用户再主动展开)。
// 2. 在用户点击 / 导航这类时刻读一次 CSS 写在根上的 --sidebar-tier,判断这次操作的语义
//   (同一颗「收起」在宽档要记住、在中档不用记)。
//
// 收起偏好存在 localStorage 而不是 chrome.storage.local:后者是异步的,读回来之前宽档
// 已经按「默认展开」画出了第一帧,收起过的用户每次打开侧栏都会看到展开栏闪一下。
// 设置页的 tab 记忆(settings-root.js)也是同一个理由用的 localStorage。多个侧栏实例
// 之间靠 window 的 storage 事件同步。

export const SIDEBAR_COLLAPSED_KEY = "dsh_sidebar_collapsed";

export const SidebarTier = Object.freeze({
  overlay: "overlay",
  rail: "rail",
  expanded: "expanded"
});

const TIERS = new Set(Object.values(SidebarTier));
const EXPANDED_CLASS = "sidebar-expanded";
const COLLAPSED_CLASS = "sidebar-collapsed";

/// 当前档位:读 foundation.css 按 @media 写在 :root 上的 --sidebar-tier。
/// 读不到(测试环境、样式表还没加载)时按窄档处理 —— 那就是改动前的行为。
export function readSidebarTier(doc = globalThis.document) {
  const view = doc?.defaultView;
  const root = doc?.documentElement;
  if (!root || typeof view?.getComputedStyle !== "function") return SidebarTier.overlay;
  const value = view.getComputedStyle(root).getPropertyValue("--sidebar-tier").trim();
  return TIERS.has(value) ? value : SidebarTier.overlay;
}

/// 抽屉此刻是否可见。与 foundation.css 的选择器一一对应:
///   窄档:只看浮层 .open;
///   中档:.open 或 sidebar-expanded;
///   宽档:.open、sidebar-expanded,或没有 sidebar-collapsed。
export function sidebarShown({ tier, overlayOpen = false, expanded = false, collapsed = false }) {
  if (overlayOpen) return true;
  if (tier === SidebarTier.overlay) return false;
  if (expanded) return true;
  return tier === SidebarTier.expanded && !collapsed;
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {Storage|null} [options.storage] 默认 localStorage;写不了(隐私模式等)时静默退化成只在内存里。
 */
export function createSidebarState({ doc = globalThis.document, storage = defaultStorage() } = {}) {
  const body = doc.body;
  const has = (name) => body.classList.contains(name);

  function readCollapsed() {
    try { return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
  }
  function persistCollapsed(value) {
    body.classList.toggle(COLLAPSED_CLASS, value);
    try {
      if (value) storage?.setItem(SIDEBAR_COLLAPSED_KEY, "1");
      else storage?.removeItem(SIDEBAR_COLLAPSED_KEY);
    } catch { /* 写不了就只在本页生效 */ }
  }

  // 同步读、同步上 class:首帧就按用户的选择画,不闪。
  body.classList.toggle(COLLAPSED_CLASS, readCollapsed());
  // 另一个侧栏实例改了偏好:class 一换,CSS 自己切形态。
  doc.defaultView?.addEventListener?.("storage", (event) => {
    if (event.key !== null && event.key !== SIDEBAR_COLLAPSED_KEY) return;
    body.classList.toggle(COLLAPSED_CLASS, readCollapsed());
  });

  const tier = () => readSidebarTier(doc);
  return {
    tier,
    /// 挤出档(中 / 宽):抽屉是常驻的一栏,不是浮层。
    pushed: () => tier() !== SidebarTier.overlay,
    isShown: (overlayOpen = false) => sidebarShown({
      tier: tier(), overlayOpen, expanded: has(EXPANDED_CLASS), collapsed: has(COLLAPSED_CLASS)
    }),
    isCollapsed: () => has(COLLAPSED_CLASS),
    /// 用户主动展开。宽档本来就默认展开,清掉「收起」即可 —— 不加 sidebar-expanded,
    /// 这样再拖窄到中档时仍按中档的默认回到图标栏。中档则要显式标记展开。
    expand() {
      if (tier() !== SidebarTier.expanded) body.classList.add(EXPANDED_CLASS);
      persistCollapsed(false);
    },
    /// 用户主动收起。只有宽档的收起要记住(中档本来就默认收起,窄档关浮层是常态)。
    collapse() {
      body.classList.remove(EXPANDED_CLASS);
      if (tier() === SidebarTier.expanded) persistCollapsed(true);
    }
  };
}
