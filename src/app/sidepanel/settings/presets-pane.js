// Agent 预设 pane。对齐 macos/.../Settings/SettingsRoot.swift PresetsSection 的
// 四段结构:模式选择开关 → 操作错误 → 内置 → 自定义(含创造模式按钮)。
//
// 0.1.7 起预设改在配置文件里声明:宿主删掉了 read/copy/deletePreset 与打开预设
// 目录的端点,所以行尾的查看/复制/打开目录/删除动作随之移除(与 Mac 同步)。
// 行本体仍是"设为默认",默认值写 agent-preset-registry.selectedDefault(老宿主
// agent-presets.default);模式选择关闭时不再可点(宿主会忽略这个默认值)。
// 内置/自定义按 isBuiltInPreset 分:出厂 id 且没有自带 name 才算内置。
// 0.1.7 起内置行多"模式说明 / 如何使用"两个入口(web AgentPresetSection 的
// cardHelp;Mac 是一个 info 按钮),打开只读的 PresetGuide 弹窗。
import { t } from "../../../shared/i18n.js";
import { section, row, notice, spinner, escapeHtml, tag, button, selectorEscape } from "./settings-ui.js";
import { presetDisplayName, presetDescription, isBuiltInPreset } from "../composer-dock.js";
import { presetRegistryNamespace } from "./general-pane.js";
import { presetGuide, openPresetGuide } from "./preset-guide-sheet.js";

/// 创造模式的预设 id。Mac 与 web 都用这一个自指的出厂预设当"让 Agent 帮我写"的入口。
const CREATOR_PRESET_ID = "cordis";

