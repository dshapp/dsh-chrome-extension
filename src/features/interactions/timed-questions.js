// dsh 0.2 限时提问(timed ask_user_question)的纯逻辑层。
// 协议:deepseek-harness docs/subsystems/user-questions.md「Timed questions and late replies」;
// 客户端对齐 web ui-user-questions(answerQuestion / publishContinuedQuestions / question-reply)
// 与 Mac c710a29(StreamCoordinator 的倒计时、SessionStore.continuedQuestions)。
//
// 生命周期:
// 1. waterfall 请求带 wait:{callId, timed:true} → 客户端订阅 userQuestions/attachWait
//    认领这次前台等待;第一帧是宿主算出的剩余毫秒数,之后由本端时钟倒数。
// 2. 用户动了草稿或点「慢慢回答」→ 停表并一直持有认领(held),宿主不会超时。
// 3. 倒数到 0 且没人动过 → 以 ASK_TIMED_OUT 拒绝该 waterfall,宿主把它映射成
//    {pending:true},agent 继续干活;问题在 userQuestions 投影里转为 continued。
// 4. continued 问题没有 waterfall 了:回答走 userQuestions/answer(进 inbox 成为
//    source=user-question-reply 的用户消息),关闭面板什么都不发,只是收起。

/// 认领流的 streamId 前缀,按 waterfall eventId 区分。
const WAIT_STREAM_PREFIX = "question-wait:";

export function questionWaitStreamId(eventId) {
  return WAIT_STREAM_PREFIX + eventId;
}

export function eventIdOfQuestionWait(streamId) {
  return typeof streamId === "string" && streamId.startsWith(WAIT_STREAM_PREFIX)
    ? streamId.slice(WAIT_STREAM_PREFIX.length)
    : null;
}

/// 倒数到 0 时回给宿主的 waterfall 结局。网关的 rejection 校验只收
/// name/message(必填)与 code/details(可选),多一个键都会整条判废。
export function timedOutOutcome() {
  return {
    kind: "rejected",
    error: {
      name: "UserQuestionError",
      message: "ask_user_question timed out before the user answered",
      code: "ASK_TIMED_OUT"
    }
  };
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/// waterfall 请求里的 wait 字段。缺省 = 阻塞式提问(0.1.x 语义);有 callId 无 timed =
/// 以卡片为键的无限期等待;timed:true 才需要认领与倒计时。
export function questionWait(request) {
  const wait = isObject(request?.wait) ? request.wait : null;
  const callId = typeof wait?.callId === "string" && wait.callId ? wait.callId : null;
  return { callId, timed: Boolean(callId) && wait?.timed === true };
}

/// userQuestions 投影 → {active, settled}。形状不认识时当空集合,解码不能崩。
export function userQuestionsProjection(value) {
  const view = isObject(value) && isObject(value.questions) ? value.questions : value;
  const active = Array.isArray(view?.active) ? view.active : [];
  const settled = Array.isArray(view?.settled) ? view.settled : [];
  return {
    active: active
      .filter((row) => isObject(row) && typeof row.callId === "string")
      .map((row) => ({
        callId: row.callId,
        questions: Array.isArray(row.questions) ? row.questions.filter(isObject) : [],
        state: row.state === "continued" ? "continued" : "open"
      })),
    settled: settled
      .filter((row) => isObject(row) && typeof row.callId === "string")
      .map((row) => ({ callId: row.callId, answers: Array.isArray(row.answers) ? row.answers : [] }))
  };
}

/// 排队行(inbox 投影折出的队列)里已经在等 admit 的迟到回复,按 callId。
export function queuedReplyCalls(queue) {
  const calls = new Set();
  for (const row of queue ?? []) {
    const source = row?.message?.source;
    if (source?.kind === "user-question-reply" && typeof source.callId === "string") calls.add(source.callId);
  }
  return calls;
}

/// 还能从这里回答的 continued 问题(web publishContinuedQuestions):投影里 continued、
/// inbox 里没有排着回复、本端也没刚回答过的行。形状与 waterfall 问题一致,
/// 只是没有 eventId/rpcId,并带 continued:true。
export function continuedQuestions({ sessionId, projection, queue, replied }) {
  const queued = queuedReplyCalls(queue);
  return (projection?.active ?? [])
    .filter((row) => row.state === "continued" && !queued.has(row.callId) && !replied?.has(row.callId))
    .map((row) => ({
      sessionId,
      eventId: null,
      rpcId: null,
      callId: row.callId,
      questions: row.questions,
      continued: true
    }));
}

/// 输入框上方实际要显示的提问:实时 waterfall 优先,否则第一个用户没收起的 continued 问题。
export function presentedQuestion({ pending, continued, hidden }) {
  if (pending) return pending;
  return (continued ?? []).find((question) => !hidden?.has(question.callId)) ?? null;
}

/// 卡片底部的等待状态。返回 null 表示阻塞式提问,什么都不显示。
export function waitStatus(question, now = Date.now()) {
  if (!question) return null;
  if (question.continued) return { kind: "continued" };
  if (Number.isFinite(question.deadline)) {
    return { kind: "countdown", seconds: Math.max(0, Math.ceil((question.deadline - now) / 1000)) };
  }
  if (question.held) return { kind: "held" };
  return null;
}

/// 迟到回复消息(source.kind === "user-question-reply")里的问答对。正文是宿主写的
/// answer_to_pending_question JSON(web replyPairsOf)。读不出来返回 null,调用方显示原文。
export function questionReplyContent(source, content) {
  if (!isObject(source) || source.kind !== "user-question-reply") return null;
  const text = (Array.isArray(content) ? content : [])
    .find((block) => block?.type === "text" && typeof block.text === "string")?.text;
  if (!text) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isObject(value) || !Array.isArray(value.questions)) return null;
  const answers = Array.isArray(value.answers) ? value.answers.filter(isObject) : [];
  const pairs = value.questions
    .filter((question) => isObject(question) && typeof question.id === "string")
    .map((question) => {
      const answer = answers.find((item) => item.id === question.id);
      const values = Array.isArray(answer?.selected) ? answer.selected.filter((label) => typeof label === "string") : [];
      if (typeof answer?.custom === "string" && answer.custom.trim()) values.push(answer.custom.trim());
      return {
        question: typeof question.question === "string" ? question.question : "",
        header: typeof question.header === "string" ? question.header : null,
        answers: values
      };
    });
  return { callId: typeof source.callId === "string" ? source.callId : null, pairs };
}
