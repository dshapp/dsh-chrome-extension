// 交互流程的纯逻辑层。对齐 macos/Sources/DSHMacKit/State/ComposerFlow.swift。
// 这里不碰 DOM——线协议的编码规则值得被单独测试,而不是埋在渲染代码里。

/// 撤销交互的应答体。
///
/// **details 是必填的。** 宿主 /api/respond 用 clientResponseSchema 解析整个响应,
/// 其 error 分支是 rpcErrorSchema 判别联合——每个分支都要求 details
/// (cancelled 取空对象)。少这个键会解析失败,宿主回 {accepted:false, reason:"bad-response"},
/// 卡片就永远停在那里、交互再也推进不下去。Mac 端与 web 端发的都是 details: {}。
export function cancelledResult(message = "user cancelled") {
  return { ok: false, error: { code: "cancelled", message, details: {} } };
}

/// 输入框被交互卡接管的判定。question 优先于 approval。
export function resolveTakeover({ question, approval } = {}) {
  if (question) return { kind: "question", question };
  if (approval) return { kind: "approval", approval };
  return null;
}

/// 挂起交互的分类,供会话行/悬浮卡这类只需要标签的界面使用。
export function pendingInteractionStatus({ approval, question } = {}) {
  if (approval) return "approval";
  if (!question) return null;
  return classifyQuestions(question.questions ?? []);
}

/// 单条、非多选、声明 plan-review intent、以 detail 承载计划、
/// 除具名 approve 标签外至多再有一个选项的问题,是一次计划审阅;其余都是普通提问。
export function classifyQuestions(questions) {
  if (questions.length !== 1) return "question";
  const q = questions[0];
  if (q?.intent?.kind !== "plan-review" || q.detail == null || q.multiSelect === true) return "question";
  const options = q.options ?? [];
  if (options.length > 2) return "question";
  const approveLabel = q.intent?.approve;
  return options.some((o) => o.label === approveLabel) ? "planReview" : "question";
}

/// 计划审阅流程。route 返回 null 表示这批问题不是计划审阅。
export function routePlanReview(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0];
  const approveLabel = q?.intent?.approve;
  if (q?.intent?.kind !== "plan-review" || !approveLabel || q.detail == null || q.multiSelect === true) return null;
  const options = q.options ?? [];
  if (options.length > 2) return null;
  const approve = options.find((o) => o.label === approveLabel);
  if (!approve) return null;
  return {
    id: q.id,
    question: q.question,
    plan: q.detail,
    approve,
    decline: options.find((o) => o.label !== approveLabel) ?? null
  };
}

/// 构造一个线上答案。
///
/// **custom 为空时必须整个字段省略,不能发 `custom: null`。**
/// 宿主的 ask_user_question 结果 schema 是 `custom: { type: "string" }` 且
/// `additionalProperties: false`——null 不是 string,整条响应会被判 `bad-response`
/// 并原样退回(accepted:false),问答卡就永远停在那里。Swift 的 Encodable 对 nil
/// 可选字段本来就省略,所以 Mac 端天然是对的;JS 里必须显式这么做。
function answer(id, selected, custom) {
  const trimmed = typeof custom === "string" ? custom : null;
  return trimmed ? { id, selected, custom: trimmed } : { id, selected };
}

/// 批准答案。custom 刻意省略:计划模式宿主只有在答案**不带**自由文本时
/// 才把选择视为批准(exit_plan_mode 读的是 selected == [approve] && custom == null),
/// 所以批准永远不可能捎带意见。
export function approveAnswer(review) {
  return answer(review.id, [review.approve.label], null);
}

/// 「继续规划」答案,带上审阅者写的意见。
///
/// 两个字段在线上是**互斥**的。宿主校验器会整体拒绝(accepted:false)一个非多选却
/// 同时带 custom 和非空 selected 的答案。所以意见单独作为 custom 发出、selected 留空;
/// 只有裸拒绝(没写意见)才发 decline 标签。
///
/// 两种形状都到达同一个地方:exit_plan_mode 只在 selected == [approve] 且 custom == null
/// 时视为批准;空 selected 通不过该判定,于是落进「继续规划」分支,并把 custom 读作
/// 交给模型的反馈。空白或纯空格的意见编码为 null,正是裸拒绝会发的那个答案。
export function reviseAnswer(review, notes) {
  const trimmed = (notes ?? "").trim();
  if (trimmed) return answer(review.id, [], trimmed);
  return answer(review.id, review.decline ? [review.decline.label] : [], null);
}

/// 主按钮的答案,由审阅者是否写了意见决定。
///
/// 意见和批准在线上互斥:宿主只从 selected == [approve] && custom == null 读出批准,
/// 所以一个携带反馈的答案**不可能**同时是批准。既然如此,写下的意见优先——
/// 丢掉意见去批准,等于执行一份审阅者刚要求修改的计划,那是最响亮的一种失败。
/// 空白或纯空格的文本则与从前一样批准。
export function submitAnswer(review, notes) {
  return (notes ?? "").trim() ? reviseAnswer(review, notes) : approveAnswer(review);
}

// ---- 通用问答向导 ----

function blankDraft() {
  return { selected: [], custom: "", skipped: false };
}

function draftAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== "";
}

function draftCompleted(draft) {
  return draftAnswered(draft) || draft.skipped;
}

/// 逐题向导状态机。所有变更都返回新的 state,便于测试与渲染层比对。
export function createQuestionFlow(questions) {
  return {
    questions,
    index: 0,
    drafts: questions.map(() => blankDraft()),
    validation: null
  };
}

