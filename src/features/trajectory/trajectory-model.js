// 轨迹装配器:把会话原始事件窗口折成轨迹台账所需的记录 + 请求生命周期。
//
// 逻辑口径 = Web(packages/client/ui-trajectory + ui-conversation):
//   - 系统提示词来自 system/message 事件(不是 request/header.header.system)。
//   - request/header 的变更分类对齐 inspectRequestPrompt(首次且 reason!=="initial" 不记变更)。
//   - requestOnly 记录(请求结束但没有助手消息)渲染为请求边界。
// 形态口径 = Mac 的 TrajectoryAssembler.swift(逐 case 移植)。
//
// 纯函数,不碰 DOM,也不读 store。输入是 [{ event, view }](按 seq 升序的窗口)。
import { t } from "../../shared/i18n.js";
import { expandAssistantStream } from "../sessions/assistant-stream.js";

/// 台账记录种类(对齐 Mac TrajectoryRecordKind)。
export const TrajectoryKind = Object.freeze({
  system: "system",
  user: "user",
  context: "context",
  compacted: "compacted",
  assistant: "assistant",
  tool: "tool",
  subtool: "subtool"
});

/// 请求状态。
export const TrajectoryStatus = Object.freeze({
  running: "running",
  complete: "complete",
  error: "error"
});

/// 流式未结算时行内预览的上限(对齐 Mac partialPreviewLimit)。
export const PARTIAL_PREVIEW_LIMIT = 160;
/// 折叠行摘要上限(对齐 Mac trajectorySummary 的 bounded()。
export const SUMMARY_LIMIT = 512;

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const str = (value) => (typeof value === "string" ? value : null);
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const arr = (value) => (Array.isArray(value) ? value : []);

function stringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return ""; }
}

