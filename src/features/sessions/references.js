// 引用投影:把紧随用户消息之后的跨会话 recall 上下文,回贴成该消息的引用标签。
// 对齐 web conversation-nodes/chat-snapshot-builder.ts ReferenceLabelProjector
// 与 event-projection.ts sessionRecallLabels。

/// source.kind === "session-reference" 时取 references[]{label, sessionId}(按 label 首见顺序去重)。
/// host 会把直接用户消息里的 `@[label](dsh-session:…)` 重写成纯文本 `@label`,
/// 会话 id 只剩这条 recall 上下文还带着 —— 气泡要把标签点成跳转就得靠它。
export function sessionRecallReferences(source) {
  if (!source || typeof source !== "object") return [];
  if (source.kind !== "session-reference") return [];
  const refs = Array.isArray(source.references) ? source.references : [];
  const seen = [];
  for (const ref of refs) {
    const label = ref && typeof ref === "object" ? ref.label : null;
    const sessionId = ref && typeof ref === "object" ? ref.sessionId : null;
    if (typeof label !== "string" || !label) continue;
    if (seen.some((item) => item.label === label)) continue;
    seen.push({ label, sessionId: typeof sessionId === "string" && sessionId ? sessionId : null });
  }
  return seen;
}

/// 用户消息引用标签投影:recall 上下文节点 seq 紧跟其用户消息(seq-1)。
export function projectReferenceLabels(nodes) {
  const byMessageSeq = new Map();
  for (const node of nodes) {
    if (node.kind !== "context") continue;
    const refs = sessionRecallReferences(node.source);
    if (refs.length) byMessageSeq.set(node.seq - 1, refs);
  }
  for (const node of nodes) {
    if (node.kind !== "user" && node.kind !== "steering") continue;
    const refs = byMessageSeq.get(node.seq) ?? null;
    node.referenceSessions = refs;
    node.referenceLabels = refs ? refs.map((ref) => ref.label) : null;
  }
}
