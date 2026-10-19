// 首次使用引导:本机还没装好 dsh / dsh-chrome-control 时,替代那句
// "Specified native messaging host not found." 的安装指引。
//
// 侧栏与欢迎页共用这一份:renderSetupGuide 是纯函数(便于测试),
// mountSetupGuide 负责挂载、复制按钮、以及"装好就自动连上"的轮询。
//
// 轮询只调只读的 probe(宿主 cmd:"status",不拉起任何进程)。宿主没装时 Chrome
// 直接失败、不会起进程,所以 3s 一次的成本可以忽略;页面不可见时暂停,
// 回到前台立刻补测一次 —— 用户多半是从终端装完切回来的。
import { t, getLang } from "../../shared/i18n.js";
import { lucideIconSvg } from "../chat/file-icons.js";
import { NativeHostIssue, classifyNativeFailure } from "../../platform/dsh/native-host-error.js";

export const SETUP_COMMANDS = Object.freeze({
  // dsh plugin 把参数原样转给 pnpm(PATH 上找不到就以 127 退出),所以装插件之前
  // 必须先有 pnpm。用 npm 装:上一步刚装好 Node,npm 必然在。
  pnpm: "npm install -g pnpm",
  dsh: "npm install -g @deepseek-ai/dsh",
  plugin: "dsh plugin --profile web add dsh-chrome-control",
  start: "dsh web"
});

const SITE = "https://dshapp.github.io";

/**
 * 一键检查 / 安装脚本,主体托管在 dsh-site(static/install/)。缺什么装什么,
 * 已满足的步骤跳过,最后启动一次 dsh web 让插件注册本地启动器。
 *
 * Windows 那行刻意不含 "$":粘进 PowerShell 时外层双引号不会先展开变量,粘进
 * cmd 也没有要转义的字符;按字节下载再按 UTF-8 解码,中文提示不受代码页影响。
 */
export const INSTALL_SCRIPTS = Object.freeze({
  unix: Object.freeze({
    url: SITE + "/install/chrome.sh",
    command: "curl -fsSL " + SITE + "/install/chrome.sh | bash"
  }),
  win: Object.freeze({
    url: SITE + "/install/chrome.ps1",
    command: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"[Net.ServicePointManager]::SecurityProtocol=3072; "
      + "iex ([Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('" + SITE + "/install/chrome.ps1')))\""
  })
});

export function setupLinks(lang = getLang()) {
  const prefix = lang === "zh" ? SITE : SITE + "/en";
  return Object.freeze({
    app: prefix + "/download/#mac",
    docs: prefix + "/docs/install-chrome/",
    troubleshooting: prefix + "/docs/troubleshooting/",
    node: "https://nodejs.org/"
  });
}

const KNOWN_ISSUES = new Set(Object.values(NativeHostIssue));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function commandRow(command) {
  return '<div class="setup-cmd"><code>' + escapeHtml(command) + "</code>"
    + '<button class="setup-copy" type="button" data-copy="' + escapeHtml(command) + '"'
    + ' aria-label="' + escapeHtml(t("setup.copy")) + '" title="' + escapeHtml(t("setup.copy")) + '">'
    + lucideIconSvg("copy", { size: 13 }) + "</button></div>";
}

function link(href, label, icon = "external-link") {
  return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">'
    + escapeHtml(label) + lucideIconSvg(icon, { size: 12 }) + "</a>";
}

function appCard(links) {
  return '<section class="setup-card setup-card-app">'
    + '<div class="setup-card-head"><b>' + escapeHtml(t("setup.optionApp")) + "</b>"
    + '<span class="setup-note">' + escapeHtml(t("setup.optionAppNote")) + "</span></div>"
    + "<p>" + escapeHtml(t("setup.optionAppBody")) + "</p>"
    + '<a class="btn primary setup-download" href="' + escapeHtml(links.app) + '" target="_blank" rel="noopener noreferrer">'
    + lucideIconSvg("download", { size: 14 }) + "<span>" + escapeHtml(t("setup.download")) + "</span></a>"
    + "</section>";
}

/// 一键脚本卡片:一条命令完成检查与安装,手动步骤折叠在下面备查。
function scriptCard(links, { alt, os }) {
  const script = os === "win" ? INSTALL_SCRIPTS.win : INSTALL_SCRIPTS.unix;
  const where = os === "win" ? "setup.scriptWhereWin" : os === "mac" ? "setup.scriptWhereMac" : "setup.scriptWhereUnix";
  return '<section class="setup-card setup-card-script">'
    + '<div class="setup-card-head"><b>' + escapeHtml(t(alt ? "setup.optionScriptAlt" : "setup.optionScript")) + "</b>"
    + '<span class="setup-note">' + escapeHtml(t(where)) + "</span></div>"
    + commandRow(script.command)
    + '<p class="setup-note">' + escapeHtml(t("setup.scriptBody")) + " " + link(script.url, t("setup.scriptView")) + "</p>"
    + manualSteps(links)
    + "</section>";
}

