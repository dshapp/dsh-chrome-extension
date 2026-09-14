// 通用 pane。行序照搬 macos/.../Settings/SettingsRoot.swift GeneralSection:
// Agent 预设 → 权限 → 语言 → 外观 → 通知 → Enter 行为 → 配置文件。
//
// Mac 的「打开 Workspace 使用」一行不在此处:那一行靠 LaunchServices 枚举本机
// 已安装应用并读取其图标,扩展在浏览器沙箱里既枚举不到应用也拿不到图标 ——
// 画一个只有假选项的下拉只会误导,所以整行不渲染(已与使用者确认)。
import { t, getLang } from "../../../shared/i18n.js";
import { section, row, select, toggle, button, notice, escapeHtml } from "./settings-ui.js";
import { presetMenuLabel } from "../composer-dock.js";

/// 权限预设的内建选项,与 composer 的「访问模式」一致。宿主 schema 也报同一
/// 组联合值,但静态列表让这一行在没有会话时也能渲染。
const PERMISSION_OPTIONS = [
  { value: "read-only", labelKey: "access.readOnly" },
  { value: "workspace-write", labelKey: "access.workspaceWrite" },
  { value: "danger-full-access", labelKey: "access.full" }
];

const ENTER_BEHAVIORS = [
  { value: "queue", labelKey: "set.enterBehavior.queue" },
  { value: "steer", labelKey: "set.enterBehavior.steer" }
];

const THEME_PREFERENCES = [
  { value: "system", labelKey: "set.appearance.system" },
  { value: "light", labelKey: "set.appearance.light" },
  { value: "dark", labelKey: "set.appearance.dark" }
];

/// 读一个命名空间的某个字段;命名空间缺席返回 undefined,让调用方决定是否隐藏该行。
function namespaceField(namespaces, ns, field) {
  const namespace = namespaces.get(ns);
  if (!namespace) return undefined;
  const value = namespace.value;
  return value && typeof value === "object" ? value[field] : undefined;
}

