// 模型目录:session/modelCatalog 全量；当前选择由 session/control 投影提供。
// 选择写回走 session/selectModel(provider, model, reasoningEffort?)。
import { RPC } from "../../platform/dsh/rpc-methods.js";
export function flattenModelGroups(groups) {
  const models = [];
  for (const group of groups ?? []) {
    for (const model of group.models ?? []) {
      models.push({ groupId: group.id, groupName: group.name, ...model });
    }
  }
  return models;
}

export function findModel(models, provider, modelId) {
  return models.find((entry) => entry.groupId === provider && entry.id === modelId);
}

export function createModelService(connection) {
  let catalog = [];
  let refreshGeneration = 0;
  const listeners = new Set();

  return {
    get catalog() { return catalog; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async refresh() {
      const generation = ++refreshGeneration;
      const value = await connection.call(RPC.sessionModels, {});
      if (generation !== refreshGeneration) return catalog;
      catalog = flattenModelGroups(value.groups);
      for (const listener of listeners) listener(catalog, value.failures);
      return catalog;
    },
    // 当前会话模型状态:{current, routable, groups, failures}
    async sessionModels(sessionId) {
      const value = await connection.call(RPC.sessionModels, {});
      return { ...value, current: null };
    },
    async select(sessionId, provider, model, reasoningEffort) {
      return connection.call(RPC.sessionSelectModel, { request: {
        sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {})
      } });
    }
  };
}

// 渲染 <select> 选项:provider 分组 optgroup。
export function buildModelSelectOptions(models, selectedProvider, selectedModel) {
  const byGroup = new Map();
  for (const model of models) {
    if (!byGroup.has(model.groupId)) byGroup.set(model.groupId, []);
    byGroup.get(model.groupId).push(model);
  }
  let html = "";
  for (const [groupId, groupModels] of byGroup) {
    html += `<optgroup label="${escapeAttr(groupId)}">`;
    for (const model of groupModels) {
      const selected = groupId === selectedProvider && model.id === selectedModel ? " selected" : "";
      html += `<option value="${escapeAttr(groupId)}::${escapeAttr(model.id)}"${selected}>${escapeAttr(model.name || model.id)}</option>`;
    }
    html += "</optgroup>";
  }
  return html;
}

export function parseModelSelectValue(value) {
  const separator = value.indexOf("::");
  if (separator === -1) return null;
  return { provider: value.slice(0, separator), model: value.slice(separator + 2) };
}

function escapeAttr(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
