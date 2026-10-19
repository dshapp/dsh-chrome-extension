/**
 * 标签页「受插件控制 / 正在被操作」指示(Service Worker 侧装配)。
 *
 * CDP 桥(../background.js)在执行工具调用、向某个标签页发 CDP 命令、或会话
 * 选中/交还标签页时,通过 globalThis.__dshTabTakeover 报告。这里据此给标签页的
 * favicon 套一圈蓝环:受控时静止,正在被操作时像呼吸灯一样明暗;标签页关闭或被交还时拆掉。
 *
 * background.js 必须保持无 import 的独立脚本(它的测试直接求值源码),
 * 所以和 __dshBridgeState 一样走 globalThis 挂钩;钩子不存在时桥照常工作。
 */

import { createTabTakeover, isTakeoverFrame } from "../src/features/tab-takeover/takeover-controller.js";
import { tabTakeoverPageScript } from "../src/features/tab-takeover/takeover-page-script.js";

const MAX_FAVICON_BYTES = 256 * 1024;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 拿一个 URL 的图标内容转成 data: URL(SW 有 host 权限,不受页面 CORS 限制)。 */
async function fetchAsDataUrl(url) {
  if (!url) return null;
  // 我们自己的标记帧(带戳),绝不能当成站点原图标。
  if (url.startsWith("data:")) return isTakeoverFrame(url) ? null : url;
  if (!/^https?:/i.test(url)) return null;
  const response = await fetch(url, { credentials: "include", cache: "force-cache" });
  if (!response.ok) return null;
  const type = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (type && !type.startsWith("image/")) return null;
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_FAVICON_BYTES) return null;
  return `data:${type || "image/x-icon"};base64,${toBase64(buffer)}`;
}

/**
 * 页面声明的图标候选(包括被我们临时停用的那些),以及 Chrome 当前显示的
 * favIconUrl 是不是我们自己的动效帧。与注入脚本同在扩展的隔离世界,能看到它的状态。
 */
function readIconCandidatesScript(currentFavicon) {
  const takeover = globalThis.__dshTabTakeover;
  const ownFrame = Boolean(currentFavicon && takeover && takeover.isOwnFrame && takeover.isOwnFrame(currentFavicon));
  const out = [];
  for (const link of document.querySelectorAll("link")) {
    if (link.hasAttribute("data-dsh-takeover")) continue;
    const rel = (link.getAttribute("data-dsh-takeover-rel") ?? link.getAttribute("rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("icon") || !link.href) continue;
    out.push(link.href);
  }
  return { ownFrame, candidates: out };
}

/**
 * 当前页面的原始图标。优先用 Chrome 已选定的 favIconUrl;它若是(或可能是)我们
 * 自己的帧,退而读页面声明的候选,最后才猜 /favicon.ico。
 *
 * trustTabFavicon 为 false 表示这个标签页画过标记:此时 data: 的 favIconUrl 一律不信,
 * 它多半是上一个文档留下的我们的帧,当成原图标会画出圈套圈。
 */
async function captureFavicon(tabId, { trustTabFavicon = true } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const candidates = [];
  let page = null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readIconCandidatesScript,
      args: [tab.favIconUrl ?? null],
    });
    page = result?.result ?? null;
  } catch {
    // 注入不进去的页面也就画不了动效,无所谓。
  }
  // 带戳的一定是我们的帧;画过标记的标签页,不带戳的 data: 也可能是旧版本留下的帧,同样不信。
  const suspect = isTakeoverFrame(tab.favIconUrl) || (!trustTabFavicon && tab.favIconUrl?.startsWith("data:"));
  if (tab.favIconUrl && !page?.ownFrame && !suspect) candidates.push(tab.favIconUrl);
  if (Array.isArray(page?.candidates)) candidates.push(...page.candidates);
  try {
    const origin = new URL(tab.url).origin;
    if (/^https?:/.test(origin)) candidates.push(`${origin}/favicon.ico`);
  } catch {
    // 无效 URL。
  }
  for (const url of [...new Set(candidates)]) {
    try {
      const data = await fetchAsDataUrl(url);
      if (data) return data;
    } catch {
      // 换下一个候选。
    }
  }
  return null;
}

async function inject(tabId, command, options) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: tabTakeoverPageScript,
    args: [command, options ?? {}],
  });
}

function pulse(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "dsh-tab-takeover-tick" }, { frameId: 0 }).catch(() => {});
}

/** 受控标签页集合,跨 SW 重启保存;浏览器会话结束即清空,正好与 tab id 的寿命一致。 */
const CONTROLLED_KEY = "dsh_takeover_controlled";

function persist(tabIds) {
  chrome.storage.session.set({ [CONTROLLED_KEY]: tabIds }).catch(() => {});
}

export const tabTakeover = createTabTakeover({ inject, captureFavicon, pulse, persist });

globalThis.__dshTabTakeover = tabTakeover;

/** SW 冷启动:把仍然存在的受控标签页恢复成静止圈。 */
async function restoreControlled() {
  const stored = (await chrome.storage.session.get(CONTROLLED_KEY))[CONTROLLED_KEY];
  if (!Array.isArray(stored) || stored.length === 0) return;
  const open = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
  const alive = stored.filter((id) => open.has(id));
  if (alive.length !== stored.length) persist(alive);
  tabTakeover.restore(alive);
}

restoreControlled().catch(() => {});

/**
 * 拆掉扩展重载/更新前留下的无主标记。
 *
 * 重载后旧注入所在的隔离世界失去了执行能力(实测它的定时器不再跑,自毁看门狗也就
 * 不会触发),而它插的 link 和停用的页面图标还留在 DOM 里;受控记录(storage.session)
 * 又随重载清空,不会有人再来管它们。于是标签页一直挂着一个圈,还可能被新注入当成
 * 原图标套出第二个圈。所以安装/更新(含开发时的重载)时,把所有标签页清扫一遍。
 */
function sweepOrphanMarksScript() {
  for (const link of document.querySelectorAll("link[data-dsh-takeover]")) link.remove();
  for (const link of document.querySelectorAll("link[data-dsh-takeover-rel]")) {
    link.setAttribute("rel", link.getAttribute("data-dsh-takeover-rel") || "icon");
    link.removeAttribute("data-dsh-takeover-rel");
  }
}

async function sweepOrphanMarks() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file://*/*"] });
  await Promise.all(
    tabs
      // 受控的标签页(SW 重启恢复出来的)正由当前注入管理,别动。
      .filter((tab) => tabTakeover.modeOf(tab.id) == null)
      .map((tab) =>
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: sweepOrphanMarksScript }).catch(() => {}),
      ),
  );
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") sweepOrphanMarks().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => tabTakeover.tabUpdated(tabId, changeInfo));
chrome.tabs.onRemoved.addListener((tabId) => tabTakeover.tabRemoved(tabId));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "dsh-tab-takeover-pulse") return;
  if (sender.tab?.id == null || sender.frameId !== 0) return;
  tabTakeover.requestPulse(sender.tab.id);
});
