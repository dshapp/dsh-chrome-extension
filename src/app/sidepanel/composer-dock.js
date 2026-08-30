// composer 底栏控件:plan chip、权限模式(含 full-access 二次确认)、模型 + 推理档。
// 对齐 macos/.../Components/Composer/ComposerDock.swift 的同名座位。
import { t } from "../../shared/i18n.js";
import { renderMenuItems } from "./sidepanel-overlays.js";
import { RPC } from "../../platform/dsh/rpc-methods.js";

/// 需要二次确认的权限值。宿主用不同命名发过同样的语义,所以按子串识别。
const FULL_ACCESS_PATTERN = /(full[-_ ]?access|danger|bypass|yolo)/i;

export function isFullAccessOption(value) {
  return FULL_ACCESS_PATTERN.test(String(value ?? ""));
}

/// 预设的展示名(对齐 Mac agentPresetDisplayText)。
///
/// 出厂预设(trust === "system")的已知 id 用本地化文案 —— 宿主发来的是英文
/// 内部名(如 code),中文界面要显示"PTC 模式"。用户自建预设保留其自有 name,
/// 不翻译:那是用户写的字。
const SHIPPED_PRESETS = new Set(["standard", "code", "minimal", "cordis"]);

export function presetDisplayName(preset) {
  if (!preset) return null;
  if (preset.trust === "system" && SHIPPED_PRESETS.has(preset.id)) {
    return t(`preset.${preset.id}`);
  }
  return preset.name || preset.id || null;
}

/// 选择菜单里的标签:用户自建预设追加 "· 自定义" 标记 —— 它和它所引用的插件
/// 一样是用户自己的东西,不能读起来像出厂已审过的。
export function presetMenuLabel(preset) {
  const name = presetDisplayName(preset);
  if (!name) return "";
  return preset?.trust === "user" ? `${name} · ${t("preset.custom")}` : name;
}