function manualSteps(links) {
  return '<details class="setup-manual"><summary>' + escapeHtml(t("setup.manual")) + "</summary>"
    + '<ol class="setup-steps">'
    + '<li><span class="setup-step-title">' + escapeHtml(t("setup.stepNode")) + " · " + link(links.node, t("setup.stepNodeLink")) + "</span></li>"
    + '<li><span class="setup-step-title">' + escapeHtml(t("setup.stepPnpm")) + "</span>" + commandRow(SETUP_COMMANDS.pnpm)
    + '<p class="setup-note">' + escapeHtml(t("setup.stepPnpmNote")) + "</p></li>"
    + '<li><span class="setup-step-title">' + escapeHtml(t("setup.stepDsh")) + "</span>" + commandRow(SETUP_COMMANDS.dsh) + "</li>"
    + '<li><span class="setup-step-title">' + escapeHtml(t("setup.stepPlugin")) + "</span>" + commandRow(SETUP_COMMANDS.plugin) + "</li>"
    + '<li><span class="setup-step-title">' + escapeHtml(t("setup.stepStart")) + "</span>" + commandRow(SETUP_COMMANDS.start)
    + '<p class="setup-note">' + escapeHtml(t("setup.stepStartNote")) + "</p></li>"
    + "</ol></details>";
}

function repairCard(issue) {
  return '<section class="setup-card">'
    + '<div class="setup-card-head"><b>' + escapeHtml(t("setup.restart")) + "</b></div>"
    + commandRow(SETUP_COMMANDS.start)
    + (issue === NativeHostIssue.BROKEN ? '<p class="setup-note">' + escapeHtml(t("setup.logs")) + "</p>" : "")
    + "</section>";
}

function statusRow(phase) {
  if (phase === "detected") {
    return '<div class="setup-status ok" role="status" aria-live="polite">'
      + lucideIconSvg("circle-check", { size: 14 }) + "<span>" + escapeHtml(t("setup.detected")) + "</span></div>";
  }
  const checking = phase === "checking";
  return '<div class="setup-status" role="status" aria-live="polite">'
    + '<span class="setup-spinner" aria-hidden="true"></span>'
    + "<span>" + escapeHtml(t(checking ? "setup.checking" : "setup.waiting")) + "</span>"
    + '<button class="btn setup-check" type="button" data-setup-check' + (checking ? " disabled" : "") + ">"
    + lucideIconSvg("rotate-cw", { size: 13 }) + "<span>" + escapeHtml(t("setup.checkNow")) + "</span></button></div>";
}

/**
 * 只在 Mac 上推荐 DSH macOS App。App 只有 Apple Silicon 版,所以明确报告为 x86
 * 的 Mac(Intel)也不推荐;arch 未知时按 Mac 处理。其他系统(Linux、ChromeOS、
 * 无法识别的平台)一律只给命令行步骤 —— 宁可少推荐,也不能把装不了的 App 推给用户。
 */
export function recommendsMacApp({ os, arch } = {}) {
  if (os !== "mac") return false;
  return !/^x86/.test(String(arch ?? ""));
}

/**
 * 纯渲染。issue 取 NativeHostIssue 之一;os / arch 取 chrome.runtime.getPlatformInfo()
 * (os: "mac" | "linux" | "win" | …,arch: "arm64" | "x86-64" | …);
 * phase 为 waiting / checking / detected。
 */
export function renderSetupGuide({ issue = NativeHostIssue.MISSING, os = "unknown", arch = "", detail = "", phase = "waiting", lang } = {}) {
  const kind = KNOWN_ISSUES.has(issue) ? issue : NativeHostIssue.MISSING;
  const links = setupLinks(lang);
  const withApp = kind === NativeHostIssue.MISSING && recommendsMacApp({ os, arch });
  let body = "";
  if (kind === NativeHostIssue.MISSING) {
    body = (withApp ? appCard(links) : "") + scriptCard(links, { alt: withApp, os });
  } else if (kind === NativeHostIssue.FORBIDDEN || kind === NativeHostIssue.BROKEN) {
    body = repairCard(kind);
  }
  // "按下面任一方式安装" 只在真有两种方式(App + 命令行)时成立;只有命令行时换成单一路径的说法。
  let ledeKey = "setup.lede." + kind;
  if (kind === NativeHostIssue.MISSING && !withApp) ledeKey += ".cli";
  const showDetail = detail && kind !== NativeHostIssue.MISSING;
  return '<div class="setup-guide-inner" data-issue="' + escapeHtml(kind) + '">'
    + '<header class="setup-hero">'
    + '<div class="setup-badge" aria-hidden="true">' + lucideIconSvg(kind === NativeHostIssue.MISSING ? "terminal" : "triangle-alert", { size: 18 }) + "</div>"
    + '<h2 id="setup-guide-title">' + escapeHtml(t("setup.title." + kind)) + "</h2>"
    + '<p class="setup-lede">' + escapeHtml(t(ledeKey)) + "</p>"
    + "</header>"
    + body
    + statusRow(phase)
    + (showDetail ? '<p class="setup-detail">' + escapeHtml(t("setup.detail", { detail })) + "</p>" : "")
    + '<footer class="setup-links">' + link(links.docs, t("setup.docs")) + link(links.troubleshooting, t("setup.troubleshooting")) + "</footer>"
    + "</div>";
}

