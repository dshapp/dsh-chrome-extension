// Agent 预设 pane。对齐 macos/.../Settings/SettingsRoot.swift PresetsSection 的
// 四段结构:模式选择开关 → 操作错误 → 内置 → 自定义(含创造模式按钮)。
//
// 行尾动作按 Mac 的顺序与条件:查看(仅非坏预设)→ 复制(坏预设或不可创作时禁用)
// → 打开目录 / 删除(仅 trust === "user")。行本体即"设为默认",模式选择关闭时
// 不再可点(Mac cardSelectionDisabled:宿主会忽略这个默认值,与其写进去被静默
// 丢弃,不如不给点)。
import { t } from "../../../shared/i18n.js";
import { section, row, iconButton, notice, spinner, escapeHtml, tag, button, selectorEscape } from "./settings-ui.js";
import { presetDisplayName } from "../composer-dock.js";
import { openPresetCopySheet } from "./preset-copy-sheet.js";

/// 创造模式的预设 id。Mac 与 web 都用这一个自指的出厂预设当"让 Agent 帮我写"的入口。
const CREATOR_PRESET_ID = "cordis";

export function createPresetsPane({ host, sheet, deps, settingsService, showToast, onStartCreatorDraft }) {
  let presets = [];
  let defaultId = null;
  let writable = false;
  // 模式选择策略开关(agent-presets.modeSelectionEnabled)。关掉时默认值会被宿主
  // 忽略,所以"设为默认"与创造模式按钮都要跟着收起来。roster 缺席时按开启处理。
  let pickerEnabled = true;
  let authorable = false;
  let canOpenDirectory = false;
  let loading = true;
  let loadError = null;
  let operationError = null;
  let savingPicker = false;
  let busyPresetId = null;
  // 打开目录失败时宿主回传的路径:显示出来并提供"复制路径"(Mac 的 revealedPaths)。
  const revealedPaths = new Map();
  let loadGeneration = 0;

  function presetLabel(preset) {
    return presetDisplayName(preset) || preset.id;
  }

  function renderPresetRow(preset) {
    const isDefault = preset.id === defaultId || preset.isDefault === true;
    const isBroken = Boolean(preset.broken);
    const name = presetLabel(preset);
    const label = `<span class="${isDefault ? "set-strong" : ""}">${escapeHtml(name)}</span>`
      + (isDefault ? tag(t("pset.inUse"), "accent") : "");
    const hint = isBroken
      ? `<span class="set-warn">${escapeHtml(preset.broken || t("pset.brokenFallback"))}</span>`
      : escapeHtml(preset.description ?? "");
    const revealed = revealedPaths.get(preset.id);
    return row({
      label,
      hint: hint + `<div class="set-mono">${escapeHtml(preset.id)}</div>`
        + (revealed
          ? `<div class="set-path-row"><span class="set-mono">${escapeHtml(revealed)}</span>`
            + `<button class="set-link" type="button" data-copy-path="${escapeHtml(preset.id)}">`
            + `${escapeHtml(t("pset.copyPath"))}</button></div>`
          : ""),
      control: renderActions(preset, isBroken),
      id: `pset-row-${preset.id}`
    });
  }

  /// 行尾动作。忙碌中的那个动作换成转圈,避免连点两次发出两个写请求。
  function renderActions(preset, isBroken) {
    const busy = busyPresetId === preset.id;
    const parts = [];
    if (!isBroken) {
      parts.push(busy
        ? `<span class="set-icon-spin" title="${escapeHtml(t("pset.view"))}"></span>`
        : iconButton({ id: `pset-view-${preset.id}`, icon: "search", title: t("pset.view") }));
    }
    parts.push(iconButton({
      id: `pset-copy-${preset.id}`,
      icon: "copy",
      title: t("pset.duplicate"),
      disabled: isBroken || !authorable || busy
    }));
    if (preset.trust === "user") {
      if (canOpenDirectory) {
        parts.push(busy
          ? `<span class="set-icon-spin" title="${escapeHtml(t("pset.openFolder"))}"></span>`
          : iconButton({ id: `pset-folder-${preset.id}`, icon: "folder", title: t("pset.openFolder") }));
      }
      parts.push(iconButton({
        id: `pset-del-${preset.id}`, icon: "trash-2", title: t("pset.delete"),
        kind: "danger", disabled: busy
      }));
    }
    return parts.join("");
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
  /// 结束在对话里,不在这一页)。三个禁用条件与 Mac creatorButton 一致。
  function renderCreatorButton() {
    const hasCreator = presets.some((preset) => preset.id === CREATOR_PRESET_ID);
    const disabled = !pickerEnabled || !authorable || !hasCreator;
    const reason = !pickerEnabled
      ? t("pset.pickerEnableToSetDefault")
      : (!authorable ? t("pset.noWritableDirectory") : "");
    return button({
      id: "pset-create-draft",
      label: `+ ${t("pset.draftWithCreator")}`,
      kind: "plain",
      disabled,
      title: reason
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
      // 行本体点击 = 设为默认(Mac 的 onTapGesture)。坏掉的预设无从选择,
      // 模式选择关闭时也不该可点(写了会被宿主丢掉)。
      const rowElement = host.querySelector(`#pset-row-${selectorEscape(preset.id)}`);
      if (rowElement && !preset.broken && preset.id !== defaultId && pickerEnabled) {
        rowElement.classList.add("clickable");
        rowElement.setAttribute("role", "button");
        rowElement.setAttribute("aria-label", t("pset.setAsDefaultNamed", {
          name: presetLabel(preset)
        }));
        rowElement.addEventListener("click", (event) => {
          if (event.target.closest(".set-icon-btn, .set-link")) return;
          makeDefault(preset);
        });
      }
      host.querySelector(`#pset-view-${selectorEscape(preset.id)}`)?.addEventListener("click", (event) => {
        event.stopPropagation();
        viewPreset(preset);
      });
      host.querySelector(`#pset-copy-${selectorEscape(preset.id)}`)?.addEventListener("click", (event) => {
        event.stopPropagation();
        copyPreset(preset);
      });
      host.querySelector(`#pset-folder-${selectorEscape(preset.id)}`)?.addEventListener("click", (event) => {
        event.stopPropagation();
        openFolder(preset);
      });
      host.querySelector(`#pset-del-${selectorEscape(preset.id)}`)?.addEventListener("click", (event) => {
        event.stopPropagation();
        confirmDelete(preset);
      });
      host.querySelector(`[data-copy-path="${selectorEscape(preset.id)}"]`)?.addEventListener("click", (event) => {
        event.stopPropagation();
        copyPath(revealedPaths.get(preset.id));
      });
    }
  }

  async function setPickerEnabled(enabled) {
    if (savingPicker) return;
    savingPicker = true;
    operationError = null;
    render();
    try {
      const describe = await settingsService.describe();
      const namespace = (describe?.namespaces ?? []).find((entry) => entry.ns === "agent-presets");
      await settingsService.mutate(
        "agent-presets",
        [{ op: "set", path: ["modeSelectionEnabled"], value: enabled }],
        namespace?.revision
      );
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
    busyPresetId = preset.id;
    render();
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
      operationError = deps.formatErrorDetails(error);
      showToast?.(operationError);
      render();
    } finally {
      busyPresetId = null;
    }
  }

  /// 只读查看预设的 agent.cordis.yml。
  async function viewPreset(preset) {
    const name = presetLabel(preset);
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

  /// 复制:弹标识符 + 名称的表单,成功后重载 roster。
  function copyPreset(preset) {
    openPresetCopySheet({
      sheet, from: preset.id, fromName: presetLabel(preset), presets,
      settingsService, deps, showToast,
      onDone: refresh
    });
  }

  /// 打开预设目录。宿主在"打不开本体编辑器"时回 {opened:false, path} ——
  /// 那时把路径显示出来并提供复制,而不是静默什么都没发生(Mac 的 revealedPaths)。
  async function openFolder(preset) {
    busyPresetId = preset.id;
    render();
    try {
      const value = await settingsService.presetOpenDocument(preset.id);
      if (value?.opened === false && value.path) {
        revealedPaths.set(preset.id, value.path);
        operationError = t("pset.openFolderFailed");
      }
    } catch (error) {
      operationError = deps.formatErrorDetails(error);
      showToast?.(operationError);
    } finally {
      busyPresetId = null;
      render();
    }
  }

  function copyPath(path) {
    if (!path) return;
    // navigator.clipboard 在侧栏里可用;写失败不该静默 —— 用户会以为复制成功。
    const pending = navigator.clipboard?.writeText(path);
    pending?.then?.(
      () => showToast?.(t("pset.pathCopied")),
      () => showToast?.(path)
    ) ?? showToast?.(path);
  }

  /// 删除确认(Mac 的 confirmationDialog)。确认后重载 roster。
  function confirmDelete(preset) {
    const name = presetLabel(preset);
    const token = sheet.open({
      title: t("pset.delete"),
      body: `<p class="set-sheet-text">${escapeHtml(t("pset.deleteMessage"))}</p>`
        + `<div class="set-sheet-error" id="pset-del-error"></div>`,
      actions: button({ id: "pset-del-cancel", label: t("set.cancel") })
        + button({ id: "pset-del-confirm", label: t("pset.deleteNamed", { name }), kind: "danger" }),
      bind(root) {
        root.querySelector("#pset-del-cancel").addEventListener("click", () => sheet.close(token));
        const confirm = root.querySelector("#pset-del-confirm");
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          confirm.textContent = t("pset.deleting");
          try {
            await settingsService.presetRemove(preset.id);
            if (!sheet.owns(token)) return;
            sheet.close(token);
            await refresh();
          } catch (error) {
            if (!sheet.owns(token)) return;
            root.querySelector("#pset-del-error").textContent = deps.formatErrorDetails(error);
            confirm.disabled = false;
            confirm.textContent = t("pset.deleteNamed", { name });
          }
        });
      }
    });
  }

  /// 创造模式草稿:把 cordis 预设装进下一次新建会话,然后请 shell 开一个新会话
  /// 并离开设置页。按钮已按三个条件禁用,这里再兜一次(状态可能在点击之间变化)。
  async function startCreatorDraft() {
    if (!pickerEnabled || !authorable) return;
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
      const [list, describe, canOpen] = await Promise.all([
        settingsService.presetList(),
        settingsService.describe().catch(() => null),
        settingsService.canOpenPresetDirectory()
          .then((value) => value === true)
          .catch(() => false)
      ]);
      if (generation !== loadGeneration) return;
      presets = list?.presets ?? [];
      writable = describe?.writable === true;
      authorable = list?.authorable === true;
      pickerEnabled = list?.modeSelectionEnabled !== false;
      canOpenDirectory = canOpen;
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