export function createComposerDock({ elements, deps, state, showToast, format }) {
  // ---- plan chip ----
  // 读 projections.plan 折算出的目标态。开启时显示药丸,点击执行 /plan off,
  // 并在投影确认退出前保持可见但禁用(乐观切换会让 chip 闪烁)。
  let planLeaving = false;

  function renderPlanChip(planMode) {
    const chip = elements.planChip;
    if (!chip) return;
    const active = planMode === true;
    chip.hidden = !active;
    if (!active) {
      planLeaving = false;
      return;
    }
    // 占位符由 sidepanel-app 的 applyComposerAvailability 统一裁决,这里不写,
    // 否则两处会互相覆盖(子代理只读提示会被计划模式文案盖掉)。
    chip.disabled = planLeaving;
    chip.title = t("composer.planChipOff");
    chip.setAttribute("aria-label", t("composer.planChipOff"));
  }

  async function exitPlanMode() {
    if (!state.sessionId || planLeaving) return;
    planLeaving = true;
    renderPlanChip(true);
    try {
      // 必须走斜杠命令通道。当普通 prompt 发出去只是一条聊天消息,宿主不会切换计划模式,
      // 药丸会一直亮着而用户以为点了没反应(已在真实后端验证)。
      await deps.commands.execute(state.sessionId, "/plan off");
    } catch (error) {
      planLeaving = false;
      showToast(t("composer.planExitFailed"));
      showToast(format(error));
    }
    // 不在这里清 planLeaving:等 plan 投影确认退出后由 renderPlanChip(false) 收尾。
  }

  elements.planChip?.addEventListener("click", exitPlanMode);

  // ---- 权限模式 ----
  function renderPermMenu(permissions) {
    state.permissions = permissions;
    if (!permissions?.options?.length) {
      elements.permBtn.hidden = true;
      return;
    }
    elements.permBtn.hidden = false;
    // 药丸与菜单行读同一套标签(对齐 Mac 的 displayName)。
    elements.permLabel.textContent = permissions.currentValue
      ? permissionLabel(permissions.options.find((o) => o.value === permissions.currentValue), permissions.currentValue)
      : "—";
    // 完全访问是唯一会警告的模式:此时不再询问,后续危险操作全部静默放行,
    // 药丸文字染成警告色以示当前处于该状态(对齐 Mac PermissionChip 的
    // warnLabel —— 只染文字,不加图标、不改边框)。
    elements.permLabel.classList.toggle("warn", isFullAccessOption(permissions.currentValue));
    // custom 不是可选项:它只是"当前设置不匹配任何预设"的兜底显示,
    // 选它没有意义(对齐 Mac 的 selectableOptions)。
    const selectable = permissions.options.filter((option) => option.value !== "custom");
    // 不带描述:宿主给的说明是整段英文散文,挤进侧栏会换行成四五行,
    // 把行高撑到 90px+。Mac 的权限行同样只有单行标题(rowHeight 固定 30pt)。
    renderMenuItems(elements.permMenu, selectable.map((option) => ({
      id: option.value, label: permissionLabel(option, option.value)
    })), {
      selectedId: permissions.currentValue,
      onSelect: async (value) => {
        elements.permMenu.hidePopover();
        if (!state.sessionId) return;
        // full-access 一类的模式要先过二次确认:这一步授予的是"不再询问"的权力,
        // 误点的代价是后续所有危险操作都静默放行。
        if (isFullAccessOption(value) && !(await confirmFullAccess())) return;
        try {
          // 同上:权限切换是斜杠命令,不是聊天消息。
          const execution = await deps.commands.execute(state.sessionId, `/permission ${value}`);
          if (execution?.result?.kind === "error") showToast(execution.result.text || t("command.failed"));
        } catch (error) {
          showToast(format(error));
        }
      }
    });
  }

  /// 内置预设的本地化名。宿主给的 name 就是 id 本身(如 "workspace-write"),
  /// 直接显示不可读;认不出的自定义预设才回退到宿主 name。对齐 Mac 的 displayName。
  function permissionLabel(option, value) {
    switch (value) {
      case "read-only": return t("perm.readOnly");
      case "workspace-write": return t("perm.workspaceWrite");
      case "danger-full-access": return t("perm.fullAccess");
      case "custom": return t("perm.custom");
      default: return option?.name || value;
    }
  }

  /// full-access 二次确认对话框。返回用户是否确认。
  function confirmFullAccess() {
    const dialog = elements.permConfirm;
    if (!dialog) return Promise.resolve(true);
    const acknowledge = dialog.querySelector("#perm-confirm-ack");
    const enable = dialog.querySelector("#perm-confirm-enable");
    const cancel = dialog.querySelector("#perm-confirm-cancel");
    acknowledge.checked = false;
    enable.disabled = true;

    return new Promise((resolve) => {
      const onAck = () => { enable.disabled = !acknowledge.checked; };
      const finish = (value) => {
        acknowledge.removeEventListener("change", onAck);
        enable.removeEventListener("click", onEnable);
        cancel.removeEventListener("click", onCancel);
        dialog.removeEventListener("close", onCancel);
        dialog.close();
        resolve(value);
      };
      const onEnable = () => finish(true);
      const onCancel = () => finish(false);
      acknowledge.addEventListener("change", onAck);
      enable.addEventListener("click", onEnable);
      cancel.addEventListener("click", onCancel);
      dialog.addEventListener("close", onCancel);
      dialog.showModal();
    });
  }

  /// 当前模型的展示名:groups[].models[] 里按 id 命中就用 name,否则退回 model id。
  function modelDisplayName(sessionModels) {
    const current = sessionModels?.current;
    if (!current) return null;
    for (const group of sessionModels.groups ?? []) {
      if (group.id !== current.provider) continue;
      for (const model of group.models ?? []) {
        if (model.id === current.model) return model.name || model.id;
      }
    }
    return current.model;
  }

  // ---- 模型 + 推理档 ----
  async function refreshModelMenu() {
    if (!state.sessionId) return;
    try {
      const sessionModels = await deps.connection.call(RPC.sessionModels, { sessionId: state.sessionId });
      state.currentModel = sessionModels.current ?? null;
      // current 只带 {provider, model} 两个 id,展示名要回 groups 里查;
      // 查不到(目录里没有这个模型)才退回 id,总比空着强。
      elements.modelLabel.textContent = modelDisplayName(sessionModels) || "—";

      const entries = (sessionModels.groups ?? []).flatMap((group) => group.models.map((model) => ({
        id: `${group.id}::${model.id}`,
        label: model.name || model.id,
        // 不再给 hint:分组标题已经写着 provider 名,行内再挂一份 <small> 是重复信息。
        section: group.name,
        provider: group.id,
        model: model.id
      })));

      // 推理档作为独立分组附在模型之后,选中后只改 reasoningEffort、不动模型。
      const efforts = sessionModels.reasoningEfforts ?? sessionModels.current?.reasoningEfforts ?? [];
      const effortEntries = efforts.map((effort) => {
        const id = typeof effort === "string" ? effort : effort.id;
        const label = typeof effort === "string" ? effort : (effort.name || effort.id);
        return { id: `effort::${id}`, label, section: t("model.reasoning"), effort: id };
      });

      state.models = entries;
      const all = [...entries, ...effortEntries];
      const selectedId = sessionModels.current
        ? `${sessionModels.current.provider}::${sessionModels.current.model}`
        : null;

      renderMenuItems(elements.modelMenu, all, {
        selectedId,
        groupBy: (entry) => entry.section,
        onSelect: async (id) => {
          const entry = all.find((m) => m.id === id);
          if (!entry || !state.sessionId) return;
          elements.modelMenu.hidePopover();
          try {
            if (entry.effort) {
              const current = state.currentModel;
              if (!current) return;
              await deps.connection.call(RPC.sessionSelectModel, {
                sessionId: state.sessionId,
                provider: current.provider,
                model: current.model,
                reasoningEffort: entry.effort
              });
            } else {
              await deps.connection.call(RPC.sessionSelectModel, {
                sessionId: state.sessionId, provider: entry.provider, model: entry.model
              });
              elements.modelLabel.textContent = entry.label;
            }
          } catch (error) {
            showToast(format(error));
          }
        }
      });
    } catch { /* 模型菜单非关键路径 */ }
  }

  // ---- Agent 预设 ----
  // 预设决定这个会话有哪些工具与能力。切换会重建 agent,所以只在会话空闲时可用。
  //
  // roster 缓存在这里:统计行要显示当前模式名,而 id→展示名的映射需要 roster
  // 里的 trust 字段。缓存住就不必为那一行再拉一次列表。
  let presetRoster = [];

  /// 当前会话的预设展示名(已本地化),roster 未就绪时返回 null。
  function currentPresetName() {
    if (!presetRoster.length) return null;
    const snapshot = deps.sessions.getRuntimeSnapshot();
    const summary = deps.sessions.listStore.get().find((s) => s.sessionId === state.sessionId);
    const id = snapshot.agentPreset ?? summary?.agentPreset
      ?? presetRoster.find((p) => p.isDefault)?.id ?? null;
    return presetDisplayName(presetRoster.find((p) => p.id === id)) || id || null;
  }

  async function refreshPresetMenu() {
    if (!state.sessionId) return;
    try {
      const value = await deps.sessions.listAgentPresets();
      const presets = value?.presets ?? [];
      presetRoster = presets;
      if (!presets.length) { elements.presetBtn.hidden = true; return; }
      const snapshot = deps.sessions.getRuntimeSnapshot();
      const summary = deps.sessions.listStore.get().find((s) => s.sessionId === state.sessionId);
      const currentId = snapshot.agentPreset ?? summary?.agentPreset
        ?? presets.find((p) => p.isDefault)?.id ?? null;
      const currentPreset = presets.find((p) => p.id === currentId);
      elements.presetBtn.hidden = false;
      elements.presetLabel.textContent = presetDisplayName(currentPreset) || currentId || "—";
      renderMenuItems(elements.presetMenu, presets.map((p) => ({
        id: p.id, label: presetMenuLabel(p), hint: p.description
      })), {
        selectedId: currentId,
        onSelect: async (id) => {
          elements.presetMenu.hidePopover();
          if (!state.sessionId || id === currentId) return;
          try {
            const applied = await deps.sessions.selectAgentPreset(state.sessionId, id);
            const chosen = presets.find((p) => p.id === applied);
            elements.presetLabel.textContent = presetDisplayName(chosen) || applied;
          } catch (error) {
            showToast(format(error));
          }
        }
      });
    } catch { /* 预设菜单非关键路径 */ }
  }

  return {
    renderPlanChip, renderPermMenu, refreshModelMenu, refreshPresetMenu,
    confirmFullAccess, currentPresetName
  };
}
