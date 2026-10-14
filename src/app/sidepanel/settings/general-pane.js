// 通用 pane。行序照搬 macos/.../Settings/SettingsRoot.swift GeneralSection:
// Agent 预设 → 权限 → 语言 → 外观 → 通知 → Enter 行为 → 配置文件。
//
// Mac 的「打开 Workspace 使用」一行不在此处:那一行靠 LaunchServices 枚举本机
// 已安装应用并读取其图标,扩展在浏览器沙箱里既枚举不到应用也拿不到图标 ——
// 画一个只有假选项的下拉只会误导,所以整行不渲染(已与使用者确认)。
import { t, getLang } from "../../../shared/i18n.js";
import { section, row, select, toggle, button, notice, escapeHtml, themeCubes } from "./settings-ui.js";
import { presetMenuLabel } from "../composer-dock.js";
import { confirmFullAccess, isFullAccessOption } from "../permission-confirm.js";

/// 权限预设的内建选项。宿主 0.1.6 的可选列表来自进程级 permissionPresets/catalog,
/// 由会话运行时按进程缓存并投影到 snapshot.permissions.options;没有会话(或旧版
/// 只在投影里带 options)时回落到这份静态表,让这一行始终画得出来。
const PERMISSION_OPTIONS = [
  { value: "read-only" },
  { value: "workspace-write" },
  { value: "danger-full-access" }
];

const ENTER_BEHAVIORS = [
  { value: "queue", labelKey: "set.enterBehavior.queue" },
  { value: "steer", labelKey: "set.enterBehavior.steer" }
];

/// 权限值 → 本地化名。内置 id 用本地文案(宿主给的 name 就是 id 本身,直接显示
/// 不可读),认不出的自定义预设才用宿主 name。与 composer 底栏同一口径。
function permissionLabel(option, value) {
  switch (value) {
    case "read-only": return t("perm.readOnly");
    case "workspace-write": return t("perm.workspaceWrite");
    case "danger-full-access": return t("perm.fullAccess");
    case "custom": return t("perm.custom");
    default: return option?.name || value;
  }
}

/// 读一个命名空间的某个字段;命名空间缺席返回 undefined,让调用方决定是否隐藏该行。
function namespaceField(namespaces, ns, field) {
  const namespace = namespaces.get(ns);
  if (!namespace) return undefined;
  const value = namespace.value;
  return value && typeof value === "object" ? value[field] : undefined;
}

/// 预设默认值所在的设置命名空间。0.1.7 把 agent-presets.default 改名为
/// agent-preset-registry.selectedDefault;老宿主仍是前者。
export function presetRegistryNamespace(namespaces) {
  if (namespaces?.has?.("agent-preset-registry")) return { name: "agent-preset-registry", defaultField: "selectedDefault" };
  if (namespaces?.has?.("agent-presets")) return { name: "agent-presets", defaultField: "default" };
  return null;
}

