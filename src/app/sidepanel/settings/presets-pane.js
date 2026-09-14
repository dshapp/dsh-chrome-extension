// Agent 预设 pane。照搬 macos/.../Settings/SettingsRoot.swift PresetsSection 的
// 分组与行结构:内置 / 自定义两段,行本体即"设为默认",行尾是查看动作。
//
// 与 Mac 的差异(已与使用者确认):不提供自定义预设的创作能力 ——
// 复制(agentPreset.copy)、删除(agentPreset.remove)、「用创造模式创作」
// 以及打开预设目录都不做。所以自定义段落是只读列表,只能查看与设为默认。
import { t } from "../../../shared/i18n.js";
import { section, row, iconButton, notice, spinner, escapeHtml, tag, button } from "./settings-ui.js";
import { presetDisplayName } from "../composer-dock.js";

export function createPresetsPane({ host, sheet, deps, settingsService, showToast }) {
  let presets = [];
  let defaultId = null;
  let writable = false;
  let loading = true;
  let loadError = null;
  let loadGeneration = 0;

  function renderPresetRow(preset) {
    const isDefault = preset.id === defaultId || preset.isDefault === true;
    const isBroken = Boolean(preset.broken);
    const name = presetDisplayName(preset) || preset.id;
    const label = `<span class="${isDefault ? "set-strong" : ""}">${escapeHtml(name)}</span>`
      + (isDefault ? tag(t("pset.inUse"), "accent") : "");
    const hint = isBroken
      ? `<span class="set-warn">${escapeHtml(preset.broken || t("pset.brokenFallback"))}</span>`
      : escapeHtml(preset.description ?? "");
    return row({
      label,
      hint: hint + `<div class="set-mono">${escapeHtml(preset.id)}</div>`,
      control: isBroken ? "" : iconButton({
        id: `pset-view-${preset.id}`, icon: "search", title: t("pset.view")
      }),
      id: `pset-row-${preset.id}`
    });
  }

  function render() {
    if (loading) { host.innerHTML = spinner(); return; }
    if (loadError) {
      host.innerHTML = section({ body: notice(loadError) + `<div class="set-form-footer">`
        + `<span class="set-spacer"></span>`
        + button({ id: "pset-retry", label: t("set.retry"), kind: "primary" }) + `</div>` });
      host.querySelector("#pset-retry")?.addEventListener("click", () => refresh());
      return;
    }
    const builtIn = presets.filter((preset) => preset.trust === "system");
    const custom = presets.filter((preset) => preset.trust === "user");
    host.innerHTML = section({
      header: t("pset.builtIn"),
      body: builtIn.map(renderPresetRow).join("")
    })
    + section({
      header: t("pset.custom"),
      body: custom.length
        ? custom.map(renderPresetRow).join("")
        : `<div class="set-empty">${escapeHtml(t("pset.noCustom"))}</div>`,
      footer: escapeHtml(t("pset.footer"))
        + (writable ? "" : `<br />${escapeHtml(t("set.readOnlyDocument"))}`)
    });
    bind();
  }

  function bind() {
    for (const preset of presets) {
      // 行本体点击 = 设为默认(Mac 的 onTapGesture),坏掉的预设无从选择。
      const rowElement = host.querySelector(`#pset-row-${CSS.escape(preset.id)}`);
      if (rowElement && !preset.broken && preset.id !== defaultId) {
        rowElement.classList.add("clickable");
        rowElement.setAttribute("role", "button");
        rowElement.setAttribute("aria-label", t("pset.setAsDefaultNamed", {
          name: presetDisplayName(preset) || preset.id
        }));
        rowElement.addEventListener("click", (event) => {
          if (event.target.closest(".set-icon-btn")) return;
          makeDefault(preset);
        });
      }
      host.querySelector(`#pset-view-${CSS.escape(preset.id)}`)?.addEventListener("click", (event) => {
        event.stopPropagation();
        viewPreset(preset);
      });
    }
  }

  async function makeDefault(preset) {
    try {
      const describe = await settingsService.describe();
      const namespace = (describe?.namespaces ?? []).find((entry) => entry.ns === "agent-presets");
      await settingsService.mutate(
        "agent-presets",
        [{ op: "set", path: ["default"], value: preset.id }],
        namespace?.revision
      );
      await refresh();
    } catch (error) {
      showToast?.(deps.formatErrorDetails(error));
    }
  }

  /// 只读查看预设的 agent.cordis.yml。
  async function viewPreset(preset) {
    const name = presetDisplayName(preset) || preset.id;
    // 捕获所有权令牌:读取期间用户可能关掉这个查看器再打开另一个预设,
    // 迟到的内容不能画进那个标题写着别的预设名的 sheet 里。
    const token = sheet.open({
      title: t("pset.viewerTitle", { name }),
      body: spinner(),
      actions: button({ id: "pset-close", label: t("set.done"), kind: "primary" }),
      bind(root) {
        root.querySelector("#pset-close").addEventListener("click", () => sheet.close(token));
      }
    });
    try {
      const value = await settingsService.presetRead(preset.id);
      sheet.setBody(`<pre class="set-code">${escapeHtml(value?.content ?? "")}</pre>`, token);
    } catch (error) {
      sheet.setBody(notice(deps.formatErrorDetails(error)), token);
    }
  }

  async function refresh() {
    const generation = ++loadGeneration;
    loading = true; loadError = null; render();
    try {
      const [list, describe] = await Promise.all([
        settingsService.presetList(),
        settingsService.describe().catch(() => null)
      ]);
      if (generation !== loadGeneration) return;
      presets = list?.presets ?? [];
      writable = describe?.writable === true;
      const namespace = (describe?.namespaces ?? []).find((entry) => entry.ns === "agent-presets");
      const configured = namespace?.value?.default;
      defaultId = typeof configured === "string"
        ? configured
        : presets.find((preset) => preset.isDefault)?.id ?? null;
      loadError = null;
    } catch (error) {
      if (generation !== loadGeneration) return;
      loadError = deps.formatErrorDetails(error);
    } finally {
      if (generation !== loadGeneration) return;
      loading = false;
      render();
    }
  }

  return { refresh };
}