export function createGeneralPane({ host, deps, settingsService, showToast }) {
  let snapshot = { namespaces: new Map(), writable: false, hasDocument: false };
  let presets = [];
  let busy = false;
  let loadGeneration = 0;

  /// 写一个 ui-* 命名空间的单个字段,并就地刷新。宿主是权威:写完重新 describe,
  /// 而不是乐观改本地 —— 只读部署会静默拒绝,乐观 UI 会显示一个假的成功。
  async function writeField(ns, field, value) {
    if (busy) return;
    busy = true;
    try {
      const namespace = snapshot.namespaces.get(ns);
      await settingsService.mutate(
        ns,
        [{ op: "set", path: [field], value }],
        namespace?.revision
      );
      await refresh();
    } catch (error) {
      showToast?.(deps.formatErrorDetails(error));
    } finally {
      busy = false;
    }
  }

  function renderAgentPresetRow() {
    // 命名空间缺席就没有"默认预设"这个概念可写,整行隐藏。
    if (!snapshot.namespaces.has("agent-presets")) return "";
    const current = namespaceField(snapshot.namespaces, "agent-presets", "default");
    const options = presets.map((preset) => ({
      value: preset.id,
      label: presetMenuLabel(preset) || preset.id,
      selected: preset.id === current
    }));
    if (!options.length) options.push({ value: "", label: t("set.selectPreset"), selected: true });
    return row({
      label: escapeHtml(t("set.agentPreset")),
      hint: escapeHtml(t("set.agentPresetHint")),
      control: select({ id: "set-agent-preset", options, disabled: !presets.length || !snapshot.writable })
    });
  }

  function renderPermissionRow() {
    if (!snapshot.namespaces.has("permission")) return "";
    const current = namespaceField(snapshot.namespaces, "permission", "defaultPreset");
    return row({
      label: escapeHtml(t("set.permission")),
      hint: escapeHtml(t("set.permissionHint")),
      control: select({
        id: "set-permission",
        options: PERMISSION_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
          selected: option.value === current
        })),
        disabled: !snapshot.writable
      })
    });
  }

  /// 语言:宿主 locale 命名空间是权威,同时要同步侧栏本地的 t() 语言 ——
  /// 侧栏的文案不等宿主往返就该跟着切。
  function renderLanguageRow() {
    const hostValue = namespaceField(snapshot.namespaces, "locale", "preference");
    const current = hostValue ?? getLang();
    return row({
      label: escapeHtml(t("set.language")),
      control: select({
        id: "set-lang",
        options: [
          { value: "zh", label: "中文", selected: current === "zh" },
          { value: "en", label: "English", selected: current === "en" }
        ]
      })
    });
  }

  function renderAppearanceRow() {
    if (!snapshot.namespaces.has("ui-theme")) return "";
    const current = namespaceField(snapshot.namespaces, "ui-theme", "preference") ?? "system";
    return row({
      label: escapeHtml(t("set.appearance")),
      control: select({
        id: "set-theme",
        options: THEME_PREFERENCES.map((preference) => ({
          value: preference.value,
          label: t(preference.labelKey),
          selected: preference.value === current
        })),
        disabled: !snapshot.writable
      })
    });
  }

  function renderNotificationsRow(notificationsEnabled) {
    return row({
      label: escapeHtml(t("settings.notifications")),
      control: toggle({
        id: "set-notifications",
        checked: notificationsEnabled,
        ariaLabel: t("settings.notifications")
      })
    });
  }

  function renderEnterBehaviorRow() {
    if (!snapshot.namespaces.has("ui-conversation")) return "";
    const current = namespaceField(snapshot.namespaces, "ui-conversation", "busyEnter") ?? "queue";
    return row({
      label: escapeHtml(t("set.enterBehavior")),
      hint: escapeHtml(t("set.enterBehaviorHint")),
      control: select({
        id: "set-enter-behavior",
        options: ENTER_BEHAVIORS.map((behavior) => ({
          value: behavior.value,
          label: t(behavior.labelKey),
          selected: behavior.value === current
        })),
        disabled: !snapshot.writable
      })
    });
  }

  /// 配置文件:只有宿主报告 hasDocument 才给按钮 —— 没有文档时按钮点了必然失败。
  function renderConfigFileSection() {
    if (!snapshot.hasDocument) return "";
    return section({
      body: row({
        label: escapeHtml(t("set.configFile")),
        control: button({ id: "set-open-document", label: t("set.openDocument") })
      })
    });
  }

  async function render(notificationsEnabled) {
    const rows = [
      renderAgentPresetRow(),
      renderPermissionRow(),
      renderLanguageRow(),
      renderAppearanceRow(),
      renderNotificationsRow(notificationsEnabled),
      renderEnterBehaviorRow()
    ].join("");
    host.innerHTML = section({
      body: rows,
      footer: snapshot.writable ? "" : escapeHtml(t("set.readOnlyDocument"))
    }) + renderConfigFileSection();
    bind();
  }

  function bind() {
    host.querySelector("#set-agent-preset")?.addEventListener("change", (event) => {
      writeField("agent-presets", "default", event.target.value);
    });
    host.querySelector("#set-permission")?.addEventListener("change", (event) => {
      writeField("permission", "defaultPreset", event.target.value);
    });
    host.querySelector("#set-theme")?.addEventListener("change", (event) => {
      writeField("ui-theme", "preference", event.target.value);
    });
    host.querySelector("#set-enter-behavior")?.addEventListener("change", (event) => {
      // 先同步给 composer,让插队快捷键的语义立刻跟上;宿主写入仍是权威,
      // 失败时下一次 describe 会把值纠回来。
      deps.onBusyEnterChange?.(event.target.value);
      writeField("ui-conversation", "busyEnter", event.target.value);
    });
    host.querySelector("#set-lang")?.addEventListener("change", async (event) => {
      const lang = event.target.value;
      // 先切本地语言让界面立刻响应,再把偏好写回宿主(命名空间缺席时只切本地)。
      deps.setLang(lang);
      // 让整个界面(静态标签、底栏、其他 pane)都跟着切,而不是只刷新当前 pane。
      deps.onLanguageChange?.();
      if (snapshot.namespaces.has("locale")) await writeField("locale", "preference", lang);
      else await refresh();
    });
    host.querySelector("#set-notifications")?.addEventListener("change", (event) => {
      deps.settings.setNotificationsEnabled(event.target.checked);
    });
    host.querySelector("#set-open-document")?.addEventListener("click", async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        await settingsService.openDocument();
      } catch {
        showToast?.(t("set.openDocumentError"));
      } finally {
        target.disabled = false;
      }
    });
  }

  async function refresh() {
    const generation = ++loadGeneration;
    const notificationsEnabled = await deps.settings.getNotificationsEnabled();
    if (generation !== loadGeneration) return;
    try {
      const [describe, presetList] = await Promise.all([
        settingsService.describe(),
        settingsService.presetList().catch(() => null)
      ]);
      if (generation !== loadGeneration) return;
      snapshot = {
        namespaces: new Map((describe?.namespaces ?? []).map((namespace) => [namespace.ns, namespace])),
        writable: describe?.writable === true,
        hasDocument: describe?.hasDocument === true
      };
      presets = presetList?.presets ?? [];
    } catch (error) {
      if (generation !== loadGeneration) return;
      // 宿主读不到时仍要让扩展本地项(通知/语言)可用,所以只把宿主段落降级为提示。
      snapshot = { namespaces: new Map(), writable: false, hasDocument: false };
      presets = [];
      host.innerHTML = notice(deps.formatErrorDetails(error));
      return;
    }
    if (generation !== loadGeneration) return;
    await render(notificationsEnabled);
  }

  return { refresh };
}