export const flowCurrent = (s) => s.questions[s.index] ?? null;
export const flowDraft = (s) => s.drafts[s.index] ?? null;
export const flowIsFirst = (s) => s.index === 0;
export const flowIsLast = (s) => s.index >= s.questions.length - 1;

function clone(s) {
  return { ...s, drafts: s.drafts.map((d) => ({ ...d, selected: [...d.selected] })) };
}

export function flowPrevious(s) {
  if (s.index === 0) return s;
  const next = clone(s);
  next.index -= 1;
  next.validation = null;
  return next;
}

export function flowNext(s) {
  if (s.index + 1 >= s.questions.length) return s;
  const next = clone(s);
  next.index += 1;
  next.validation = null;
  return next;
}

/// 选择一个选项。单选会覆盖并(非末题时)自动前进;多选是累加/取消。
export function flowChoose(s, label) {
  const question = flowCurrent(s);
  if (!question) return s;
  const next = clone(s);
  const draft = next.drafts[next.index];
  if (question.multiSelect === true) {
    const at = draft.selected.indexOf(label);
    if (at >= 0) draft.selected.splice(at, 1);
    else draft.selected.push(label);
    draft.skipped = false;
  } else {
    next.drafts[next.index] = { selected: [label], custom: "", skipped: false };
  }
  next.validation = null;
  if (question.multiSelect !== true && !flowIsLast(next)) next.index += 1;
  return next;
}

/// 选中一个选项并报告这批问题是否可以立刻提交,省掉在提交按钮上的第二次点击。
/// 只有**末题上的单选**才会结算这张卡:中途选择会自动前进到下一题,
/// 多选的勾选则累积到提交按钮。当选择落在末题、但更早的题仍未回答时,
/// 这里改为跳转到那一题并给出 incomplete 反馈——与提交按钮自身的校验走同一条路。
export function flowChooseSettling(s, label) {
  const settles = flowIsLast(s) && flowCurrent(s)?.multiSelect !== true;
  const next = flowChoose(s, label);
  if (!settles) return { state: next, submit: false };
  return flowValidate(next);
}

export function flowSetCustom(s, value) {
  const question = flowCurrent(s);
  if (!question) return s;
  const next = clone(s);
  const draft = next.drafts[next.index];
  draft.custom = value;
  draft.skipped = false;
  // 单选题里自由文本与选项互斥:写了文本就清空选择。
  if (question.multiSelect !== true) draft.selected = [];
  next.validation = null;
  return next;
}

export function flowSkip(s) {
  if (!s.drafts[s.index]) return { state: s, submit: false };
  const next = clone(s);
  next.drafts[next.index] = { selected: [], custom: "", skipped: true };
  next.validation = null;
  if (!flowIsLast(next)) {
    next.index += 1;
    return { state: next, submit: false };
  }
  return flowValidate(next);
}

/// 「继续」按钮:当前题必须已回答;末题则触发整批校验。
export function flowContinue(s) {
  const draft = flowDraft(s);
  if (!draft || !draftAnswered(draft)) {
    return { state: { ...clone(s), validation: "unanswered" }, submit: false };
  }
  if (!flowIsLast(s)) {
    const next = clone(s);
    next.index += 1;
    next.validation = null;
    return { state: next, submit: false };
  }
  return flowValidate(s);
}

/// 整批校验:定位第一个未完成的题并跳过去,否则放行提交。
export function flowValidate(s) {
  const missing = s.drafts.findIndex((d) => !draftCompleted(d));
  if (missing === -1) return { state: { ...clone(s), validation: null }, submit: true };
  const next = clone(s);
  next.index = missing;
  next.validation = "incomplete";
  return { state: next, submit: false };
}

/// 序列化为线上答案。跳过的题发空答案;
/// 单选题里自由文本非空时 selected 必须清空(见 reviseAnswer 的互斥说明)。
export function flowAnswers(s) {
  return s.questions.map((question, i) => {
    const draft = s.drafts[i];
    if (draft.skipped) return answer(question.id, [], null);
    const custom = draft.custom.trim();
    return answer(
      question.id,
      (!custom || question.multiSelect === true) ? draft.selected : [],
      custom || null
    );
  });
}

/// 第 n 行(1 基)对应的数字键,超过第 9 行就没有单个数字可给了。
export function optionShortcutDigit(rowNumber) {
  if (rowNumber < 1 || rowNumber > 9) return null;
  return String(rowNumber);
}

/// 剥离标签末尾的 (recommended)/(推荐) 后缀,并报告它是否存在。
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
export function recommendedLabel(source) {
  const text = source ?? "";
  const match = text.match(RECOMMENDED_SUFFIX);
  if (!match) return { label: text, recommended: false };
  return { label: text.slice(0, match.index), recommended: true };
}

/// 审批卡的展示信息。bash 工具会回查未结算的同 callId 调用,把 command 提出来展示。
export function resolveApprovalPresentation(approval, store, tFn) {
  let command = null;
  if (approval.toolName === "bash" && approval.callId && store) {
    const call = store.toolCall(approval.callId);
    if (call && call.result == null) command = bashCommand(call.argsRaw);
  }
  return {
    reason: approval.reason ?? tFn("approval.escalation", { tool: approval.toolName }),
    toolName: approval.toolName,
    command
  };
}

export function bashCommand(argsRaw) {
  try {
    const obj = JSON.parse(argsRaw);
    return typeof obj?.command === "string" ? obj.command : null;
  } catch {
    return null;
  }
}
