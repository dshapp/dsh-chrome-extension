// 轨迹搜索:命中记录的 id 集合。空查询返回 null,表示"不过滤"(与 Mac
// searchMatches: Set<String>? 同义)。
//
// 搜索面按 Web TrajectorySearchIndex 的口径:按空白拆词、逐词 AND、大小写
// 不敏感;覆盖记录自身文本/预览/载荷/结果/思考/工具名/调用 id、块类型与内容、
// 附件名、来源 JSON,以及该记录所属请求的 prompt 系统提示词与工具目录。

function requestById(snapshot, id) {
  if (!id) return null;
  return snapshot.requests.find((request) => request.id === id) ?? null;
}

function searchableJson(value) {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function haystack(record, request) {
  const parts = [
    record.kind,
    record.kind === "assistant" ? "assistant" : "",
    record.turn == null ? "between turns" : `turn ${record.turn}`,
    record.text,
    record.previewMarkdown,
    record.toolName,
    record.callId,
    record.parentCallId,
    record.inputDetail,
    record.outputDetail,
    record.thinkingDetail,
    record.result,
    sanitizeSchema(record.toolSchema)
  ];
  for (const block of record.sourceBlocks ?? []) {
    parts.push(block.type, block.content, block.callId, block.toolName, block.attachment?.name);
  }
  for (const block of record.outputBlocks ?? []) {
    parts.push(block.type, block.content, block.callId, block.toolName, block.attachment?.name);
  }
  if (record.prompt) {
    parts.push(record.prompt.system);
    for (const tool of record.prompt.tools ?? []) parts.push(tool.name, tool.description);
  }
  if (record.previousPrompt) parts.push(record.previousPrompt.system);
  parts.push(searchableJson(record.messageSource));
  if (request) {
    parts.push(request.error, request.provider, request.model);
    if (request.prompt) {
      parts.push(request.prompt.system);
      for (const tool of request.prompt.tools ?? []) parts.push(tool.name, tool.description);
    }
  }
  return parts.filter(Boolean).join("\n").toLowerCase();
}

function sanitizeSchema(schema) {
  if (!schema) return "";
  return [schema.name, schema.description, schema.parameters == null ? "" : safeStringify(schema.parameters)].filter(Boolean).join(" ");
}

function safeStringify(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}

/// 查询 → 命中记录 id 集合;空白查询返回 null。
export function buildSearchMatches(snapshot, query) {
  const terms = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const matches = new Set();
  for (const record of snapshot.records) {
    const text = haystack(record, requestById(snapshot, record.requestId));
    if (terms.every((term) => text.includes(term))) matches.add(record.id);
  }
  return matches;
}