export function createPresetsPane({ host, sheet, deps, settingsService, showToast, onStartCreatorDraft }) {
  let presets = [];
  let defaultId = null;
  let writable = false;
  // 模式选择策略开关(modeSelectionEnabled)。关掉时默认值会被宿主忽略,
  // 所以"设为默认"与创造模式按钮都要跟着收起来。roster 缺席时按开启处理。
  let pickerEnabled = true;
  let loading = true;
  let loadError = null;
  let operationError = null;
  let savingPicker = false;
  let busyPresetId = null;
  let loadGeneration = 0;

  function presetLabel(preset) {
    return presetDisplayName(preset) || preset.id;
  }

  function renderPresetRow(preset) {
    const isDefault = preset.id === defaultId;
    const isBroken = Boolean(preset.broken);
    const name = presetLabel(preset);
    const label = `<span class="${isDefault ? "set-strong" : ""}">${escapeHtml(name)}</span>`
      + (isDefault ? tag(t("pset.inUse"), "accent") : "");
    const hint = isBroken
      ? `<span class="set-warn">${escapeHtml(typeof preset.broken === "string" ? preset.broken : t("pset.brokenFallback"))}</span>`
      : escapeHtml(presetDescription(preset) ?? "");
    const busy = busyPresetId === preset.id;
    const guide = sheet ? presetGuide(preset) : undefined;
    const help = guide
      ? `<div class="pset-guide-links">`
        + [["explanation", "pset.modeExplanation"], ["usage", "pset.howToUse"]].map(([page, key]) => (
          `<button class="set-link" type="button" data-guide-open="${page}"`
          + ` aria-label="${escapeHtml(`${t(key)}: ${name}`)}">${escapeHtml(t(key))}</button>`
        )).join("")
        + `</div>`
      : "";
    return row({
      label,
      hint: hint + `<div class="set-mono">${escapeHtml(preset.id)}</div>`,
      extra: help,
      control: busy ? `<span class="set-icon-spin"></span>` : "",
      id: `pset-row-${preset.id}`
    });
  }

  /// 模式选择开关(Mac 的 Toggle 那一节,含 Beta 胶囊与说明)。
  function renderPickerSection() {
    const body = row({
      label: escapeHtml(t("pset.pickerTitle")) + tag(t("pset.pickerBeta"), "accent"),
      hint: escapeHtml(t("pset.pickerHint")),
      control: `<label class="set-switch"><input id="pset-picker" type="checkbox"`
        + `${pickerEnabled ? " checked" : ""}${savingPicker || !writable ? " disabled" : ""}`
        + ` aria-label="${escapeHtml(t("pset.pickerTitle"))}" />`
        + `<span class="set-switch-track" aria-hidden="true"></span></label>`
    });
    return section({ body });
  }

  function renderErrorSection() {
    if (!operationError) return "";
    return section({
      body: notice(operationError)
        + `<div class="set-form-footer"><span class="set-spacer"></span>`
        + button({ id: "pset-retry", label: t("set.retry"), kind: "primary" })
        + `</div>`
    });
  }

  /// 创造模式按钮:暂存 cordis 预设 → 新建会话 → 离开设置(web D43:这个手势
  /// 结束在对话里,不在这一页)。
  function renderCreatorButton() {
    const hasCreator = presets.some((preset) => preset.id === CREATOR_PRESET_ID);
    const disabled = !pickerEnabled || !hasCreator;
    return button({
      id: "pset-create-draft",
      label: `+ ${t("pset.draftWithCreator")}`,
      kind: "plain",
      disabled,
      title: !pickerEnabled ? t("pset.pickerEnableToSetDefault") : ""
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
    const builtIn = presets.filter((preset) => isBuiltInPreset(preset));
    const custom = presets.filter((preset) => !isBuiltInPreset(preset));
    host.innerHTML = renderPickerSection()
      + renderErrorSection()
      + section({
        header: t("pset.builtIn"),
        body: builtIn.map(renderPresetRow).join("")
      })
      + section({
        header: t("pset.custom"),
        body: (custom.length
          ? custom.map(renderPresetRow).join("")
          : `<div class="set-empty">${escapeHtml(t("pset.noCustom"))}</div>`)
          + `<div class="set-row stacked"><div class="set-row-control wide">${renderCreatorButton()}</div></div>`,
        footer: escapeHtml(t("pset.footer"))
          + (writable ? "" : `<br />${escapeHtml(t("set.readOnlyDocument"))}`)
      });
    bind();
  }

  function bind() {
    host.querySelector("#pset-retry")?.addEventListener("click", () => refresh());
    host.querySelector("#pset-picker")?.addEventListener("change", (event) => {
      setPickerEnabled(event.target.checked);
    });
    host.querySelector("#pset-create-draft")?.addEventListener("click", () => startCreatorDraft());
    for (const preset of presets) {
      const rowElement = host.querySelector(`#pset-row-${selectorEscape(preset.id)}`);
      // 说明入口:只读,不能冒泡成行点击(那会顺手把它设为默认)。
      for (const link of rowElement?.querySelectorAll("[data-guide-open]") ?? []) {
        link.addEventListener("click", (event) => {
          event.stopPropagation();
          const guide = presetGuide(preset);
          if (guide) openPresetGuide({ sheet, title: presetLabel(preset), guide, page: link.dataset.guideOpen });
        });
      }
      // 行本体点击 = 设为默认(Mac 的 onTapGesture)。坏掉的预设无从选择,
      // 模式选择关闭时也不该可点(写了会被宿主丢掉)。
      if (rowElement && !preset.broken && preset.id !== defaultId && pickerEnabled && writable) {
        rowElement.classList.add("clickable");
        rowElement.setAttribute("role", "button");
        rowElement.setAttribute("aria-label", t("pset.setAsDefaultNamed", {
          name: presetLabel(preset)
        }));
        rowElement.addEventListener("click", () => makeDefault(preset));
      }
    }
  }

  async function writeRegistry(field, value) {
    const describe = await settingsService.describe();
    const names = new Set((describe?.namespaces ?? []).map((entry) => entry.ns));
    const ns = presetRegistryNamespace(names);
    if (!ns) throw new Error("agent preset registry settings unavailable");
    const namespace = (describe?.namespaces ?? []).find((entry) => entry.ns === ns.name);
    await settingsService.mutate(
      ns.name,
      [{ op: "set", path: [field === "default" ? ns.defaultField : field], value }],
      namespace?.revision
    );
  }

  async function setPickerEnabled(enabled) {
    if (savingPicker) return;
    savingPicker = true;
    operationError = null;
    render();
    try {
      await writeRegistry("modeSelectionEnabled", enabled);
      await refresh();
    } catch (error) {
      operationError = deps.formatErrorDetails(error);
      showToast?.(operationError);
    } finally {
      savingPicker = false;
      render();
    }
  }

  async function makeDefault(preset) {
    if (busyPresetId) return;
    busyPresetId = preset.id;
    render();
    try {
      await writeRegistry("default", preset.id);
      await refresh();
    } catch (error) {
      operationError = deps.formatErrorDetails(error);
      showToast?.(operationError);
      render();
    } finally {
      busyPresetId = null;
    }
  }

  /// 创造模式草稿:把 cordis 预设装进下一次新建会话,然后请 shell 开一个新会话
  /// 并离开设置页。按钮已按条件禁用,这里再兜一次(状态可能在点击之间变化)。
  async function startCreatorDraft() {
    if (!pickerEnabled) return;
    if (!presets.some((preset) => preset.id === CREATOR_PRESET_ID)) return;
    if (!onStartCreatorDraft) {
      operationError = deps.formatErrorDetails(new Error("creator draft unsupported"));
      render();
      return;
    }
    try {
      await onStartCreatorDraft(CREATOR_PRESET_ID);
    } catch (error) {
      operationError = deps.formatErrorDetails(error);
      showToast?.(operationError);
      render();
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
      presets = [...(list?.presets ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      writable = describe?.writable === true;
      pickerEnabled = list?.modeSelectionEnabled !== false;
      // roster 的 isDefault 就是宿主解析后的默认(已考虑 selectedDefault 与回退);
      // 设置值只在 roster 没标出默认时兜底。
      const names = new Set((describe?.namespaces ?? []).map((entry) => entry.ns));
      const ns = presetRegistryNamespace(names);
      const namespace = ns ? (describe?.namespaces ?? []).find((entry) => entry.ns === ns.name) : null;
      const configured = namespace?.value?.[ns?.defaultField];
      defaultId = presets.find((preset) => preset.isDefault)?.id
        ?? (typeof configured === "string" ? configured : null);
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
