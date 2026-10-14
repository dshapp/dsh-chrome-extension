// 插件配置卡片的规格表。对齐 Mac Components/Plugins/PluginConfigCards.swift 与
// SubagentPluginCard.swift:每张卡声明自己的命名空间、字段与(可选的)凭证。
//
// Mac D30 规则:命名空间不被当前部署组装的卡片完全不渲染,而不是画一个禁用的
// 空壳 —— 一张点不动的卡片读起来像坏了,而不像"此部署没有它"。所以规格是纯数据,
// 过滤发生在渲染处(availableCards)。
//
// 联网搜索这张卡是关键一处修正:此前本文件断言"宿主 web-search-deepseek 暴露的是
// model/apiVersion/maxTokens/maxUses,与 Mac 卡片的 baseURL + maxUses 对不上"。
// 实测(0.1.6)该命名空间的 schema 里 baseURL 与 maxUses 都在,凭证走 apiKey/apiKeyEnv
// —— 两边字段本来就是对得上的,那句断言是错的,卡片据此恢复。

/// 字段 kind:number 走数值校验,text 原样透传,secret 走凭证库而不是设置文件。
export const PLUGIN_CARDS = Object.freeze([
  {
    id: "bash",
    // 0.1.7 改名 shell → bash-sandbox;老宿主仍叫 shell(availableCards 按出场的那个解析)。
    namespace: "bash-sandbox",
    legacyNamespace: "shell",
    title: "plug.bashTitle",
    description: "plug.bashDescription",
    fields: [
      { id: "timeoutMs", label: "plug.bashTimeoutMs", hint: "plug.bashTimeoutMsHint", kind: "number" },
      { id: "maxOutputBytes", label: "plug.bashMaxOutputBytes", hint: "plug.bashMaxOutputBytesHint", kind: "number" }
    ]
  },
  {
    id: "agent-loop",
    namespace: "agent-loop",
    title: "plug.agentLoopTitle",
    description: "plug.agentLoopDescription",
    fields: [
      { id: "maxParallelToolCalls", label: "plug.agentLoopMaxParallel", hint: "plug.agentLoopMaxParallelHint", kind: "number" }
    ]
  },
  {
    id: "web-search",
    namespace: "web-search-deepseek",
    title: "plug.webSearchTitle",
    description: "plug.webSearchDescription",
    fields: [
      { id: "baseURL", label: "plug.webSearchBaseUrl", hint: "plug.webSearchBaseUrlHint", kind: "text" },
      { id: "maxUses", label: "plug.webSearchMaxUses", hint: "plug.webSearchMaxUsesHint", kind: "number" }
    ],
    credential: {
      field: "apiKey",
      refField: "apiKeyEnv",
      label: "plug.webSearchApiKey",
      hint: "plug.webSearchApiKeyHint",
      defaultRef: "DEEPSEEK_API_KEY"
    }
  },
  {
    id: "subagent",
    namespace: "subagent",
    title: "plug.subagentTitle",
    description: "plug.subagentDescription",
    fields: [
      {
        id: "maxDepth", label: "plug.subagentMaxDepth", hint: "plug.subagentDepthHelp",
        invalidKey: "plug.subagentDepthInvalid", kind: "number"
      },
      {
        id: "maxActiveSubagents", label: "plug.subagentMaxActive", hint: "plug.subagentCapacityHelp",
        invalidKey: "plug.subagentCapacityInvalid", kind: "number"
      }
    ],
    // 模型选择是同一张卡的第二段,但它有自己的命名空间,所以单独记一处。
    // 0.1.7 改名 subagent-model-selection → subagent-model-selection-settings。
    modelSelection: { namespace: "subagent-model-selection-settings", legacyNamespace: "subagent-model-selection" }
  }
]);

/// 按当前 describe 已组装的命名空间过滤。卡片依赖的全部命名空间都在才算可用 ——
/// subagent 卡少了模型选择那半仍然可渲染(limitsAvailable/modelsAvailable 是两件事)。
///
/// 改过名的命名空间(legacyNamespace)按当前宿主实际出场的那个解析,返回的卡片
/// namespace 就是要读写的真实名字 —— 下游不必知道改名这回事。
export function availableCards(cards, namespaces) {
  const present = namespaces instanceof Set ? namespaces : new Set(namespaces ?? []);
  const resolve = (spec) => {
    if (present.has(spec.namespace)) return spec.namespace;
    if (spec.legacyNamespace && present.has(spec.legacyNamespace)) return spec.legacyNamespace;
    return null;
  };
  return cards.flatMap((card) => {
    const namespace = resolve(card);
    if (!namespace) return [];
    let modelSelection = card.modelSelection;
    if (modelSelection) {
      const resolved = resolve(modelSelection);
      modelSelection = resolved ? { ...modelSelection, namespace: resolved } : null;
    }
    return [{ ...card, namespace, modelSelection }];
  });
}

/// 凭证 ref:命名空间里的 apiKeyEnv 值是权威(用户可能指向别的环境变量),
/// 缺失时回落到卡片声明的默认 ref(决定"已存/未存"标记读哪一个 key)。
export function credentialRef(card, namespaceValue) {
  const spec = card.credential;
  if (!spec) return null;
  const value = namespaceValue && typeof namespaceValue === "object"
    ? namespaceValue[spec.refField]
    : null;
  return typeof value === "string" && value.trim() ? value.trim() : spec.defaultRef;
}
