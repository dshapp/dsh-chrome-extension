// Turn rail 的合并与预览裁剪。对齐 macos TurnRailItem.swift(mergeTurnRailItems /
// TurnRailPreview)与 web ui-chat/chat/turn-rail-items.ts。
//
// 两条来源在此交汇:host 的 turnOutline 投影命名了整本日志的每一轮(turn +
// turn/start seq + 有界预览),加载窗口供应锚点行 id 与更丰富的预览。窗口内未
// 被投影承诺的轮(在飞的那轮)由 loadedPreview 回填。

/// 有界预览:空格拼接文本块、折叠空白、超限加省略号。对齐 web projection.preview。
export const TurnRailPreview = Object.freeze({ promptLimit: 50, responseLimit: 120 });

export function clipTurnPreview(parts, limit) {
  let text = "";
  let unread = false;
  for (const part of parts) {
    if (typeof part !== "string" || part === "") continue;
    if (text.length >= limit * 2) { unread = true; break; }
    const clipped = part.length > limit * 2;
    const chunk = clipped ? part.slice(0, limit * 2) : part;
    text += text === "" ? chunk : " " + chunk;
    if (clipped) { unread = true; break; }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`;
  return unread ? `${normalized}…` : normalized;
}

/// 单条 wire 投影 entry 的结构收窄。turn 与 seq 是承重的(没有它们就无法成标、
/// 无法跳转),损坏即丢弃;预览是装饰性的,坏掉降级为空串,轮仍可按序号导航。
function outlineEntry(value) {
  if (typeof value !== "object" || value === null) return null;
  const turn = value.turn;
  const seq = value.seq;
  if (!Number.isSafeInteger(turn) || turn < 0) return null;
  if (!Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)) return null;
  return {
    turn,
    seq,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    response: typeof value.response === "string" ? value.response : ""
  };
}

/// 合并 host 整本投影与加载窗口的锚点。窗口内用锚点行(投影预览仅在窗口预览为空时
/// 兜底),窗口外的轮用投影的 seq 作为分页加载目标。结果按 turn 升序。
/// - outline: turnOutline 投影 value(数组,当 wire 数据处理)。
/// - anchors: loaded turn → 锚点行 id(会话 nodeId)。
/// - loadedPreview: fn(turn) → { prompt, response }(从窗口 nodes 派生)。
export function mergeTurnRailItems(outline, anchors, loadedPreview) {
  const byTurn = new Map();
  for (const raw of Array.isArray(outline) ? outline : []) {
    const entry = outlineEntry(raw);
    if (entry == null) continue;
    byTurn.set(entry.turn, {
      turn: entry.turn,
      prompt: entry.prompt,
      response: entry.response,
      anchorRow: null,
      seq: entry.seq
    });
  }
  // anchors 可能是 Map 或普通对象(兼容 store 内部的两种表示)。
  const anchorEntries = anchors instanceof Map ? anchors : Object.entries(anchors ?? {});
  for (const [key, rowId] of anchorEntries) {
    const turn = Number(key);
    if (!Number.isSafeInteger(turn) || turn < 0) continue;
    const preview = byTurn.get(turn);
    const loaded = loadedPreview ? loadedPreview(turn) : { prompt: "", response: "" };
    byTurn.set(turn, {
      turn,
      prompt: loaded.prompt !== "" ? loaded.prompt : (preview?.prompt ?? ""),
      response: loaded.response !== "" ? loaded.response : (preview?.response ?? ""),
      anchorRow: rowId ?? null,
      seq: preview?.seq ?? null
    });
  }
  if (byTurn.size === 0) return [];
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}
