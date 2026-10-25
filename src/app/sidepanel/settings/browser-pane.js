// 浏览器 pane:Agent 浏览器控制(CDP 桥)的状态灯 + 「网页搜索」,对齐 Mac
// BrowserSettingsSection 的「连接」与「网页搜索」两段。Mac 那页另有插件 / 扩展两行,
// 那是为了把扩展装上;用户能看到这个侧栏,说明两者都已就绪,所以这里不重复。
//
// 桥状态只在 service worker 里,由 createBridgeStatus 按秒轮询;变化时只重画那一行,
// 整页重画会把用户正在操作的开关和下拉换掉。离开这一页要 stop(),轮询会唤醒 worker。
//
// 网页搜索的开关与引擎都写宿主设置(见 features/settings/web-search-settings.js)。
// 宿主是权威:写完重新 describe 再画,不做乐观更新 —— 只读部署会拒绝写入。
import { t } from "../../../shared/i18n.js";
import { createBridgeStatus } from "../bridge-settings.js";
import {
  WEB_NAMESPACE, WEB_SEARCH_NAMESPACE, WEB_SEARCH_ENGINES,
  readWebSearchSettings, webSearchToggleOps, webSearchEngineOps
} from "../../../features/settings/web-search-settings.js";
import { section, row, select, toggle, notice, statusLine, escapeHtml } from "./settings-ui.js";

export function createBrowserPane({ host, deps, settingsService, showToast }) {
  let snapshot = { namespaces: new Map(), writable: false };
  // 宿主读失败时的提示;只替换网页搜索那一段,桥那一行照常显示。
  let loadError = null;
  let busy = false;
  let loadGeneration = 0;
  let bridge = null;
  const bridgeStatus = createBridgeStatus({
    onChange: (next) => {
      // 行在不在取决于 available:它一变就得整页重画;之后的连接态变化只补那一行。
      const appeared = Boolean(next?.available) !== Boolean(bridge?.available);
      bridge = next;
      if (appeared) render();
      else paintBridge();
    }
  });

  /// 桥那一行的右侧。三态:已连接(握手完成)/ 无响应(daemon 接了连接却不应答,
  /// 光等重试修不好,所以红色)/ 未连接(桥在按 30s 的 alarm 重试)。
  function bridgeControl() {
    if (!bridge?.available) return "";
    if (bridge.status === "connected") return statusLine(t("bridge.connected"), "ok");
    if (bridge.status === "unresponsive") return statusLine(t("bridge.unresponsive"), "err");
    return statusLine(t("bridge.disconnected"), "busy");
  }

  /// 桥行的副标题:连上了报 daemon 地址,没连上给出排查方向。
  function bridgeHint() {
    if (!bridge?.available) return "";
    if (bridge.status === "connected") return escapeHtml(t("bridge.daemonAt", { url: bridge.url ?? "" }));
    if (bridge.status === "unresponsive") return escapeHtml(t("bridge.unresponsiveHint", { url: bridge.url ?? "" }));
    return escapeHtml(t("bridge.waiting"));
  }

  function paintBridge() {
    const slot = host.querySelector("#set-bridge-state");
    if (slot) slot.innerHTML = bridgeControl();
    const hint = host.querySelector("#set-bridge-detail");
    if (hint) hint.innerHTML = bridgeHint();
  }

  /// 这个部署里没有桥半部(侧栏单独跑在普通页面里)时整行不画 —— 一盏永远不亮的灯
  /// 只会让人以为坏了。
  function bridgeSection() {
    if (!bridge?.available) return "";
    return section({
      body: row({
        label: escapeHtml(t("settings.bridge")),
        hint: '<span id="set-bridge-detail">' + bridgeHint() + '</span>',
        control: '<span id="set-bridge-state">' + bridgeControl() + '</span>'
      })
    });
  }

  function webSearchSection() {
    const header = t("ws.section");
    if (loadError) return section({ header, body: notice(loadError) });
    const settings = readWebSearchSettings(snapshot.namespaces);
    if (!settings) return section({ header, body: row({ label: escapeHtml(t("ws.unavailable")) }) });
    const disabled = !snapshot.writable;
    return section({
      header,
      body: row({
        label: escapeHtml(t("ws.toggle")),
        hint: escapeHtml(t("ws.hint")),
        control: toggle({ id: "set-web-search", checked: settings.enabled, disabled, ariaLabel: t("ws.toggle") })
      }) + row({
        label: escapeHtml(t("ws.engine")),
        control: select({
          id: "set-web-search-engine",
          options: WEB_SEARCH_ENGINES.map((engine) => ({
            value: engine,
            label: t(`ws.engine.${engine}`),
            selected: engine === settings.engine
          })),
          disabled
        })
      }),
      footer: snapshot.writable ? "" : escapeHtml(t("set.readOnlyDocument"))
    });
  }

  function render() {
    host.innerHTML = bridgeSection() + webSearchSection();
    host.querySelector("#set-web-search")?.addEventListener("change", (event) => {
      write(WEB_NAMESPACE, webSearchToggleOps(event.target.checked));
    });
    host.querySelector("#set-web-search-engine")?.addEventListener("change", (event) => {
      write(WEB_SEARCH_NAMESPACE, webSearchEngineOps(event.target.value));
    });
  }

  async function write(ns, ops) {
    if (busy || !snapshot.writable) return;
    busy = true;
    try {
      await settingsService.mutate(ns, ops, snapshot.namespaces.get(ns)?.revision);
    } catch (error) {
      showToast?.(deps.formatErrorDetails(error));
    } finally {
      busy = false;
    }
    await loadSettings();
  }

  async function loadSettings() {
    const generation = ++loadGeneration;
    let describe;
    try {
      describe = await settingsService.describe();
    } catch (error) {
      if (generation !== loadGeneration) return;
      loadError = deps.formatErrorDetails(error);
      render();
      return;
    }
    if (generation !== loadGeneration) return;
    loadError = null;
    snapshot = {
      namespaces: new Map((describe?.namespaces ?? []).map((namespace) => [namespace.ns, namespace])),
      writable: describe?.writable === true
    };
    render();
  }

  async function refresh() {
    bridgeStatus.start();
    await loadSettings();
  }

  return {
    refresh,
    /// 离开浏览器页时停掉桥的轮询:它每秒唤醒一次 service worker。
    stop() {
      loadGeneration += 1;
      bridgeStatus.stop();
    }
  };
}
