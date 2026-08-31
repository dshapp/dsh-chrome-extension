// 问答卡:逐题向导。对齐 macos/.../ComposerOverlays.swift 的 QuestionFlow
// 与 State/ComposerFlow.swift 的 QuestionFlowState。
//
// 与旧版一次性平铺全部问题的关键差别:一次只显示一题,单选自动前进,
// 末题单选直接结算整批,提交前做整批校验并跳回第一个未完成的题。
// 状态机是纯的(interaction-flow.js),这里只负责把它画出来。
import { t } from "../../shared/i18n.js";
import { getToolIconSvg } from "../chat/tool-presentation.js";
import {
  createQuestionFlow, flowCurrent, flowDraft, flowIsFirst, flowIsLast,
  flowChooseSettling, flowSetCustom, flowSkip, flowContinue, flowPrevious,
  flowAnswers, recommendedLabel, optionShortcutDigit, cancelledResult
} from "./interaction-flow.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createQuestionCard(question, { onRespond }) {
  const questions = question.questions ?? [];
  const card = el("article", "question-card");
  let flow = createQuestionFlow(questions);
  let busy = false;

  // ---- 头部 ----
  const header = el("header", "question-card-header");
  const icon = el("span", "question-card-icon");
  icon.innerHTML = getToolIconSvg("askQuestion");
  const heading = el("h3", "question-card-heading");
  const progress = el("span", "question-progress");
  const close = el("button", "question-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", t("question.close"));
  close.addEventListener("click", cancel);
  header.append(icon, heading, progress, close);

  const bodyEl = el("form", "question-form");
  bodyEl.addEventListener("submit", (event) => event.preventDefault());
  const errorLine = el("div", "interaction-error");
  errorLine.hidden = true;

  card.append(header, bodyEl, errorLine);

  function setBusy(next) {
    busy = next;
    for (const node of card.querySelectorAll("button, input")) node.disabled = next;
  }

  async function respond(result) {
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

  function submit() {
    respond({
      ok: true,
      value: { sessionId: question.sessionId, answer: { answers: flowAnswers(flow) } }
    });
  }

  function cancel() {
    respond(cancelledResult());
  }

  /// 把向导操作的结果落地:要么提交,要么重绘到新状态。
  function settle(result) {
    flow = result.state;
    if (result.submit) submit();
    else render();
  }

  function choose(label) {
    settle(flowChooseSettling(flow, label));
  }

  function render() {
    const item = flowCurrent(flow);
    const draft = flowDraft(flow);
    if (!item || !draft) return;

    heading.textContent = item.question || t("question.title");
    progress.textContent = questions.length > 1
      ? t("question.progress", { index: String(flow.index + 1), total: String(questions.length) })
      : "";
    progress.hidden = questions.length <= 1;

    bodyEl.replaceChildren();
    const row = el("div", "question-row");
    if (item.header) row.append(el("div", "question-row-header", item.header));
    if (item.detail) row.append(el("div", "question-row-detail", item.detail));

    // ---- 选项 ----
    const options = el("div", "question-options");
    (item.options ?? []).forEach((option, index) => {
      const { label, recommended } = recommendedLabel(option.label);
      const button = el("button", "question-option-btn");
      button.type = "button";
      const selected = draft.selected.includes(option.label);
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("selected", selected);

      const digit = optionShortcutDigit(index + 1);
      button.append(el("span", "question-option-key", digit ?? ""));

      const copy = el("span", "question-option-copy");
      const title = el("span", "question-option-title", label);
      if (recommended) {
        title.classList.add("recommended");
        title.append(el("span", "question-option-recommended", t("question.recommended")));
      }
      copy.append(title);
      if (option.description) copy.append(el("span", "question-option-desc", option.description));
      button.append(copy, el("span", "question-option-arrow", item.multiSelect ? "" : "→"));
      button.addEventListener("click", () => choose(option.label));
      options.append(button);
    });
    row.append(options);

    // ---- 自由文本 ----
    const custom = document.createElement("input");
    custom.type = "text";
    custom.className = "question-custom";
    custom.placeholder = t("question.other");
    custom.value = draft.custom;
    custom.setAttribute("aria-label", t("question.otherLabel", { question: item.question }));
    // 每次按键都写回状态机:提交时读的是它,不能等到 blur。
    custom.addEventListener("input", () => { flow = flowSetCustom(flow, custom.value); syncFooter(); });
    custom.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return; // 组字确认候选不推进
      event.preventDefault();
      settle(flowContinue(flow));
    });
    // 包一层单元格,左侧补一个 ✎ 号与选项行的圆号栏对齐(纯装饰,不参与取值)。
    const customCell = el("div", "question-custom-cell");
    const pencil = el("span", "question-custom-key", "✎");
    pencil.setAttribute("aria-hidden", "true");
    customCell.append(pencil, custom);
    row.append(customCell);

    if (flow.validation) {
      row.append(el("div", "question-validation",
        flow.validation === "unanswered" ? t("question.unanswered") : t("question.incomplete")));
    }
    bodyEl.append(row);

    // ---- 底部导航 ----
    const footer = el("div", "question-footer");
    if (!flowIsFirst(flow)) {
      const back = el("button", "btn ghost", t("question.back"));
      back.type = "button";
      back.addEventListener("click", () => { flow = flowPrevious(flow); render(); });
      footer.append(back);
    }
    footer.append(el("span", "interaction-spacer"));
    const skip = el("button", "btn ghost", t("question.skip"));
    skip.type = "button";
    skip.addEventListener("click", () => settle(flowSkip(flow)));
    footer.append(skip);
    // 多选或多题需要一个显式的推进按钮;单题单选靠点选项即结算。
    const needsAdvance = item.multiSelect === true || !flowIsLast(flow) || (item.options ?? []).length === 0;
    if (needsAdvance) {
      const next = el("button", "btn primary", flowIsLast(flow) ? t("question.submit") : t("question.next"));
      next.type = "button";
      next.addEventListener("click", () => settle(flowContinue(flow)));
      footer.append(next);
    }
    bodyEl.append(footer);
  }

  /// 自由文本变化时只需要刷新底部按钮的可用性语义,不必重绘整题(会丢焦点)。
  function syncFooter() { /* 目前底部按钮始终可点,校验在点击时进行 */ }

  // ---- 键盘 ----
  function handleShortcut(event) {
    if (busy) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const item = flowCurrent(flow);
    if (!item) return;
    if (/^[1-9]$/.test(event.key)) {
      const option = (item.options ?? [])[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        choose(option.label);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      settle(flowContinue(flow));
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }
  card.addEventListener("keydown", handleShortcut);
  function onDocumentKeyDown(event) {
    if (!card.isConnected || card.contains(event.target)) return;
    handleShortcut(event);
  }
  document.addEventListener("keydown", onDocumentKeyDown, true);
  card.dispose = () => document.removeEventListener("keydown", onDocumentKeyDown, true);

  render();
  queueMicrotask(() => card.querySelector(".question-option-btn, .question-custom")?.focus());
  return card;
}
