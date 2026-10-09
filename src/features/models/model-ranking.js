// 模型菜单的排序与搜索,对齐 dsh 0.2 web:
//   - 供应商顺序 orderModelProviders(ui-model-selection/provider-order.ts):
//     deepseek-account 第一、deepseek-official 第二,其余保持目录顺序;
//   - 名称匹配 rankByName(ui-primitives/rank-by-name.ts):查询须是名称的大小写不敏感
//     有序子序列;前缀命中优先,其次按对齐分,再按原顺序;
//   - composer 菜单只有模型数 > 4 时才出搜索框(ModelSelect.tsx showSearch),组内排名、空组隐藏。

/// 模型数超过它才显示搜索框。
export const MODEL_SEARCH_THRESHOLD = 4;

function providerRank(id) {
  if (id === "deepseek-account") return 0;
  if (id === "deepseek-official") return 1;
  return 2;
}

/// 稳定排序的拷贝;组内模型顺序不变。
export function orderModelProviders(groups) {
  return [...(groups ?? [])]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => providerRank(a.group?.id) - providerRank(b.group?.id) || a.index - b.index)
    .map((entry) => entry.group);
}

/// 名称起点与 -/_ 分隔处的加权。
function boundaryBonus(name, index) {
  return index === 0 || name.charAt(index - 1) === "-" || name.charAt(index - 1) === "_" ? 8 : 0;
}

/// 最强的有序子序列对齐分,O(name × query)。查询不是子序列时返回 undefined。
/// 逐行移植 web alignmentScore:相邻与边界命中加分,跳过与前导字符扣分。
export function alignmentScore(name, query) {
  if (query.length > name.length) return undefined;
  const noMatch = Number.NEGATIVE_INFINITY;
  let previous = Array(name.length).fill(noMatch);
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index;
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array(name.length).fill(noMatch);
    let left = noMatch;
    let leftLeft = noMatch;
    let bestGapped = noMatch;
    for (let index = 0; index < previous.length; index++) {
      const prior = previous[index];
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2);
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index);
        let score = noMatch;
        if (left !== noMatch) score = left + bonus + 4;
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index);
        current[index] = score;
      }
      leftLeft = left;
      left = prior;
    }
    previous = current;
  }
  let best = noMatch;
  for (const score of previous) best = Math.max(best, score);
  return best === noMatch ? undefined : best;
}

/// 按查询给条目排名。nameOf 给出主键,labelOf(可选)给出第二个搜索键。
/// 空查询原样返回输入。
export function rankByName(items, rawQuery, nameOf = (item) => item.name, labelOf = () => undefined) {
  const query = String(rawQuery ?? "").toLowerCase();
  if (query === "") return items;
  const ranked = [];
  items.forEach((item, index) => {
    const label = labelOf(item);
    const keys = label === undefined ? [nameOf(item)] : [nameOf(item), label];
    let prefix = false;
    let score;
    for (const key of keys) {
      const lower = String(key ?? "").toLowerCase();
      const keyScore = alignmentScore(lower, query);
      if (keyScore === undefined) continue;
      prefix ||= lower.startsWith(query);
      score = score === undefined ? keyScore : Math.max(score, keyScore);
    }
    if (score !== undefined) ranked.push({ item, index, prefix, score });
  });
  ranked.sort((a, b) => Number(b.prefix) - Number(a.prefix) || b.score - a.score || a.index - b.index);
  return ranked.map((match) => match.item);
}

/// 模型菜单的分组:供应商排好序,组内按查询排名,空组隐藏。
/// showSearch 为 false 时忽略查询(与 web 一致:没有搜索框就不会有查询)。
export function modelMenuGroups(groups, query, { showSearch = true } = {}) {
  const trimmed = showSearch ? String(query ?? "").trim() : "";
  return orderModelProviders(groups)
    .map((group) => ({
      ...group,
      models: rankByName(group.models ?? [], trimmed, (model) => model.name || model.id)
    }))
    .filter((group) => group.models.length > 0);
}

/// 目录里的模型总数,决定要不要出搜索框。
export function modelCount(groups) {
  return (groups ?? []).reduce((sum, group) => sum + (group.models?.length ?? 0), 0);
}
