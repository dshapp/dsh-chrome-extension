// composer 底栏控件:plan chip、权限模式(含 full-access 二次确认)、模型 + 推理档。
// 对齐 macos/.../Components/Composer/ComposerDock.swift 的同名座位。
import { t } from "../../shared/i18n.js";
import { renderMenuItems } from "./sidepanel-overlays.js";
import { RPC } from "../../platform/dsh/rpc-methods.js";
import { renderModelMenu, modelMenuEntries } from "./model-menu.js";
import { orderModelProviders } from "../../features/models/model-ranking.js";
// full-access 的识别与确认框都在这里:设置页的"默认权限"行也要走同一道确认,
// 两个入口必须问同一个问题、给同一个对话框。
import { confirmFullAccess as askFullAccess, isFullAccessOption } from "./permission-confirm.js";

export { isFullAccessOption };

/// 出厂预设 id。0.1.7 把 code 改名为 ptc;历史会话里可能还记着 code,一并认。
const SHIPPED_PRESETS = new Set(["standard", "ptc", "code", "minimal", "cordis"]);

/// 是否出厂预设(对齐宿主 isBuiltInPreset):出厂 id 且没有自带 name。
/// 声明里给自己起了名字的预设,文案归它自己,不翻译。
/// 0.1.6 及以前 roster 还带 trust 字段,那时以 trust === "system" 为准。
export function isBuiltInPreset(preset) {
  if (!preset) return false;
  if (preset.trust !== undefined) return preset.trust === "system" && SHIPPED_PRESETS.has(preset.id);
  return (preset.name === undefined || preset.name === null) && SHIPPED_PRESETS.has(preset.id);
}

function shippedKey(id) {
  return id === "code" ? "ptc" : id;
}

/// 预设的展示名(对齐 Mac agentPresetDisplayText / 宿主 presetDisplayText)。
/// 出厂预设用本地化文案;用户自建预设保留其自有 name,不翻译:那是用户写的字。
export function presetDisplayName(preset) {
  if (!preset) return null;
  if (isBuiltInPreset(preset)) return t(`preset.${shippedKey(preset.id)}`);
  return preset.name || preset.id || null;
}

/// 预设说明:出厂预设用本地化说明,其余用声明里的 description。
export function presetDescription(preset) {
  if (!preset) return null;
  if (isBuiltInPreset(preset)) return t(`preset.${shippedKey(preset.id)}Description`);
  return preset.description ?? null;
}

/// 选择菜单里的标签:用户自建预设追加 "· 自定义" 标记 —— 它和它所引用的插件
/// 一样是用户自己的东西,不能读起来像出厂已审过的。
export function presetMenuLabel(preset) {
  const name = presetDisplayName(preset);
  if (!name) return "";
  return isBuiltInPreset(preset) ? name : `${name} · ${t("preset.custom")}`;
}

