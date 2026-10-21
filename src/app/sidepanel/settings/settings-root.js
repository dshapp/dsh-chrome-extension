// 设置页根:tab 切换 + 各 pane 的懒加载,以及 pane 共用的模态(sheet)。
// 对齐 macos/.../Settings/SettingsRoot.swift 的 TabView:选中的 tab 记在
// 本地存储里,下次打开设置页回到同一页(Mac 用 @AppStorage("settingsSection"))。
import { t } from "../../../shared/i18n.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";
import { createSettingsService } from "../../../features/settings/settings-service.js";
import { createSettingsNotifications } from "../../../features/settings/settings-notifications.js";
import { createGeneralPane } from "./general-pane.js";
import { createModelsPane } from "./models-pane.js";
import { createPresetsPane } from "./presets-pane.js";
import { createPluginsPane } from "./plugins-pane.js";
import { createBuiltinPluginsPane } from "./builtin-plugins-pane.js";
import { createServerPane } from "./server-pane.js";
import { createHostProxyClient } from "../../../platform/dsh/host-proxy-client.js";
import { createServerOps } from "../../../features/host-proxy/server-ops.js";
import { createShortcutsPane } from "./shortcuts-pane.js";
import { escapeHtml } from "./settings-ui.js";

// 与 Mac SettingsRoot.swift 的差异(刻意保留,不是没做完):
//   - Mac 有 8 个 tab(general/models/presets/plugins/mobile/browser/computerUse/server),
//     这里只做 6 个 —— 不加 Mobile 配对、Browser 设置、Computer Use 三页(用户决定)。
//   - Mac 的"快捷键"是独立的 ShortcutsWindow(⌘/ 打开);侧边栏是单窗口,
//     索性把它做成第 6 个 tab,内容与 Mac 那张表同源(shortcutReference)。
//   - Mac 通用页多一行"在编辑器中打开工作区"(靠 LaunchServices 枚举已装编辑器),
//     浏览器扩展没有等价的系统 API,不提供。
//   - Mac 通知行在权限被拒时给"前往系统设置"深链(macOS 专属),这里只显示一行说明。
//   - Mac 服务端页的 pid/Node/pnpm/全局前缀几行依赖原生 supervisor,这里不提供;
//     相应地也没有"停止并退出" —— 侧边栏不该替用户杀掉 dsh web。
const TABS = ["general", "models", "plugins", "presets", "server", "shortcuts"];

/// 页签图标:与 Mac 的 SettingsSection 一一对应(通用/模型/预设/插件/服务端/快捷键)。
/// 名字取自 file-icons.js 的 lucide 集;缺一个就整体退化成"只有文字",
/// 不会把某个页签画成空方块。
const TAB_ICONS = {
  general: "settings",
  models: "cpu",
  presets: "layers",
  plugins: "puzzle",
  server: "server",
  shortcuts: "keyboard"
};
const TAB_STORAGE_KEY = "dsh_settings_tab";

/// 设置页里共用的模态。Mac 用 .sheet 挂在 Settings 窗口上,这里用一个 <dialog>
/// 复用:同一时刻只会有一个 sheet(编辑提供方时不会再开自定义提供方)。
export function createSheet(dialog) {
  const bodyHost = dialog.querySelector("#settings-sheet-body");
  let currentActions = "";
  // 每次 open 递增。异步回调(保存失败重画、异步载入正文、成功后 close)可能在
  // 用户已经 Esc / 点遮罩关掉、或换开了另一个 sheet 之后才落地;此时这块
  // <dialog> 已经不属于它了。带上 open 时拿到的 token 就能判定所有权,
  // 避免把 A 的表单和报错画进用户正看着的 B,或关掉 B。
  let openGeneration = 0;

  function paint(title, body, actions) {
    bodyHost.innerHTML = `<div class="set-sheet-head">${escapeHtml(title)}</div>`
      + `<div class="set-sheet-body">${body}</div>`
      + `<div class="set-sheet-actions">${actions ?? ""}</div>`;
  }

  return {
    get root() { return bodyHost; },
    /// 当前 sheet 的所有权令牌。异步回调应在 open 时捕获它,
    /// 之后每次写 DOM 前用 owns(token) 校验。
    get generation() { return openGeneration; },
    owns(token) { return token === openGeneration && dialog.open; },
    open({ title, body, actions, bind }) {
      const generation = ++openGeneration;
      currentActions = actions ?? "";
      paint(title, body, currentActions);
      this._title = title;
      if (!dialog.open) dialog.showModal();
      // bind 在 open 返回前就跑,调用方还没拿到 token,所以直接传给它 ——
      // 否则首次 repaint 会用旧 token 自我拒绝。
      bind?.(bodyHost, generation);
      return generation;
    },
    /// 只换正文,标题与动作条不动(异步载入内容时用)。
    /// 传 token 则仅在仍持有 sheet 时生效。
    setBody(body, token) {
      if (token !== undefined && !this.owns(token)) return;
      const target = bodyHost.querySelector(".set-sheet-body");
      if (target) target.innerHTML = body;
    },
    setActions(actions, token) {
      if (token !== undefined && !this.owns(token)) return;
      currentActions = actions;
      const target = bodyHost.querySelector(".set-sheet-actions");
      if (target) target.innerHTML = actions;
    },
    close(token) {
      if (token !== undefined && !this.owns(token)) return;
      // 关闭即让出所有权:在途回调此后一律失配。
      openGeneration += 1;
      if (dialog.open) dialog.close();
      bodyHost.innerHTML = "";
    }
  };
}

