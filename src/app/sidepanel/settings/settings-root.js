// 设置页根:tab 切换 + 各 pane 的懒加载,以及 pane 共用的模态(sheet)。
// 对齐 macos/.../Settings/SettingsRoot.swift 的 TabView:选中的 tab 记在
// 本地存储里,下次打开设置页回到同一页(Mac 用 @AppStorage("settingsSection"))。
import { t } from "../../../shared/i18n.js";
import { mountBridgeSettings } from "../bridge-settings.js";
import { createSettingsService } from "../../../features/settings/settings-service.js";
import { createGeneralPane } from "./general-pane.js";
import { createModelsPane } from "./models-pane.js";
import { createPresetsPane } from "./presets-pane.js";
import { createPluginsPane } from "./plugins-pane.js";
import { createServerPane } from "./server-pane.js";
import { escapeHtml } from "./settings-ui.js";

const TABS = ["general", "models", "presets", "plugins", "server"];
const TAB_STORAGE_KEY = "codemax_dsh_settings_tab";

/// 设置页里共用的模态。Mac 用 .sheet 挂在 Settings 窗口上,这里用一个 <dialog>
/// 复用:同一时刻只会有一个 sheet(编辑提供方时不会再开自定义提供方)。
function createSheet(dialog) {
  const bodyHost = dialog.querySelector("#settings-sheet-body");
  let currentActions = "";

  function paint(title, body, actions) {
    bodyHost.innerHTML = `<div class="set-sheet-head">${escapeHtml(title)}</div>`
      + `<div class="set-sheet-body">${body}</div>`
      + `<div class="set-sheet-actions">${actions ?? ""}</div>`;
  }

  return {
    get root() { return bodyHost; },
    open({ title, body, actions, bind }) {
      currentActions = actions ?? "";
      paint(title, body, currentActions);
      this._title = title;
      if (!dialog.open) dialog.showModal();
      bind?.(bodyHost);
    },
    /// 只换正文,标题与动作条不动(异步载入内容时用)。
    setBody(body) {
      const target = bodyHost.querySelector(".set-sheet-body");
      if (target) target.innerHTML = body;
    },
    setActions(actions) {
      currentActions = actions;
      const target = bodyHost.querySelector(".set-sheet-actions");
      if (target) target.innerHTML = actions;
    },
    close() {
      if (dialog.open) dialog.close();
      bodyHost.innerHTML = "";
    }
  };
}