export function createComposerDock({ elements, deps, state, showToast, format }) {
  // ---- plan chip ----
  // 读 projections.plan 折算出的目标态。开启时显示药丸,点击执行 /plan off,
  // 并在投影确认退出前保持可见但禁用(乐观切换会让 chip 闪烁)。
  let planLeaving = false;
  let modelLoadGeneration = 0;
  let modelSelectionGeneration = 0;
  let presetLoadGeneration = 0;

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
    const label = chip.querySelector(".plan-chip-label");
    if (label) label.textContent = t("composer.planChip");
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

  /// full-access 二次确认对话框(实现见 permission-confirm.js)。返回用户是否确认。
  function confirmFullAccess() {
    return askFullAccess(elements.permConfirm);
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
    const sessionId = state.sessionId;
    if (!sessionId) return;
    const generation = ++modelLoadGeneration;
    try {
      const sessionModels = deps.sessions.models
        ? await deps.sessions.models(sessionId)
        : await deps.connection.call(RPC.sessionModels, {});
      // 等待期间切走了会话:迟到的响应不得更新当前(别的)会话的模型菜单。
      if (generation !== modelLoadGeneration || state.sessionId !== sessionId) return;
      state.currentModel = sessionModels.current ?? null;
      // current 只带 {provider, model} 两个 id,展示名要回 groups 里查;
      // 查不到(目录里没有这个模型)才退回 id,总比空着强。
      elements.modelLabel.textContent = modelDisplayName(sessionModels) || "—";

      // 供应商顺序对齐 web 0.2 orderModelProviders:account → official → 其余目录顺序。
      const groups = orderModelProviders(sessionModels.groups ?? []);
      const entries = modelMenuEntries(groups);

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

      // 目录超过 4 个模型时顶部出搜索框(web ModelSelect showSearch),组内按名称排名、空组隐藏。
      renderModelMenu(elements.modelMenu, {
        groups,
        extraEntries: effortEntries,
        selectedId,
        onSelect: async (id) => {
          const entry = all.find((m) => m.id === id);
          if (!entry || !state.sessionId) return;
          const targetSessionId = state.sessionId;
          const selectionGeneration = entry.effort
            ? modelSelectionGeneration
            : ++modelSelectionGeneration;
          elements.modelMenu.hidePopover();
          try {
            if (entry.effort) {
              const current = state.currentModel;
              if (!current) return;
              await deps.connection.call(RPC.sessionSelectModel, { request: {
                sessionId: targetSessionId,
                provider: current.provider,
                model: current.model,
                reasoningEffort: entry.effort
              } });
            } else {
              // 先更新目标模型。用户可能不等网络回包就继续点推理档；若仍保留旧
              // currentModel，第二个请求会把推理档错误地应用到旧模型。
              state.currentModel = { provider: entry.provider, model: entry.model };
              await deps.connection.call(RPC.sessionSelectModel, { request: {
                sessionId: targetSessionId, provider: entry.provider, model: entry.model
              } });
              if (state.sessionId !== targetSessionId
                || selectionGeneration !== modelSelectionGeneration) return;
              // 同步当前模型:推理档选择依赖 state.currentModel 来定位要修的模型,
              // 不更新的话,切模型后立即选推理档会作用到上一份快照里的旧模型。
              elements.modelLabel.textContent = entry.label;
            }
          } catch (error) {
            // 当前这次模型选择失败时，以宿主目录重新收敛本地乐观状态；若后面
            // 已有更新的选择，则由更新选择负责，不能让旧失败把它冲回去。
            if (!entry.effort && state.sessionId === targetSessionId
              && selectionGeneration === modelSelectionGeneration) {
              void refreshModelMenu();
            }
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
    const generation = ++presetLoadGeneration;
    try {
      const value = await deps.sessions.listAgentPresets();
      if (generation !== presetLoadGeneration) return;
      const presets = value?.presets ?? [];
      presetRoster = presets;
      if (!presets.length) { elements.presetBtn.hidden = true; return; }
      const snapshot = deps.sessions.getRuntimeSnapshot();
      const summary = deps.sessions.listStore.get().find((s) => s.sessionId === state.sessionId);
      // 用 let:选中后要就地同步,否则再点回上一个预设会被 id === currentId 守卫
      // 当成“已是当前”而静默忽略 —— 那个 currentId 还是渲染时刻的旧值。
      let currentId = snapshot.agentPreset ?? summary?.agentPreset
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
          const targetSessionId = state.sessionId;
          try {
            const applied = await deps.sessions.selectAgentPreset(targetSessionId, id);
            if (state.sessionId !== targetSessionId) return;
            const chosen = presets.find((p) => p.id === applied);
            elements.presetLabel.textContent = presetDisplayName(chosen) || applied;
            currentId = applied;
          } catch (error) {
            showToast(format(error));
          }
        }
      });
    } catch { /* 预设菜单非关键路径 */ }
  }

  return {
    renderPlanChip, renderPermMenu, refreshModelMenu, refreshPresetMenu,
    confirmFullAccess, currentPresetName,
    // 快捷键"退出 Plan 模式"复用同一个动作(药丸点击也走它)。
    exitPlanMode
  };
}
