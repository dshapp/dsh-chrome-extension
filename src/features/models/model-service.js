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
  let groups = [];
  let failures = [];
  // 目录的加载状态。Subagent 模型选择要按它决定"加载中 / 加载失败给重试 / 列候选",
  // 只靠 catalog 是否为空分不清"还没拉"和"拉了但一个都没有"。
  let status = "idle";
  let refreshGeneration = 0;
  const listeners = new Set();

  return {
    get catalog() { return catalog; },
    /// 未拍平的 groups([{id, name, models}]):Subagent 模型选择要 provider 的
    /// 显示名,拍平后只剩 groupId/groupName 拼在每一行里,分组还得自己重拼。
    get catalogGroups() { return groups; },
    get catalogFailures() { return failures; },
    get catalogStatus() { return status; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async refresh() {
      const generation = ++refreshGeneration;
      status = "loading";
      try {
        const value = await connection.call(RPC.sessionModels, {});
        if (generation !== refreshGeneration) return catalog;
        groups = value.groups ?? [];
        catalog = flattenModelGroups(groups);
        failures = value.failures ?? [];
        status = "ready";
      } catch (error) {
        if (generation !== refreshGeneration) throw error;
        status = "error";
        throw error;
      }
      for (const listener of listeners) listener(catalog, failures);
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