/// 第二个参数曾是 onBackendChanged(换后端后重连)。服务端 pane 去掉地址
/// 输入框后就没有任何入口能换后端了,所以它被移除而不是留成一个永不触发的
/// 回调 —— 留着会让调用方以为"改地址仍会重连"。
/// onStartCreatorDraft:预设页"用创造模式创作"落到会话里的动作。它必须由 shell
/// 提供 —— 新建会话、选中预设、离开设置页这三件事都只有 app 能做。
export function mountSettings(deps, { onModelsChanged, onStartCreatorDraft, onVisibilityChanged } = {}) {
  const view = document.querySelector("#view-settings");
  const backButton = view.querySelector("#settings-back");
  const tabBar = view.querySelector("#settings-tabs");
  for (const tab of TABS) {
    const button = tabBar.querySelector(`[data-tab="${tab}"]`);
    if (button) tabBar.append(button);
  }
  const dialog = document.querySelector("#settings-sheet");
  const settingsService = createSettingsService(deps.connection);
  const sheet = createSheet(dialog);
  // 已经加载过的 pane 不再重复拉取 —— 切回来时保留上次的内容与草稿。
  const loaded = new Set();
  const showToast = (message) => deps.showToast?.(message);

  // 宿主代理栈:插件页的装/更/删与服务端页的 dsh 重启/更新都经它执行。
  // Git 不在这里 —— 它的入口在聊天区右上角(对齐 Mac),自带一份客户端。
  // 这些能力走 chrome-daemon 的 /host/*,与 deps.connection(dsh web)是两条
  // 独立链路,daemon 不可用时只降级这几处,不影响设置页其余部分。
  const hostProxy = createHostProxyClient();
  const serverOps = createServerOps({ client: hostProxy });

  const panes = {
    general: createGeneralPane({
      host: view.querySelector("#set-general-host"), deps, settingsService, showToast
    }),
    models: createModelsPane({
      host: view.querySelector("#settings-pane-models"), sheet, deps, settingsService, showToast,
      // 目录变了要同时刷两处:全局 llm.models 缓存,以及 composer 底栏那颗
      // 模型菜单（它读的是 session/modelCatalog，不订阅设置页目录）。少刷后者的话,
      // 新配的提供方要等切会话/重开侧栏才出现在对话框下面。
      onModelsChanged: () => {
        deps.models.refresh().catch(() => {});
        onModelsChanged?.();
      }
    }),
    presets: createPresetsPane({
      host: view.querySelector("#settings-pane-presets"), sheet, deps, settingsService, showToast,
      onStartCreatorDraft
    }),
    // 「内置插件」:宿主插件清单的只读视图,分会话插件 / 全局插件两部分(对齐 DSH web
    // 设置页)。插件的装 / 卸 / 启停在主区域的「插件」管理页。
    plugins: createBuiltinPluginsPane({
      host: view.querySelector("#settings-pane-plugins"), deps, settingsService
    }),
    server: createServerPane({
      // 渲染进 pane 内的专属容器,而不是整个 pane —— CDP 桥是同一页里的静态 DOM,
      // 每次 refresh 重写整页会把它绑好的监听器一起冲掉。
      host: view.querySelector("#set-server-host"), deps, showToast, serverOps
      // 服务端 pane 不再带后端地址输入框(版式以视觉稿为准),所以不再传
      // onBackendChanged —— 那个回调唯一的触发点就是那个输入框的保存按钮。
      //
      // 连带删掉了 invalidateHostPanes():换后端要作废其余 pane 的缓存这条规则
      // 本身没变,但现在没有任何入口能换后端,留着就是一段永不执行的死代码。
      // 若日后把地址编辑加回来,连同那个 helper 一起恢复(git history 里有)。
    }),
    // 快捷键页是命令表的纯视图:不读宿主设置,所以不参与 invalidateHostPanes。
    shortcuts: createShortcutsPane({
      host: view.querySelector("#settings-pane-shortcuts")
    })
  };

  panes.plugins.setVisible?.(false, { refresh: false });
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
    // tab 文案跟随语言切换。图标与文案分开两个节点:只换文字不动 <svg>,
    // 否则每次 relabel 都要重建图标(语言切换与打开设置页都会走到这里)。
    const labels = {
      general: "set.tab.general", models: "set.tab.models", presets: "set.tab.presets",
      plugins: "set.tab.plugins", server: "set.tab.server", shortcuts: "set.tab.shortcuts"
    };
    for (const [tab, key] of Object.entries(labels)) {
      const button = tabBar.querySelector(`[data-tab="${tab}"]`);
      if (!button) continue;
      const label = button.querySelector(".settings-tab-label") ?? button;
      label.textContent = t(key);
      // 首帧建一次图标;之后的 relabel 复用已有节点。
      if (!button.querySelector(".settings-tab-icon")) {
        const icon = document.createElement("span");
        icon.className = "settings-tab-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = lucideIconSvg(TAB_ICONS[tab] ?? "settings", { size: 13 });
        button.prepend(icon);
      }
    }
  }

  const notifications = createSettingsNotifications(deps.connection, {
    onReset: () => settingsService.resetRevisionCache?.(),
    onChange: async () => {
      loaded.clear();
      await panes[activeTab]?.refresh?.({ background: true });
      if (activeTab === "models") onModelsChanged?.();
    }
  });

  async function activate(tab, { force = false } = {}) {
    activeTab = TABS.includes(tab) ? tab : "general";
    storeTab(activeTab);
    paintTabs();
    // 服务端页的连接状态点、以及桥那一行,都按秒自刷 —— 只在这一页可见时才跑。
    // 桥的轮询现在归服务端 pane 管(它自己 render 那一行),所以这里只需要
    // 在离开时停掉整个 pane,不再单独持有一个 bridge 句柄。
    if (activeTab !== "server") panes.server.stop();
    panes.plugins.setVisible?.(activeTab === "plugins" && view.classList.contains("open"));
    if (force || activeTab === "server" || !loaded.has(activeTab)) {
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

  /// tab 可选:快捷键"打开设置"不带,键盘快捷键命令直接落到 shortcuts 页。
  /// 点击入口传进来的是 MouseEvent,不是 TABS 里的串,会自然忽略。
  function open(tab) {
    if (TABS.includes(tab)) activeTab = tab;
    view.classList.add("open");
    onVisibilityChanged?.(true);
    notifications.setVisible(true);
    // 每次打开都重拉当前 pane:设置可能被其他客户端(Mac 端、编辑器)改过。
    loaded.clear();
    activate(activeTab, { force: true });
  }

  function close() {
    const wasOpen = view.classList.contains("open");
    view.classList.remove("open");
    notifications.setVisible(false);
    panes.plugins.setVisible?.(false);
    if (wasOpen) onVisibilityChanged?.(false);
    // 关页面要停掉所有按秒跑的表,否则设置页关了还在每秒唤醒 service worker。
    // panes.server.stop() 一并停掉桥那一行的轮询。
    panes.server.stop();
    sheet.close();
  }

  // 打开入口不在这里绑定:它在会话抽屉底部(#history-settings-btn,由 app 接线)
  // 与快捷键,两者都走返回值里的 show()。
  backButton.addEventListener("click", close);
  // sheet 的 Esc 由 <dialog> 原生处理,但要把内容清掉,否则下次打开会闪一帧旧内容。
  // Esc 关闭也要让出所有权,否则在途回调仍会认为自己持有这块 dialog。
  dialog.addEventListener("close", () => { sheet.close(); });
  // 点 sheet 外的遮罩关闭。
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) sheet.close();
  });

  return {
    show: open,
    close,
    generationOpened: () => notifications.generationOpened(),
    dispose() {
      close(); notifications.dispose();
      for (const pane of Object.values(panes)) { pane.stop?.(); pane.dispose?.(); }
    },
    createPluginManager(host) {
      return createPluginsPane({
        host, sheet, settingsDialog: dialog, deps, settingsService, showToast
      });
    },
    /// 语言切换后重画:tab 文案与当前 pane 都要跟着换。
    relabel() {
      paintTabs();
      if (view.classList.contains("open")) panes[activeTab]?.refresh();
    }
  };
}