export function mountSettings(deps, onBackendChanged, { onModelsChanged } = {}) {
  const view = document.querySelector("#view-settings");
  const openButton = document.querySelector("#hdr-settings");
  const backButton = view.querySelector("#settings-back");
  const tabBar = view.querySelector("#settings-tabs");
  const dialog = document.querySelector("#settings-sheet");
  const settingsService = createSettingsService(deps.connection);
  const sheet = createSheet(dialog);
  // 已经加载过的 pane 不再重复拉取 —— 切回来时保留上次的内容与草稿。
  // 声明在 panes 之前:服务端 pane 的 onBackendChanged 会读它作废缓存。
  const loaded = new Set();
  const showToast = (message) => deps.showToast?.(message);

  // 桥的状态区块自带轮询,只在设置页可见期间运行。
  const bridge = mountBridgeSettings(view);

  const panes = {
    general: createGeneralPane({
      host: view.querySelector("#set-general-host"), deps, settingsService, showToast
    }),
    models: createModelsPane({
      host: view.querySelector("#settings-pane-models"), sheet, deps, settingsService, showToast,
      // 目录变了要同时刷两处:全局 llm.models 缓存,以及 composer 底栏那颗
      // 模型菜单(它读的是 session.models,不订阅全局目录)。少刷后者的话,
      // 新配的提供方要等切会话/重开侧栏才出现在对话框下面。
      onModelsChanged: () => {
        deps.models.refresh().catch(() => {});
        onModelsChanged?.();
      }
    }),
    presets: createPresetsPane({
      host: view.querySelector("#settings-pane-presets"), sheet, deps, settingsService, showToast
    }),
    plugins: createPluginsPane({
      host: view.querySelector("#settings-pane-plugins"), deps, settingsService, showToast
    }),
    server: createServerPane({
      // 渲染进 pane 内的专属容器,而不是整个 pane —— CDP 桥是同一页里的静态 DOM,
      // 每次 refresh 重写整页会把它绑好的监听器一起冲掉。
      host: view.querySelector("#set-server-host"), deps, showToast,
      // 换了后端就是换了一整台宿主:其余 pane 手里的命名空间、提供方、预设
      // 全部属于旧宿主,必须作废重拉,否则切回去看到的是上一台机器的设置
      // (更糟:在那份陈旧的 revision 上写回)。
      onBackendChanged: () => {
        invalidateHostPanes();
        onBackendChanged?.();
      }
    })
  };

  /// 作废所有依赖宿主的 pane 缓存;当前正显示的那个立刻重拉。
  function invalidateHostPanes() {
    for (const tab of ["general", "models", "presets", "plugins"]) loaded.delete(tab);
    if (activeTab !== "server") {
      loaded.add(activeTab);
      panes[activeTab].refresh();
    }
  }

  let activeTab = readStoredTab();

  function readStoredTab() {
    try {
      const stored = localStorage.getItem(TAB_STORAGE_KEY);
      return TABS.includes(stored) ? stored : "general";
    } catch {
      return "general";
    }
  }

  function storeTab(tab) {
    try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* 隐私模式下写不了,忽略 */ }
  }

  function paintTabs() {
    for (const button of tabBar.querySelectorAll(".settings-tab")) {
      const selected = button.dataset.tab === activeTab;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const tab of TABS) {
      const pane = view.querySelector(`#settings-pane-${tab}`);
      if (pane) pane.hidden = tab !== activeTab;
    }
    // tab 文案跟随语言切换。
    const labels = {
      general: "set.tab.general", models: "set.tab.models", presets: "set.tab.presets",
      plugins: "set.tab.plugins", server: "set.tab.server"
    };
    for (const [tab, key] of Object.entries(labels)) {
      const button = tabBar.querySelector(`[data-tab="${tab}"]`);
      if (button) button.textContent = t(key);
    }
  }

  async function activate(tab, { force = false } = {}) {
    activeTab = TABS.includes(tab) ? tab : "general";
    storeTab(activeTab);
    paintTabs();
    // 桥区块每秒唤醒一次 service worker,服务端页的连接状态点也按秒自刷 ——
    // 两者都只在服务端页可见时才该跑。
    if (activeTab === "server") bridge.refresh();
    else { bridge.stop(); panes.server.stop(); }
    if (force || !loaded.has(activeTab)) {
      loaded.add(activeTab);
      await panes[activeTab].refresh();
    }
  }

  tabBar.addEventListener("click", (event) => {
    const button = event.target.closest(".settings-tab");
    if (button) activate(button.dataset.tab);
  });

  // 左右方向键在 tab 条内移动焦点,这是 tablist 的原生键盘契约。
  tabBar.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(TABS.indexOf(activeTab) + step + TABS.length) % TABS.length];
    activate(next);
    tabBar.querySelector(`[data-tab="${next}"]`)?.focus();
  });

  function open() {
    view.classList.add("open");
    // 每次打开都重拉当前 pane:设置可能被其他客户端(Mac 端、编辑器)改过。
    loaded.clear();
    activate(activeTab, { force: true });
  }

  function close() {
    view.classList.remove("open");
    // 关页面要停掉所有按秒跑的表,否则设置页关了还在每秒唤醒 service worker。
    bridge.stop();
    panes.server.stop();
    sheet.close();
  }

  openButton.addEventListener("click", open);
  backButton.addEventListener("click", close);
  // sheet 的 Esc 由 <dialog> 原生处理,但要把内容清掉,否则下次打开会闪一帧旧内容。
  dialog.addEventListener("close", () => { sheet.root.innerHTML = ""; });
  // 点 sheet 外的遮罩关闭。
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) sheet.close();
  });

  return {
    show: open,
    close,
    /// 语言切换后重画:tab 文案与当前 pane 都要跟着换。
    relabel() {
      paintTabs();
      panes[activeTab]?.refresh();
    }
  };
}
