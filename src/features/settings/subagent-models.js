// Subagent 模型选择的候选合并(纯逻辑,便于单测)。
//
// 对齐 Mac SubagentPluginCard 的 candidates:把**活的模型目录**与**已存的
// allowedModels 路由**做外连接 —— 目录里还在的用目录的名字并标 available,
// 目录里已经消失(提供方被删、模型下架)的仍然列出来并标 unavailable。
// 少了这一半,用户就没法在看到"这个模型没了"之后把它删掉,而已存的
// allowedModels 在下次保存时会把它原样写回去。

/// 一个路由的稳定 key。provider/model 里理论上不该有点号歧义,但目录与
/// 已存路由两侧必须用同一套编码,所以收在一处。
export function routeKey(provider, model) {
  return `${provider ?? ""}::${model ?? ""}`;
}

export function splitRouteKey(key) {
  const separator = String(key ?? "").indexOf("::");
  if (separator === -1) return null;
  return { provider: key.slice(0, separator), model: key.slice(separator + 2) };
}

/// 合并目录与已存路由。catalogGroups 是 session/modelCatalog 的 groups
/// ([{id, name, models:[{id, name}]}]),storedRoutes 是命名空间里的
/// allowedModels([{provider, model}])。
export function subagentModelCandidates(catalogGroups, storedRoutes) {
  const selected = new Set();
  const stored = new Map();
  for (const route of storedRoutes ?? []) {
    const provider = route?.provider;
    const model = route?.model;
    if (!provider || !model) continue;
    const key = routeKey(provider, model);
    selected.add(key);
    stored.set(key, { provider, model });
  }

  const rows = [];
  for (const group of catalogGroups ?? []) {
    const providerName = group?.name || group?.id || "";
    for (const entry of group?.models ?? []) {
      const key = routeKey(group.id, entry.id);
      stored.delete(key);
      rows.push({
        key,
        provider: group.id,
        providerName,
        model: entry.id,
        modelName: entry.name || entry.id,
        available: true,
        selected: selected.has(key)
      });
    }
  }
  // 目录里已经没有、但还被存着的路由:仍然显示,标成不可用,让用户能取消勾选。
  for (const route of stored.values()) {
    rows.push({
      key: routeKey(route.provider, route.model),
      provider: route.provider,
      providerName: route.provider,
      model: route.model,
      modelName: route.model,
      available: false,
      selected: true
    });
  }
  return rows;
}

/// 按提供方分组,保持目录给的顺序;不可用的那一组排在最后(Mac 的
/// availableProviders + 单独的 unavailable 分组)。
export function groupSubagentCandidates(rows, unavailableLabel) {
  const groups = [];
  const byProvider = new Map();
  for (const row of rows.filter((entry) => entry.available)) {
    if (!byProvider.has(row.provider)) {
      const group = { provider: row.provider, providerName: row.providerName, candidates: [] };
      byProvider.set(row.provider, group);
      groups.push(group);
    }
    byProvider.get(row.provider).candidates.push(row);
  }
  const unavailable = rows.filter((row) => !row.available);
  if (unavailable.length) {
    groups.push({ provider: "__unavailable__", providerName: unavailableLabel, candidates: unavailable });
  }
  return groups;
}

/// 勾选状态变更后的路由列表:只保留仍被勾选的行,顺序按当前 rows 的显示顺序。
export function routesForSelection(rows, selection) {
  const chosen = selection instanceof Set ? selection : new Set(selection ?? []);
  return rows
    .filter((row) => chosen.has(row.key))
    .map((row) => ({ provider: row.provider, model: row.model }));
}

/// 保存条件:启用了模型选择就必须至少勾一个(Mac subagentModelSelectionRequired)。
export function subagentModelSelectionValid(enabled, selectedKeys) {
  return !enabled || (selectedKeys?.size ?? 0) > 0;
}