function bounded(value, limit = SUMMARY_LIMIT) {
  const text = value ?? "";
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/// 事件是否是一次 surface 替换。
export function isReplacement(event) {
  const op = isObject(event?.surfaceOp) ? event.surfaceOp.op : event?.surfaceOp;
  return op === "replace";
}

function sourcePlugin(data) {
  return str(isObject(data?.source) ? data.source.plugin : null);
}

/// 内容块 → 轨迹源块。tool-call 取 arguments/id/name;image 取附件名。
function blockRecord(raw) {
  const object = isObject(raw) ? raw : {};
  const type = str(object.type) ?? "unknown";
  if (type === "tool-call") {
    return {
      type,
      content: str(object.arguments) ?? "",
      callId: str(object.id),
      toolName: str(object.name)
    };
  }
  if (type === "image") {
    const attachment = isObject(object.attachment) ? object.attachment : null;
    return { type, content: str(attachment?.name) ?? t("trajectory.imageBlock"), attachment };
  }
  return { type, content: str(object.text) ?? stringify(raw) };
}

function blocksFrom(value) {
  return arr(value).map(blockRecord);
}

/// tool/result 的载荷块:message.content 里是 tool-result,其 content 才是真正的块。
function toolResultBlocksFrom(value) {
  const out = [];
  for (const item of arr(value)) {
    const object = isObject(item) ? item : {};
    if (str(object.type) === "tool-result") out.push(...blocksFrom(object.content));
    else out.push(blockRecord(item));
  }
  return out;
}

function toolResultError(value) {
  return arr(value).some((item) => isObject(item) && item.isError === true);
}

/// 首个非空文本块做预览;没有则退回首块内容(空块不得占位)。
function previewOf(blocks) {
  const text = blocks.find((block) => block.type === "text" && block.content);
  return text?.content ?? blocks[0]?.content ?? "";
}

/// 用户/上下文预览:只看文本块(Web previewContent),空则视为无预览。
function inputPreviewOf(blocks) {
  const text = blocks.find((block) => block.type === "text" && block.content);
  return text?.content ?? "";
}

/// 附件摘要(Web layout.imageOnly / layout.fileAttachments):无文本预览时才标图片数。
function attachmentSummaryOf(blocks, previewMarkdown) {
  const images = blocks.filter((block) => block.type === "image").length;
  const files = blocks.filter((block) => block.type === "file" || block.type === "attachment").length;
  const parts = [];
  if (previewMarkdown == null && images > 0) parts.push(t("trajectory.imageOnly", { count: images }));
  if (files > 0) parts.push(t("trajectory.fileAttachments", { count: files }));
  return { text: parts.join(" · "), imageCount: images, fileCount: files };
}

function textDetailOf(blocks) {
  return blocks.filter((block) => block.type === "text" && block.content).map((block) => block.content).join("\n");
}

function usageFrom(value) {
  if (!isObject(value)) return null;
  const usage = {
    inputTokens: num(value.inputTokens),
    cacheReadTokens: num(value.cacheReadTokens),
    cacheWriteTokens: num(value.cacheWriteTokens),
    outputTokens: num(value.outputTokens),
    reasoningTokens: num(value.reasoningTokens)
  };
  return Object.values(usage).some((entry) => entry != null) ? usage : null;
}

function addUsage(left, right) {
  if (!right) return left;
  const sum = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: sum(left?.inputTokens, right.inputTokens),
    cacheReadTokens: sum(left?.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: sum(left?.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: sum(left?.outputTokens, right.outputTokens),
    reasoningTokens: sum(left?.reasoningTokens, right.reasoningTokens)
  };
}

function toolSchemaFrom(value) {
  if (!isObject(value)) return null;
  return {
    name: str(value.name),
    description: str(value.description),
    parameters: value.parameters ?? null,
    raw: value
  };
}

function promptTool(prompt, name) {
  if (!prompt || !name) return null;
  const match = (prompt.tools ?? []).find((tool) => tool.name === name);
  return match ?? null;
}

function durationSeconds(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / 1000);
}

function stepKey(turn, step) {
  return `${turn}:\0:${step}`;
}

/// 事件 seq → { turn, step }。按 Mac 的推进规则(step/end 清 step、turn/end 清两者)。
export function buildLocationIndex(entries) {
  const locations = new Map();
  let turn = null;
  let step = null;
  for (const { event } of entries) {
    const data = isObject(event?.data) ? event.data : {};
    if (event.type === "turn/start") { turn = num(data.turn); step = null; }
    if (event.type === "step/start") {
      turn = num(data.turn) ?? turn;
      step = num(data.step);
    }
    const eventTurn = num(data.turn) ?? turn;
    const eventStep = num(data.step) ?? step;
    locations.set(event.seq, { turn: eventTurn, step: eventStep });
    if (event.type === "step/end") step = null;
    if (event.type === "turn/end") { turn = null; step = null; }
  }
  return locations;
}

function requestIdForStep(turn, step) {
  return `assistant\0${turn}\0${step}`;
}

/// 把窗口事件折成 { records, requests }。
export function assembleTrajectory(entries) {
  const ordered = [...entries].sort((left, right) => (left.event?.seq ?? 0) - (right.event?.seq ?? 0));
  const locations = buildLocationIndex(ordered);
  const records = [];
  const requests = new Map();
  const assistantRecordIndex = new Map();
  const toolRecordIndex = new Map();
  const compactionRecordIndex = new Map();
  const requestByStep = new Map();
  const firstTokenByStep = new Map();
  const partialByStep = new Map();
  const pendingNextStep = [];
  const claimedSteering = new Set();
  let previousPrompt = null;
  let latestPrompt = null;
  // 最近一条 append 的 system/message;replace 会把它清空。
  let effectiveSystem = null;
  let sawHeader = false;

  const recordTurnStep = (event) => locations.get(event.seq) ?? { turn: null, step: null };

  function emitSystemRecord(event, prompt, label) {
    records.push({
      id: `system\0seq\0${event.seq}`,
      kind: TrajectoryKind.system,
      sourceSeq: event.seq,
      turn: recordTurnStep(event).turn,
      step: recordTurnStep(event).step,
      text: label,
      startedAt: event.time,
      durationSeconds: 0,
      prompt,
      previousPrompt
    });
  }

  function absorbStream(streamValue, turn, step, requestByStepMap, requestsMap) {
    const key = stepKey(turn, step);
    for (const { time, chunk } of expandAssistantStream(streamValue)) {
      if (!isObject(chunk)) continue;
      const type = str(chunk.type) ?? "";
      const isDelta = type === "text-delta" || type === "reasoning-delta" || type === "tool-call-delta";
      if (isDelta) {
        if (!firstTokenByStep.has(key)) firstTokenByStep.set(key, time);
        const existing = partialByStep.get(key);
        let text = existing?.text ?? "";
        if (text.length < PARTIAL_PREVIEW_LIMIT) {
          const delta = str(chunk.text) ?? str(chunk.argumentsDelta) ?? "";
          if (delta) text = (text + delta).slice(0, PARTIAL_PREVIEW_LIMIT);
        }
        partialByStep.set(key, { start: firstTokenByStep.get(key) ?? time, end: time, text });
      }
      if (type === "usage") {
        const requestId = requestByStepMap.get(key);
        const request = requestId ? requestsMap.get(requestId) : null;
        if (request) {
          request.usage = usageFrom(chunk.usage) ?? request.usage;
          requestsMap.set(requestId, request);
        }
      }
    }
  }

  for (const { event } of ordered) {
    const data = isObject(event?.data) ? event.data : {};
    const location = recordTurnStep(event);

    switch (event.type) {
      case "agent/inbox/spliced": {
        if (str(data.target) !== "next-step") break;
        const start = Math.min(Math.max(num(data.start) ?? 0, 0), pendingNextStep.length);
        const removed = Math.min(Math.max(num(data.removedCount) ?? 0, 0), pendingNextStep.length - start);
        const outcome = str(data.outcome) ?? str(data.result);
        if (outcome !== "canceled" && outcome !== "cancelled") {
          for (const id of pendingNextStep.slice(start, start + removed)) claimedSteering.add(id);
        }
        const inserted = arr(data.inserted).map((item) => {
          const object = isObject(item) ? item : {};
          return str(object.id) ?? str(isObject(object.message) ? object.message.id : null);
        }).filter((id) => id != null);
        pendingNextStep.splice(start, removed, ...inserted);
        break;
      }

      case "request/header": {
        const header = isObject(data.header) ? data.header : {};
        const prompt = {
          config: header.config ?? null,
          system: effectiveSystem?.text ?? "",
          tools: arr(header.tools).map(toolSchemaFrom).filter(Boolean)
        };
        const reason = str(data.reason);
        const changed = previousPrompt == null
          ? reason === "initial"
          : previousPrompt.system !== prompt.system || JSON.stringify(previousPrompt.tools) !== JSON.stringify(prompt.tools);
        sawHeader = true;
        latestPrompt = prompt;
        if (changed) {
          const label = previousPrompt == null
            ? t("trajectory.promptInitial")
            : previousPrompt.system !== prompt.system && JSON.stringify(previousPrompt.tools) !== JSON.stringify(prompt.tools)
              ? t("trajectory.promptSystemAndTools")
              : previousPrompt.system !== prompt.system
                ? t("trajectory.promptSystem")
                : t("trajectory.promptTools");
          emitSystemRecord(event, prompt, label);
        }
        previousPrompt = prompt;
        break;
      }

      case "system/message": {
        const message = isObject(data.message) ? data.message : {};
        const blocks = blocksFrom(message.content);
        const text = textDetailOf(blocks);
        if (isReplacement(event)) {
          effectiveSystem = null;
          if (sawHeader && previousPrompt && previousPrompt.system !== "") {
            const prompt = { ...previousPrompt, system: "" };
            emitSystemRecord(event, prompt, t("trajectory.promptSystem"));
            previousPrompt = prompt;
            latestPrompt = prompt;
          }
          break;
        }
        const prior = effectiveSystem;
        effectiveSystem = {
          seq: event.seq, time: event.time,
          turn: num(data.turn) ?? location.turn,
          step: num(data.step) ?? location.step,
          text
        };
        // 历史中的提示词更新:已有 header 且文本确实变了,锚在 system/message 自己的位置。
        if (sawHeader && latestPrompt && prior && prior.text !== text) {
          const prompt = { ...latestPrompt, system: text };
          emitSystemRecord(event, prompt, t("trajectory.promptSystem"));
          previousPrompt = prompt;
          latestPrompt = prompt;
        } else if (sawHeader && latestPrompt && prior == null && latestPrompt.system !== text) {
          const prompt = { ...latestPrompt, system: text };
          records.push({
            id: `system\0seq\0${event.seq}`,
            kind: TrajectoryKind.system,
            sourceSeq: event.seq,
            turn: effectiveSystem.turn,
            step: effectiveSystem.step,
            text: t("trajectory.promptSystem"),
            startedAt: event.time,
            durationSeconds: 0,
            prompt,
            previousPrompt: latestPrompt
          });
          previousPrompt = prompt;
          latestPrompt = prompt;
        }
        break;
      }

      case "user/message": {
        if (isReplacement(event) || sourcePlugin(data) === "compact") break;
        const message = isObject(data.message) ? data.message : {};
        const source = isObject(data.source) ? data.source : (isObject(message.source) ? message.source : null);
        const messageId = str(data.id) ?? str(message.id);
        const userSource = str(source?.kind) === "user";
        const kind = userSource ? TrajectoryKind.user : TrajectoryKind.context;
        const steering = userSource && messageId != null && claimedSteering.has(messageId);
        const blocks = blocksFrom(data.content ?? message.content);
        const preview = inputPreviewOf(blocks);
        const previewMarkdown = preview === "" ? null : preview;
        const attachments = attachmentSummaryOf(blocks, previewMarkdown);
        records.push({
          id: `${kind}\0seq\0${event.seq}`,
          kind,
          sourceSeq: event.seq,
          turn: location.turn,
          step: location.step,
          text: attachments.text,
          previewMarkdown,
          imageCount: attachments.imageCount,
          fileCount: attachments.fileCount,
          steering: steering ? true : undefined,
          inputDetail: textDetailOf(blocks),
          sourceBlocks: blocks,
          startedAt: event.time,
          durationSeconds: 0,
          messageSource: source
        });
        break;
      }

      case "step/start": {
        const turn = num(data.turn) ?? location.turn ?? 0;
        const step = num(data.step) ?? location.step ?? 0;
        const key = stepKey(turn, step);
        const id = requestIdForStep(turn, step);
        requestByStep.set(key, id);
        requests.set(id, {
          id,
          purpose: "assistant",
          startSeq: event.seq,
          turn,
          step,
          startedAt: event.time,
          completedAt: null,
          status: TrajectoryStatus.running,
          options: latestPrompt?.config ?? null,
          prompt: latestPrompt
        });
        break;
      }

      case "assistant/attempt": {
        const turn = num(data.turn) ?? location.turn ?? 0;
        const step = num(data.step) ?? location.step ?? 0;
        absorbStream(data.stream, turn, step, requestByStep, requests);
        break;
      }

      case "llm/retry": {
        const turn = num(data.turn) ?? location.turn ?? 0;
        const step = num(data.step) ?? location.step ?? 0;
        const key = stepKey(turn, step);
        const id = requestByStep.get(key);
        const request = id ? requests.get(id) : null;
        if (!request) break;
        request.retry = num(data.retry);
        request.maxRetries = num(data.maxRetries);
        request.retryDelayMs = num(data.delayMs);
        const failure = isObject(data.failure) ? data.failure : null;
        request.error = failure ? (str(failure.message) ?? "") : request.error;
        request.errorCode = failure ? str(failure.code) : request.errorCode;
        requests.set(id, request);
        partialByStep.delete(key);
        break;
      }

      case "assistant/message": {
        const turn = num(data.turn) ?? location.turn ?? 0;
        const step = num(data.step) ?? location.step ?? 0;
        const key = stepKey(turn, step);
        const requestId = requestByStep.get(key) ?? requestIdForStep(turn, step);
        if (!requests.has(requestId)) {
          requests.set(requestId, {
            id: requestId, purpose: "assistant", startSeq: event.seq, turn, step,
            startedAt: event.time, completedAt: null, status: TrajectoryStatus.running,
            options: latestPrompt?.config ?? null, prompt: latestPrompt
          });
        }
        absorbStream(data.stream, turn, step, requestByStep, requests);
        const message = isObject(data.message) ? data.message : {};
        const content = blocksFrom(message.content);
        const text = content.filter((b) => b.type === "text" && b.content).map((b) => b.content).join("\n\n");
        const thinking = content.filter((b) => (b.type === "reasoning" || b.type === "thinking") && b.content).map((b) => b.content).join("\n\n");
        const request = requests.get(requestId);
        const timing = {
          stepStartedAt: request?.startedAt ?? null,
          firstTokenAt: firstTokenByStep.get(key) ?? null,
          completedAt: event.time
        };
        const usage = usageFrom(data.usage);
        partialByStep.delete(key);
        const record = {
          id: `assistant\0${turn}\0${step}`,
          kind: TrajectoryKind.assistant,
          sourceSeq: event.seq,
          turn,
          step,
          text: text || thinking || (content.some((b) => b.type === "image")
            ? t("trajectory.imageOnly", { count: content.filter((b) => b.type === "image").length })
            : t("trajectory.toolCallOnly")),
          previewMarkdown: text || thinking || null,
          outputDetail: text || null,
          thinkingDetail: thinking || null,
          sourceBlocks: content,
          startedAt: request?.startedAt ?? null,
          durationSeconds: durationSeconds(request?.startedAt, event.time),
          usage,
          timing,
          requestId
        };
        assistantRecordIndex.set(key, records.length);
        records.push(record);
        if (request) {
          request.completedAt = event.time;
          request.resultSeq = event.seq;
          request.status = TrajectoryStatus.complete;
          request.usage = usage ?? request.usage;
          const source = isObject(message.source) ? message.source : null;
          request.provider = str(source?.provider);
          request.model = str(source?.model);
          requests.set(requestId, request);
        }
        for (const block of content) {
          if (block.type !== "tool-call") continue;
          const callId = block.callId;
          if (!callId || toolRecordIndex.has(callId)) continue;
          toolRecordIndex.set(callId, records.length);
          records.push({
            id: `tool\0call\0${callId}`,
            kind: TrajectoryKind.tool,
            turn,
            step,
            text: block.toolName ?? "tool",
            inputDetail: block.content,
            callId,
            toolName: block.toolName,
            toolSchema: promptTool(request?.prompt, block.toolName),
            startedAt: event.time,
            requestId
          });
        }
        break;
      }

      case "step/end": {
        const turn = num(data.turn) ?? location.turn ?? 0;
        const step = num(data.step) ?? location.step ?? 0;
        const key = stepKey(turn, step);
        const requestId = requestByStep.get(key);
        const request = requestId ? requests.get(requestId) : null;
        partialByStep.delete(key);
        if (!request || request.status !== TrajectoryStatus.running) break;
        request.completedAt = event.time;
        request.status = TrajectoryStatus.error;
        request.error = t("trajectory.requestEnded");
        requests.set(requestId, request);
        if (!assistantRecordIndex.has(key)) {
          records.push({
            id: `assistant\0${turn}\0${step}`,
            kind: TrajectoryKind.assistant,
            sourceSeq: request.startSeq,
            turn,
            step,
            text: "",
            isError: true,
            startedAt: request.startedAt,
            durationSeconds: durationSeconds(request.startedAt, event.time),
            requestId,
            requestOnly: true
          });
        }
        break;
      }

      case "tool/call": {
        const rawCallId = str(data.callId) ?? "";
        const callId = rawCallId === "" ? `seq-${event.seq}` : rawCallId;
        const turn = num(data.turn) ?? location.turn;
        const step = num(data.step) ?? location.step;
        const requestId = turn != null && step != null ? requestByStep.get(stepKey(turn, step)) ?? null : null;
        const name = str(data.name);
        if (toolRecordIndex.has(callId)) {
          const record = records[toolRecordIndex.get(callId)];
          record.sourceSeq = event.seq;
          record.startedAt = event.time;
          record.inputDetail = str(data.arguments) ?? record.inputDetail;
          if (name) record.toolName = name;
          record.toolSchema = promptTool(requests.get(requestId)?.prompt, name) ?? record.toolSchema;
        } else {
          toolRecordIndex.set(callId, records.length);
          records.push({
            id: `tool\0call\0${callId}`,
            kind: TrajectoryKind.tool,
            sourceSeq: event.seq,
            turn,
            step,
            text: name ?? "tool",
            inputDetail: str(data.arguments),
            callId,
            toolName: name,
            toolSchema: promptTool(requests.get(requestId)?.prompt, name),
            startedAt: event.time,
            requestId
          });
        }
        break;
      }

      case "tool/result": {
        const message = isObject(data.message) ? data.message : {};
        const block = arr(message.content).map((item) => (isObject(item) ? item : {})).find((item) => str(item.type) === "tool-result") ?? {};
        const callId = str(data.callId) ?? str(block.toolCallId) ?? "";
        const resultBlocks = toolResultBlocksFrom(message.content);
        const error = isObject(data.error) ? data.error : null;
        const isError = error != null || toolResultError(message.content) || data.isError === true;
        const index = toolRecordIndex.get(callId);
        if (index == null) {
          // 孤儿 tool-result(缺 tool/call):合成工具行,Web 归到 turn 0/step 1,布局再并入 Turn 1。
          const name = str(block.toolName) ?? str(block.name) ?? t("trajectory.kindTool");
          const id = callId || `seq-${event.seq}`;
          if (callId) toolRecordIndex.set(callId, records.length);
          records.push({
            id: `tool\0call\0${id}`,
            kind: TrajectoryKind.tool,
            sourceSeq: event.seq,
            turn: 0,
            step: 1,
            text: name,
            callId: id,
            toolName: name,
            outputDetail: textDetailOf(resultBlocks),
            outputBlocks: resultBlocks,
            result: str(error?.code) ?? previewOf(resultBlocks) ?? "",
            isError,
            startedAt: event.time,
            durationSeconds: 0
          });
          break;
        }
        const record = records[index];
        record.outputDetail = textDetailOf(resultBlocks);
        record.outputBlocks = resultBlocks;
        record.result = str(error?.code) ?? previewOf(resultBlocks) ?? "";
        record.isError = isError;
        record.durationSeconds = durationSeconds(record.startedAt, event.time);
        break;
      }

      case "tool/ptc-dispatch-start":
      case "tool/code-dispatch-start":
      case "tool/ptc-dispatch":
      case "tool/code-dispatch": {
        const childId = str(data.subCallId) ?? str(data.callId);
        if (!childId) break;
        const parentId = str(data.parentCallId) ?? str(data.rootCallId);
        const ended = event.type === "tool/ptc-dispatch" || event.type === "tool/code-dispatch";
        if (toolRecordIndex.has(childId)) {
          const record = records[toolRecordIndex.get(childId)];
          if (ended) {
            const outputBlocks = blocksFrom(data.content);
            record.outputDetail = textDetailOf(outputBlocks);
            record.outputBlocks = outputBlocks;
            record.result = previewOf(outputBlocks);
            record.isError = data.isError === true;
            record.durationSeconds = durationSeconds(record.startedAt, event.time);
          }
        } else {
          toolRecordIndex.set(childId, records.length);
          records.push({
            id: `subtool\0call\0${childId}`,
            kind: TrajectoryKind.subtool,
            sourceSeq: event.seq,
            turn: location.turn,
            step: location.step,
            text: str(data.name) ?? "subtool",
            inputDetail: stringify(data.arguments),
            callId: childId,
            parentCallId: parentId,
            toolName: str(data.name),
            isError: data.isError === true,
            startedAt: event.time
          });
        }
        break;
      }

      case "compaction/start": {
        const id = str(data.compactionId);
        if (!id) break;
        const requestId = `compaction\0${id}`;
        requests.set(requestId, {
          id: requestId, purpose: "compaction", startSeq: event.seq,
          turn: num(data.turn), step: 0, startedAt: event.time,
          completedAt: null, status: TrajectoryStatus.running
        });
        compactionRecordIndex.set(id, records.length);
        records.push({
          id: `compacted\0${id}`,
          kind: TrajectoryKind.compacted,
          sourceSeq: event.seq,
          turn: num(data.turn),
          step: 0,
          text: t("trajectory.compactingContext"),
          startedAt: event.time,
          requestId
        });
        break;
      }

      case "compaction/summary": {
        const id = str(data.compactionId);
        const index = id ? compactionRecordIndex.get(id) : null;
        if (index == null) break;
        const summary = blocksFrom(data.summary);
        const raw = blocksFrom(data.rawOutput);
        const record = records[index];
        const hasSummary = data.summary != null && (Array.isArray(data.summary) ? data.summary.length > 0 : true);
        const summaryPreview = inputPreviewOf(summary);
        record.text = hasSummary ? "" : t("trajectory.contextCompacted");
        record.previewMarkdown = summaryPreview === "" ? null : summaryPreview;
        record.outputDetail = textDetailOf(summary);
        record.thinkingDetail = raw.filter((b) => b.type === "reasoning" && b.content).map((b) => b.content).join("\n") || null;
        record.usage = usageFrom(data.usage);
        const request = requests.get(`compaction\0${id}`);
        if (request) {
          request.resultSeq = event.seq;
          request.provider = str(data.provider);
          request.model = str(data.model);
          request.usage = record.usage;
          requests.set(request.id, request);
        }
        break;
      }

      case "compaction/end": {
        const id = str(data.compactionId);
        const index = id ? compactionRecordIndex.get(id) : null;
        if (index == null) break;
        const error = str(data.error);
        const record = records[index];
        record.isError = error != null;
        if (error != null) record.text = error;
        else if (record.previewMarkdown == null) record.text = record.text || t("trajectory.contextCompacted");
        record.settled = true;
        record.durationSeconds = durationSeconds(record.startedAt, event.time);
        const requestId = `compaction\0${id}`;
        const request = requests.get(requestId);
        if (request) {
          request.completedAt = event.time;
          request.status = error == null ? TrajectoryStatus.complete : TrajectoryStatus.error;
          request.error = error;
          requests.set(requestId, request);
        }
        break;
      }

      case "session/end-seed": {
        // 会话在压缩完成前结束:仍在运行中的压缩记录标记为中断。
        for (const index of compactionRecordIndex.values()) {
          const record = records[index];
          if (!record || record.kind !== TrajectoryKind.compacted) continue;
          if (record.settled === true || record.isError === true) continue;
          record.isError = true;
          record.interrupted = true;
          record.text = t("trajectory.compactionInterrupted");
        }
        break;
      }

      case "turn/end": {
        const turn = num(data.turn);
        const reason = isObject(data.reason) ? data.reason : null;
        if (str(reason?.kind) !== "error") break;
        const failure = isObject(reason?.error) ? reason.error : null;
        const message = str(failure?.message) ?? t("trajectory.turnFailed");
        let candidate = null;
        for (const request of requests.values()) {
          if (request.purpose !== "assistant" || request.turn !== turn) continue;
          if (candidate == null || request.startSeq > candidate.startSeq) candidate = request;
        }
        if (candidate) {
          candidate.status = TrajectoryStatus.error;
          candidate.completedAt = candidate.completedAt ?? event.time;
          candidate.error = message;
          requests.set(candidate.id, candidate);
        }
        break;
      }

      default:
        break;
    }
  }

  // 会话累计用量:按请求 startSeq 升序累加。
  let cumulative = null;
  const orderedRequests = [...requests.values()]
    .sort((left, right) => left.startSeq - right.startSeq)
    .map((request) => {
      if (request.usage) cumulative = addUsage(cumulative, request.usage);
      return { ...request, cumulativeUsage: cumulative };
    });

  // 流式未结算:有 token 但没有 settlement 的 step 补一条运行中的助手行。
  for (const [key, partial] of partialByStep) {
    if (assistantRecordIndex.has(key)) continue;
    const [turnText, stepText] = key.split(":\0:");
    const turn = Number(turnText);
    const step = Number(stepText);
    if (!Number.isInteger(turn) || !Number.isInteger(step)) continue;
    records.push({
      id: `assistant\0${turn}\0${step}`,
      kind: TrajectoryKind.assistant,
      sourceSeq: null,
      turn,
      step,
      text: partial.text.slice(0, PARTIAL_PREVIEW_LIMIT),
      startedAt: partial.start,
      durationSeconds: durationSeconds(partial.start, partial.end)
    });
  }

  return { records, requests: orderedRequests };
}

/// 轻量 Markdown → 纯文本(对齐 Web extractMarkdownPlainText 的效果)。
function markdownPlainText(source) {
  return String(source)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ""))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "");
}