async function defaultPlatform() {
  try {
    const info = await globalThis.chrome?.runtime?.getPlatformInfo?.();
    if (info?.os) return { os: info.os, arch: info.arch ?? "" };
  } catch { /* 拿不到就按 UA 猜 */ }
  // UA 兜底只认得出的平台;认不出时给 unknown,不默认成 Mac(否则会误推 App)。
  const ua = String(globalThis.navigator?.userAgent ?? "");
  if (/Windows/i.test(ua)) return { os: "win", arch: "" };
  if (/CrOS/i.test(ua)) return { os: "cros", arch: "" };
  if (/Linux/i.test(ua)) return { os: "linux", arch: "" };
  if (/Macintosh|Mac OS X/i.test(ua)) return { os: "mac", arch: "" };
  return { os: "unknown", arch: "" };
}

async function defaultCopy(text) {
  await globalThis.navigator.clipboard.writeText(text);
}

/**
 * 挂到 host 上。probe() 需返回 { ok, reason?, detail? }(即 probeHost 的回包);
 * ok 时调用 onReady() —— 由调用方决定"装好之后做什么"(侧栏:重新连接;欢迎页:
 * 切到就绪态)。
 */
export function mountSetupGuide(host, options) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const probe = options.probe;
  const onReady = options.onReady;
  const intervalMs = options.intervalMs ?? 3000;
  const copy = options.copy ?? defaultCopy;
  // { os, arch };测试可经 options.os / options.arch 注入,否则 show() 时探测。
  let platform = options.os ? { os: options.os, arch: options.arch ?? "" } : null;
  let issue = NativeHostIssue.MISSING;
  let detail = "";
  let phase = "waiting";
  let open = false;
  let timer = null;
  let probing = false;

  const render = () => {
    if (!open) return;
    host.innerHTML = renderSetupGuide({ issue, os: platform?.os ?? "unknown", arch: platform?.arch ?? "", detail, phase });
  };

  const stopTimer = () => { if (timer) { win.clearInterval(timer); timer = null; } };
  const startTimer = () => {
    stopTimer();
    if (open && intervalMs > 0 && !doc.hidden) timer = win.setInterval(() => { void check({ quiet: true }); }, intervalMs);
  };

  async function check({ quiet = false } = {}) {
    if (!open || probing || phase === "detected") return false;
    probing = true;
    if (!quiet) { phase = "checking"; render(); }
    let result = null;
    try { result = await probe(); } catch (error) { result = { ok: false, reason: String(error?.message || error) }; }
    probing = false;
    if (!open) return false;
    if (result?.ok) {
      phase = "detected";
      stopTimer();
      render();
      try { await onReady?.(); } catch { /* onReady 自己负责报错;失败时它会再 show() */ }
      return true;
    }
    // 状态可能变了(比如从"没装"变成"装了但起不来"),跟着换文案。
    const next = classifyNativeFailure(result?.reason) ?? (KNOWN_ISSUES.has(result?.reason) ? result.reason : null);
    if (next && next !== issue) { issue = next; detail = result?.detail ?? result?.reason ?? ""; }
    phase = "waiting";
    render();
    return false;
  }

  function hide() {
    open = false;
    stopTimer();
    host.hidden = true;
    host.textContent = "";
  }

  const onClick = async (event) => {
    const target = event.target.closest?.("[data-copy], [data-setup-check]");
    if (!target || !host.contains(target)) return;
    if (target.hasAttribute("data-setup-check")) { void check(); return; }
    const text = target.getAttribute("data-copy");
    try {
      await copy(text);
      target.classList.add("copied");
      const label = target.querySelector("span");
      const previous = label?.textContent;
      if (label) label.textContent = t("setup.copied");
      target.setAttribute("title", t("setup.copied"));
      win.setTimeout(() => {
        target.classList.remove("copied");
        if (label && previous != null) label.textContent = previous;
        target.setAttribute("title", t("setup.copy"));
      }, 1500);
    } catch { /* 剪贴板被拒:命令仍在页面上,可手动选中 */ }
  };
  const onVisibility = () => {
    if (!open) return;
    if (doc.hidden) { stopTimer(); return; }
    startTimer();
    void check({ quiet: true });
  };
  host.addEventListener("click", onClick);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", onVisibility);

  return Object.freeze({
    async show(nextIssue, nextDetail = "") {
      issue = KNOWN_ISSUES.has(nextIssue) ? nextIssue : NativeHostIssue.MISSING;
      detail = nextDetail || "";
      phase = "waiting";
      open = true;
      host.hidden = false;
      if (!platform) platform = await defaultPlatform();
      render();
      startTimer();
    },
    hide,
    isOpen: () => open,
    get issue() { return issue; },
    check,
    relabel: render,
    dispose() {
      hide();
      host.removeEventListener("click", onClick);
      doc.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("focus", onVisibility);
    }
  });
}