export function createGeneralPane({ host, deps, settingsService, showToast }) {
  let snapshot = { namespaces: new Map(), writable: false, hasDocument: false };
  let presets = [];
  let busy = false;
  let documentError = null;
  let loadGeneration = 0;

  /// 写一个 ui-* 命名空间的单个字段,并就地刷新。宿主是权威:写完重新 describe,
  /// 而不是乐观改本地 —— 只读部署会静默拒绝,乐观 UI 会显示一个假的成功。
  async function writeField(ns, field, value) {
    if (busy || !snapshot.writable) return;
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
    const ns = presetRegistryNamespace(snapshot.namespaces);
    if (!ns) return "";
    const current = namespaceField(snapshot.namespaces, ns.name, ns.defaultField)
      ?? presets.find((preset) => preset.isDefault)?.id;
    const options = presets.map((preset) => ({
      value: preset.id,
      label: presetMenuLabel(preset) || preset.id,
      selected: preset.id === current
    }));
    if (!options.length) options.push({ value: "", label: t("set.selectPreset"), selected: true });
    const disabled = !presets.length || !snapshot.writable;
    return row({
      label: escapeHtml(t("set.agentPreset")),
      hint: escapeHtml(t("set.agentPresetHint")),
      control: select({ id: "set-agent-preset", options, disabled })
    });
  }

  /// 可选权限:优先用会话运行时那份(它合并了进程级目录,顺序与药丸菜单一致),
  /// 没有会话时回落到静态三条。
  function permissionOptions() {
    const live = deps.sessions?.getRuntimeSnapshot?.()?.permissions?.options;
    const options = Array.isArray(live) && live.length ? live : PERMISSION_OPTIONS;
    return options.filter((option) => option?.value !== "custom");
  }

  function renderPermissionRow() {
    if (!snapshot.namespaces.has("permission")) return "";
    const current = namespaceField(snapshot.namespaces, "permission", "defaultPreset");
    return row({
      label: escapeHtml(t("set.permission")),
      hint: escapeHtml(t("set.permissionHint")),
      control: select({
        id: "set-permission",
        options: permissionOptions().map((option) => ({
          value: option.value,
          label: permissionLabel(option, option.value),
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

  /// 外观:Mac 用三块 ThemeCube 色板而不是下拉。选中项写 ui-theme.preference,
  /// 并就地应用到侧栏 —— 宿主是权威,但界面不该等一次往返才变色。
  function renderAppearanceRow() {
    if (!snapshot.namespaces.has("ui-theme")) return "";
    const current = namespaceField(snapshot.namespaces, "ui-theme", "preference") ?? "system";
    return row({
      label: escapeHtml(t("set.appearance")),
      control: themeCubes({ id: "set-theme", value: current, disabled: !snapshot.writable })
    });
  }

  function renderNotificationsRow(notificationsEnabled) {
    return row({
      label: escapeHtml(t("settings.notifications")),
      hint: escapeHtml(t("set.notificationsHint")),
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
  /// Mac 的 OpenConfigFileButton 失败时就地显示一行错误,不只弹 toast。
  function renderConfigFileSection() {
    if (!snapshot.hasDocument) return "";
    return section({
      body: row({
        label: escapeHtml(t("set.configFile")),
        extra: documentError ? notice(documentError) : "",
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
      const ns = presetRegistryNamespace(snapshot.namespaces);
      if (ns) writeField(ns.name, ns.defaultField, event.target.value);
    });
    host.querySelector("#set-permission")?.addEventListener("change", async (event) => {
      const value = event.target.value;
      // full-access 授予的是"不再询问"的权力,和 composer 走同一道确认。
      // 取消就把宿主值读回来画(不写、也不留一个假的选中态)。
      if (isFullAccessOption(value) && !(await confirmFullAccess(deps.permConfirm))) {
        await refresh();
        return;
      }
      await writeField("permission", "defaultPreset", value);
    });
    for (const cube of host.querySelectorAll("[data-theme-cube]")) {
      cube.addEventListener("click", async () => {
        const value = cube.dataset.themeCube;
        // 先落到本地:主题是立刻可见的东西,等宿主往返会闪一下。宿主写成功后
        // refresh() 会用权威值再纠一次;写失败也照样纠回来。
        deps.theme?.setPreference?.(value);
        deps.settings?.setThemePreference?.(value).catch(() => {});
        await writeField("ui-theme", "preference", value);
      });
    }
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
      documentError = null;
      try {
        await settingsService.openDocument();
      } catch {
        documentError = t("set.openDocumentError");
        showToast?.(documentError);
      } finally {
        target.disabled = false;
        if (documentError) await render(await deps.settings.getNotificationsEnabled());
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
      // 宿主是主题的权威:每次刷新都把它的偏好灌回本地镜像与界面,
      // 别的客户端(Mac 端、编辑器)改过之后这里也能收敛。
      const hostTheme = namespaceField(snapshot.namespaces, "ui-theme", "preference");
      if (hostTheme) {
        deps.theme?.setPreference?.(hostTheme);
        deps.settings?.setThemePreference?.(hostTheme).catch(() => {});
      }
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