/// 有界单行预览:源 2048,输出 512,去 Markdown、压空白(Web trajectoryPreviewText)。
export function previewText(text) {
  if (text == null || text === "") return "";
  const source = String(text).slice(0, 2048);
  const compact = markdownPlainText(source).replace(/\s+/g, " ").trim();
  const preview = compact.slice(0, 512).trimEnd();
  return source.length < String(text).length || preview.length < compact.length ? preview + "…" : preview;
}

/// 台账行摘要:有界单行(对齐 Web recordDisplayText;工具行 = 名称 + 参数)。
export function recordSummary(record) {
  if (record.kind === "tool" || record.kind === "subtool") {
    const name = record.toolName ?? record.text ?? "";
    const args = record.inputDetail ? previewText(record.inputDetail) : "";
    return bounded([name, args].filter(Boolean).join(" ")) || t("trajectory.recordNoContent");
  }
  const preview = record.previewMarkdown ? previewText(record.previewMarkdown) : "";
  const base = record.text && preview
    ? `${record.text} · ${preview}`
    : (preview || (record.text ? String(record.text).replace(/\n/g, " ") : ""));
  if (base) return bounded(base);
  if (record.outputDetail) return bounded(previewText(record.outputDetail));
  if (record.result) return bounded(String(record.result).replace(/\n/g, " "));
  return t("trajectory.recordNoContent");
}
