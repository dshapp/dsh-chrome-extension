// Agent 预设 pane:默认选择、内置指南与只读声明 YAML。
// alpha.2 不再读取/写入已退休的模式选择策略;不恢复旧 copy/delete。
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
  let loading = true;
  let loadError = null;
  let operationError = null;
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
      control: (sheet ? `<button class="set-link" type="button" data-preset-yaml>${escapeHtml(t("pset.viewYaml"))}</button>` : "")
        + (busy ? `<span class="set-icon-spin"></span>` : ""),
      id: `pset-row-${preset.id}`
    });
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
    const disabled = !hasCreator;
    return button({
      id: "pset-create-draft",
      label: `+ ${t("pset.draftWithCreator")}`,
      kind: "plain",
      disabled
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
    host.innerHTML = renderErrorSection()
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
    host.querySelector("#pset-create-draft")?.addEventListener("click", () => startCreatorDraft());
    for (const preset of presets) {
      const rowElement = host.querySelector(`#pset-row-${selectorEscape(preset.id)}`);
      rowElement?.querySelector("[data-preset-yaml]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        void viewYaml(preset);
      });
      // 说明入口:只读,不能冒泡成行点击(那会顺手把它设为默认)。
      for (const link of rowElement?.querySelectorAll("[data-guide-open]") ?? []) {
        link.addEventListener("click", (event) => {
          event.stopPropagation();
          const guide = presetGuide(preset);
          if (guide) openPresetGuide({ sheet, title: presetLabel(preset), guide, page: link.dataset.guideOpen });
        });
      }
      // 行本体点击 = 设为默认(Mac 的 onTapGesture)。坏掉的预设无从选择,
      if (rowElement && !preset.broken && preset.id !== defaultId && writable) {
        rowElement.classList.add("clickable");
        rowElement.setAttribute("role", "button");
        rowElement.setAttribute("aria-label", t("pset.setAsDefaultNamed", {
          name: presetLabel(preset)
        }));
        rowElement.addEventListener("click", () => makeDefault(preset));
      }
    }
  }

  async function viewYaml(preset) {
    const token = sheet.open({
      title: presetLabel(preset) + " — " + t("pset.yamlTitle"),
      body: spinner(),
      actions: button({ id: "pset-yaml-close", label: t("set.cancel") }),
      bind: (root, generation) => {
        root.querySelector("#pset-yaml-close")?.addEventListener("click", () => sheet.close(generation));
      }
    });
    try {
      const document = await settingsService.presetRead(preset.id);
      if (!sheet.owns(token)) return;
      sheet.setBody('<pre class="set-mono" style="white-space:pre-wrap;overflow-wrap:anywhere"><code>'
        + escapeHtml(document?.content ?? "") + "</code></pre>", token);
    } catch (error) {
      if (sheet.owns(token)) sheet.setBody(notice(t("pset.yamlLoadFailed") + ": " + deps.formatErrorDetails(error)), token);
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

  async function makeDefault(preset) {
    if (busyPresetId || !writable || preset.broken) return;
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
