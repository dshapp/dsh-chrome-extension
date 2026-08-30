// 计划审阅卡。对齐 macos/.../ComposerOverlays.swift 的 PlanReviewPanel。
//
// 布局:琥珀条(标题 + 复制 + ✕ 去聊天里说)/ 计划 markdown 滚动体 /
//      底部 [修改意见输入框][修改][确认执行]。
//
// 线协议见 interaction-flow.js:批准与意见**互斥**,主按钮据输入框内容二选一。
import { t } from "../../shared/i18n.js";
import { mdToHtml } from "../../shared/md-to-html.js";
import { routePlanReview, submitAnswer, reviseAnswer, cancelledResult } from "./interaction-flow.js";
import { decorateCodeBlocks } from "../chat/chat-view.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(className, label, glyph) {
  const button = el("button", className);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = glyph;
  return button;
}

export function createPlanReviewCard(question, review, { onRespond }) {
  const card = el("article", "plan-card");
  let busy = false;

  // ---- 琥珀条 ----
  const strip = el("header", "interaction-strip plan-strip");
  const copy = iconButton("plan-strip-btn", t("plan.copy"), "⧉");
  const discuss = iconButton("plan-strip-btn", t("plan.discuss"), "×");
  strip.append(
    el("span", "interaction-dot"),
    el("span", "interaction-strip-label", t("plan.header")),
    el("span", "interaction-spacer"),
    copy, discuss
  );

  copy.addEventListener("click", async () => {
    // 复制计划 markdown 原文——与正文渲染同源,所以剪贴板拿到的是文档而非渲染后的文字。
    try { await navigator.clipboard.writeText(review.plan); } catch { /* 剪贴板不可用时静默 */ }
    copy.textContent = "✓";
    setTimeout(() => { copy.textContent = "⧉"; }, 1500);
  });

  // ---- 计划正文 ----
  const planBody = el("div", "plan-body");
  planBody.innerHTML = mdToHtml(review.plan);
  decorateCodeBlocks(planBody);

  // ---- 操作行 ----
  const footer = el("div", "plan-footer");
  const errorLine = el("div", "interaction-error");
  errorLine.hidden = true;

  const row = el("div", "plan-actions");
  const feedback = document.createElement("input");
  feedback.type = "text";
  feedback.className = "plan-feedback";
  feedback.placeholder = t("plan.feedbackPlaceholder");
  // 不自动聚焦:Enter 属于默认的「确认执行」按钮,把焦点放进单行输入框会
  // 让这个按键被输入框吃掉。
  const revise = el("button", "btn", t("plan.decline"));
  revise.type = "button";
  revise.title = review.decline?.description ?? "";
  const approve = el("button", "btn primary", t("plan.approve"));
  approve.type = "button";
  approve.title = review.approve.description ?? "";
  row.append(feedback, revise, approve);
  footer.append(errorLine, row);

  function hasFeedback() {
    return feedback.value.trim() !== "";
  }

  // 主按钮标题随输入框内容切换,这样按钮永远不会承诺一个它不会启动的执行。
  function syncPrimary() {
    const notes = hasFeedback();
    approve.textContent = notes ? t("plan.approveWithNotes") : t("plan.approve");
    approve.title = notes ? t("plan.approveWithNotesHelp") : (review.approve.description ?? "");
  }
  feedback.addEventListener("input", syncPrimary);
  syncPrimary();

  function setBusy(next) {
    busy = next;
    for (const node of [feedback, revise, approve, discuss]) node.disabled = next;
  }

  async function settle(result) {
    if (busy) return;
    setBusy(true);
    errorLine.hidden = true;
    try {
      const receipt = await onRespond(question.rpcId, result);
      setBusy(false);
      if (receipt && receipt.accepted === false) {
        errorLine.textContent = t("interaction.notAccepted");
        errorLine.hidden = false;
      }
    } catch (error) {
      setBusy(false);
      errorLine.textContent = error?.message || String(error);
      errorLine.hidden = false;
    }
  }

  const answerWith = (answer) => settle({
    ok: true,
    value: { sessionId: question.sessionId, answer: { answers: [answer] } }
  });

  // 主按钮:空意见 → 批准并退出计划模式;有意见 → 作为「继续规划」反馈发出。
  // 批准与意见不能共存于一个答案(见 submitAnswer),而执行一份审阅者刚要求
  // 修改的计划是两者中更糟的那个。
  approve.addEventListener("click", () => answerWith(submitAnswer(review, feedback.value)));
  revise.addEventListener("click", () => answerWith(reviseAnswer(review, feedback.value)));
  // ✕ 撤销审阅,回到输入框去说——宿主把撤销读作"用户要用这两个选项之外的话接话"。
  discuss.addEventListener("click", () => settle(cancelledResult()));

  function onKeyDown(event) {
    if (busy) return;
    if (event.key === "Escape") {
      event.preventDefault();
      discuss.click();
      return;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // 输入框里的 Enter 也提交(此时主按钮已是「提交修改」)。
      event.preventDefault();
      approve.click();
      return;
    }
    if (event.key.toLowerCase() === "d" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      revise.click();
    }
  }
  card.addEventListener("keydown", onKeyDown);
  function onDocumentKeyDown(event) {
    if (!card.isConnected || card.contains(event.target)) return;
    onKeyDown(event);
  }
  document.addEventListener("keydown", onDocumentKeyDown, true);
  card.dispose = () => document.removeEventListener("keydown", onDocumentKeyDown, true);

  card.append(strip, planBody, footer);
  card.setAttribute("aria-label", review.question);
  queueMicrotask(() => approve.focus());
  return card;
}

/// 便捷入口:是计划审阅则返回卡片,否则返回 null(交给通用问答卡)。
export function tryCreatePlanReviewCard(question, handlers) {
  const review = routePlanReview(question.questions ?? []);
  return review ? createPlanReviewCard(question, review, handlers) : null;
}
