// 引用投影:把紧随用户消息之后的跨会话 recall 上下文,回贴成该消息的引用标签。
// 对齐 web conversation-nodes/chat-snapshot-builder.ts ReferenceLabelProjector
// 与 event-projection.ts sessionRecallLabels。

/// source.kind === "session-reference" 时取 references[].label(首见顺序去重)。
export function sessionRecallLabels(source) {
  if (!source || typeof source !== "object") return [];
  if (source.kind !== "session-reference") return [];
  const refs = Array.isArray(source.references) ? source.references : [];
  const labels = [];
  for (const ref of refs) {
    const label = ref && typeof ref === "object" ? ref.label : null;
    if (typeof label === "string" && label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/// 用户消息引用标签投影:recall 上下文节点 seq 紧跟其用户消息(seq-1)。
export function projectReferenceLabels(nodes) {
  const byMessageSeq = new Map();
  for (const node of nodes) {
    if (node.kind !== "context") continue;
    const labels = sessionRecallLabels(node.source);
    if (labels.length) byMessageSeq.set(node.seq - 1, labels);
  }
  for (const node of nodes) {
    if (node.kind !== "user" && node.kind !== "steering") continue;
    node.referenceLabels = byMessageSeq.get(node.seq) ?? null;
  }
}
