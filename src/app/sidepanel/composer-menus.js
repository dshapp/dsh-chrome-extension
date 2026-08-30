// composer 底栏的 popover 菜单:模型选择、权限预设、"/" 候选(命令 + 技能)。
import { renderMenuItems } from "./sidepanel-overlays.js";
import { t } from "../../shared/i18n.js";

/// 内置权限预设的本地化名(宿主给的 name 就是 id,不可读)。对齐 Mac 的 displayName。
function permissionLabel(option, value) {
  switch (value) {
    case "read-only": return t("perm.readOnly");
    case "workspace-write": return t("perm.workspaceWrite");
    case "danger-full-access": return t("perm.fullAccess");
    case "custom": return t("perm.custom");
    default: return option?.name || value;
  }
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

export function createComposerMenus({ elements, deps, state, showToast, format }) {
  // ---- 模型菜单(popover) ----
  async function refreshModelMenu() {
    if (!state.sessionId) return;
    try {
      const sessionModels = await deps.sessions.models(state.sessionId);
      state.currentModel = sessionModels.current ?? null;
      // current 只带 id,展示名回 groups 里查(与 composer-dock 同一套规则)。
      elements.modelLabel.textContent = modelDisplayName(sessionModels) || "—";
      const entries = (sessionModels.groups ?? []).flatMap((group) => group.models.map((model) => ({
        id: `${group.id}::${model.id}`,
        label: model.name || model.id,
        // 分组名只用来分组,不再作为 hint 重复渲染进每一行:
        // 行已经排在对应的 provider 标题下面了。
        group: group.name,
        provider: group.id,
        model: model.id
      })));
      state.models = entries;
      const selectedId = sessionModels.current ? `${sessionModels.current.provider}::${sessionModels.current.model}` : null;
      renderMenuItems(elements.modelMenu, entries, {
        selectedId,
        groupBy: (entry) => entry.group,
        onSelect: async (id) => {
          const entry = state.models.find((m) => m.id === id);
          if (!entry || !state.sessionId) return;
          elements.modelMenu.hidePopover();
          try {
            await deps.sessions.selectModel(state.sessionId, entry.provider, entry.model);
            elements.modelLabel.textContent = entry.label;
          } catch (error) {
            showToast(format(error));
          }
        }
      });
    } catch { /* 模型菜单非关键路径 */ }
  }

  // ---- 权限菜单(projection permissions) ----
  function refreshPermMenu(permissions) {
    state.permissions = permissions;
    if (!permissions?.options?.length) {
      elements.permBtn.hidden = true;
      return;
    }
    elements.permBtn.hidden = false;
    elements.permLabel.textContent = permissions.currentValue
      ? permissionLabel(permissions.options.find((o) => o.value === permissions.currentValue), permissions.currentValue)
      : "—";
    // custom 只是"不匹配任何预设"的兜底显示,不作为可选项(对齐 Mac 的 selectableOptions)。
    const selectable = permissions.options.filter((option) => option.value !== "custom");
    // 同 composer-dock:权限行只留单行标题(对齐 Mac 固定行高的权限列表)。
    renderMenuItems(elements.permMenu, selectable.map((option) => ({
      id: option.value, label: permissionLabel(option, option.value)
    })), {
      selectedId: permissions.currentValue,
      onSelect: async (preset) => {
        elements.permMenu.hidePopover();
        if (!state.sessionId) return;
        try {
          // 斜杠命令必须走 commands/execute;当普通 prompt 发宿主不会切换权限。
          await deps.commands.execute(state.sessionId, `/permission ${preset}`);
        } catch (error) {
          showToast(format(error));
        }
      }
    });
  }

  // ---- "/" 候选(命令 + 技能) ----
  // 触发规则同 ChatGPT/dsh web:行首或空白后的 "/",光标前无空白即视为在输入查询词。
  const SLASH_TRIGGER_RE = /(?:^|\s)\/(\S*)$/;

  async function refreshSlashSources() {
    if (!state.sessionId) return;
    try {
      await Promise.all([deps.commands.refresh(state.sessionId), deps.skills.refresh(state.sessionId)]);
    } catch { /* 静默 */ }
  }

  function currentSlashToken() {
    const value = elements.input.value;
    const caret = elements.input.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(SLASH_TRIGGER_RE);
    if (!match) return null;
    return { query: match[1], start: caret - match[1].length - 1, end: caret };
  }

  function insertSlashToken(name, token) {
    const value = elements.input.value;
    const before = value.slice(0, token.start);
    const after = value.slice(token.end);
    elements.input.value = `${before}/${name} ${after}`;
    const caret = before.length + name.length + 2;
    elements.input.focus();
    elements.input.setSelectionRange(caret, caret);
  }

  // 命令组用大小写不敏感的子序列模糊打分(前缀命中最高,词首/`-`/`_`边界次之),
  // 对齐 dsh web 的 fuzzyScore;技能组保持纯前缀过滤,不做模糊匹配。
  function fuzzyScore(name, query) {
    const lowerName = name.toLowerCase();
    const lowerQuery = query.toLowerCase();
    if (lowerName.startsWith(lowerQuery)) return 100;
    let score = 0;
    let cursor = 0;
    for (let i = 0; i < lowerQuery.length; i += 1) {
      const idx = lowerName.indexOf(lowerQuery[i], cursor);
      if (idx === -1) return -1;
      const atBoundary = idx === 0 || "-_".includes(lowerName[idx - 1]);
      score += atBoundary ? 3 : (idx === cursor ? 2 : 1);
      cursor = idx + 1;
    }
    return score;
  }

  function filterCommands(query) {
    if (!query) return [...deps.commands.commands];
    return deps.commands.commands
      .map((command, index) => ({ command, index, score: fuzzyScore(command.name, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => (b.score - a.score) || (a.index - b.index))
      .map((entry) => entry.command);
  }

  // 命令组(order 靠前)+ 技能组(order 靠后),对齐 dsh web 的两段式分组顺序。
  function slashCandidates(query) {
    const commandItems = filterCommands(query).map((command) => ({
      id: `command:${command.name}`, label: `/${command.name}`, hint: command.description,
      section: t("menu.commands"), name: command.name
    }));
    const lowerQuery = query.toLowerCase();
    const skillItems = deps.skills.skills
      .filter((skill) => !lowerQuery || skill.name.toLowerCase().startsWith(lowerQuery))
      .map((skill) => ({
        id: `skill:${skill.name}`, label: `/${skill.name}`, hint: skill.description,
        section: t("skills.title"), name: skill.name
      }));
    return [...commandItems, ...skillItems];
  }

  // 命令和技能选中后都只插入 "/name " 字面文本,不在选中时立即执行:
  // 技能靠宿主在 prompt 内容里识别行首 /name 注入正文,命令则等发送时由
  // tryDispatchCommand() 统一拦截并调用 commands/execute,两者复用同一次“发送”动作。
  function renderSlashList(query) {
    const entries = slashCandidates(query);
    renderMenuItems(elements.skillsMenu, entries, {
      onSelect: (id) => {
        const entry = entries.find((item) => item.id === id);
        if (!entry) return;
        elements.skillsMenu.hidePopover();
        insertSlashToken(entry.name, currentSlashToken() ?? { start: elements.input.value.length, end: elements.input.value.length });
      },
      groupBy: (entry) => entry.section
    });
    return entries.length;
  }

  // composer 输入变化时调用:光标前出现 "/query" 则弹出并按 query 过滤,否则收起。
  function handleSlashInput() {
    const token = currentSlashToken();
    if (!token) {
      elements.skillsMenu.hidePopover();
      return;
    }
    if (renderSlashList(token.query)) elements.skillsMenu.showPopover();
    else elements.skillsMenu.hidePopover();
  }

  // 发送前拦截:整行文本若以已知宿主命令开头(不管是从菜单选中后插入,还是手打),
  // 就不走普通 session.prompt,改调 commands/execute(不开新对话轮)。返回 true 表示
  // 已处理、调用方不应再发送这条消息;返回 false 表示按普通消息继续发送。
  async function tryDispatchCommand(text) {
    const match = text.match(/^\/(\S+)/);
    if (!match || !state.sessionId) return false;
    const known = deps.commands.commands.some((command) => command.name === match[1]);
    if (!known) return false;
    try {
      const execution = await deps.commands.execute(state.sessionId, text);
      if (!execution) showToast(t("command.unknown", { name: match[1] }));
      else if (execution.result?.kind === "error") showToast(execution.result.text || t("command.failed"));
    } catch (error) {
      showToast(format(error));
    }
    return true;
  }

  return { refreshModelMenu, refreshPermMenu, refreshSlashSources, handleSlashInput, tryDispatchCommand };
}
