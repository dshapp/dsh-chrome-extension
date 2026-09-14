// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createQuestionCard } from "../src/features/interactions/question-card.js";
import { createApprovalCard } from "../src/features/interactions/approval-card.js";
import { createPlanReviewCard } from "../src/features/interactions/plan-review-card.js";
import { routePlanReview } from "../src/features/interactions/interaction-flow.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

const options = (card) => [...card.querySelectorAll(".question-option-btn")];
// 推荐徽标是 title 的子元素,所以取 title 自身的首个文本节点,而不是整段 textContent。
const labels = (card) => options(card).map((b) => b.querySelector(".question-option-title").firstChild.textContent);
const footerButton = (card, text) =>
  [...card.querySelectorAll(".question-footer button")].find((b) => b.textContent === text);

function single(over = {}) {
  return {
    rpcId: "r1", sessionId: "s1",
    questions: [{ id: "q1", question: "选一个?", options: [{ label: "A" }, { label: "B" }], ...over }]
  };
}
function multiQuestion() {
  return {
    rpcId: "r1", sessionId: "s1",
    questions: [
      { id: "q1", question: "第一题", options: [{ label: "A1" }, { label: "A2" }] },
      { id: "q2", question: "第二题", options: [{ label: "B1" }] }
    ]
  };
}
const answersOf = (call) => call[1].value.answer.answers;
/// 派发 isComposing=true 的 keydown(jsdom 构造器不接收 isComposing,手动补属性)。
function keydownComposing(target, key = "Enter") {
  const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, "isComposing", { value: true, configurable: true });
  target.dispatchEvent(event);
}

describe("问答卡:单题单选", () => {
  it("点击选项即结算整批", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(single(), { onRespond });
    options(card)[0].click();
    await Promise.resolve();
    expect(onRespond).toHaveBeenCalledTimes(1);
    const [rpcId, result] = onRespond.mock.calls[0];
    expect(rpcId).toBe("r1");
    expect(result.value.sessionId).toBe("s1");
    expect(answersOf(onRespond.mock.calls[0])).toEqual([{ id: "q1", selected: ["A"] }]);
  });

  it("数字键选中并提交", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(single(), { onRespond });
    document.body.append(card);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "2", bubbles: true }));
    await Promise.resolve();
    expect(answersOf(onRespond.mock.calls[0])).toEqual([{ id: "q1", selected: ["B"] }]);
    card.dispose();
    card.remove();
  });

  it("剥离推荐后缀但按原始标签作答", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(single({ options: [{ label: "快速 (Recommended)" }] }), { onRespond });
    expect(labels(card)[0]).toBe("快速");
    expect(card.querySelector(".question-option-recommended")).toBeTruthy();
    options(card)[0].click();
    await Promise.resolve();
    // 线上答案必须是原始标签,不能是剥离后的显示文本。
    expect(answersOf(onRespond.mock.calls[0])[0].selected).toEqual(["快速 (Recommended)"]);
  });

  it("自由文本回车提交,且清空选项", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(single(), { onRespond });
    const input = card.querySelector(".question-custom");
    input.value = "我的答案";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(answersOf(onRespond.mock.calls[0])).toEqual([{ id: "q1", selected: [], custom: "我的答案" }]);
  });

  it("自由文本输入法组字确认候选不提交", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(single(), { onRespond });
    const input = card.querySelector(".question-custom");
    keydownComposing(input, "Enter");
    await Promise.resolve();
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("Esc 取消走 cancelled 契约", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(single(), { onRespond });
    card.querySelector(".question-close").click();
    await Promise.resolve();
    const sent = onRespond.mock.calls[0][1];
    expect(sent.ok).toBe(false);
    expect(sent.error.code).toBe("cancelled");
    // details 必填,否则宿主判 bad-response、卡片永远卡住。
    expect(sent.error.details).toEqual({});
  });

  it("回执 accepted:false 时提示并恢复可交互", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: false });
    const card = createQuestionCard(single(), { onRespond });
    options(card)[0].click();
    await Promise.resolve(); await Promise.resolve();
    expect(card.querySelector(".interaction-error").hidden).toBe(false);
    expect(options(card)[0].disabled).toBe(false);
  });
});

describe("问答卡:多题向导", () => {
  it("一次只显示一题,单选自动前进", () => {
    const card = createQuestionCard(multiQuestion(), { onRespond: vi.fn() });
    expect(card.querySelector(".question-card-heading").textContent).toBe("第一题");
    expect(card.querySelector(".question-progress").textContent).toBe("1/2");
    options(card)[0].click();
    expect(card.querySelector(".question-card-heading").textContent).toBe("第二题");
    expect(card.querySelector(".question-progress").textContent).toBe("2/2");
  });

  it("末题选中后提交全部答案", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(multiQuestion(), { onRespond });
    options(card)[0].click();
    options(card)[0].click();
    await Promise.resolve();
    expect(answersOf(onRespond.mock.calls[0])).toEqual([
      { id: "q1", selected: ["A1"] },
      { id: "q2", selected: ["B1"] }
    ]);
  });

  it("可以回到上一题", () => {
    const card = createQuestionCard(multiQuestion(), { onRespond: vi.fn() });
    options(card)[0].click();
    footerButton(card, "Back").click();
    expect(card.querySelector(".question-card-heading").textContent).toBe("第一题");
  });

  it("跳过末题也能结算", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(multiQuestion(), { onRespond });
    options(card)[0].click();
    footerButton(card, "Skip").click();
    await Promise.resolve();
    expect(answersOf(onRespond.mock.calls[0])[1]).toEqual({ id: "q2", selected: [] });
  });
});

describe("问答卡:多选", () => {
  const multiSelect = () => ({
    rpcId: "r1", sessionId: "s1",
    questions: [{ id: "q1", question: "多选", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] }]
  });

  it("勾选累积、再点取消,不自动提交", () => {
    const onRespond = vi.fn();
    const card = createQuestionCard(multiSelect(), { onRespond });
    options(card)[0].click();
    options(card)[1].click();
    expect(onRespond).not.toHaveBeenCalled();
    expect(options(card).filter((b) => b.classList.contains("selected"))).toHaveLength(2);
    options(card)[0].click();
    expect(options(card).filter((b) => b.classList.contains("selected"))).toHaveLength(1);
  });

  it("显式提交按钮发出全部勾选", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createQuestionCard(multiSelect(), { onRespond });
    options(card)[0].click();
    options(card)[1].click();
    footerButton(card, "Submit").click();
    await Promise.resolve();
    expect(answersOf(onRespond.mock.calls[0])[0].selected).toEqual(["X", "Y"]);
  });

  it("未答就提交给出校验提示", () => {
    const onRespond = vi.fn();
    const card = createQuestionCard(multiSelect(), { onRespond });
    footerButton(card, "Submit").click();
    expect(onRespond).not.toHaveBeenCalled();
    expect(card.querySelector(".question-validation")).toBeTruthy();
  });
});

describe("审批卡", () => {
  const approval = { rpcId: "a1", sessionId: "s1", approvalId: "ap1", toolName: "bash", callId: "c1" };

  it("展示 bash 命令并按 allowed-once 应答", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const store = { toolCall: () => ({ argsRaw: '{"command":"rm -rf /tmp/x"}', result: null }) };
    const card = createApprovalCard(approval, { onRespond, store });
    expect(card.querySelector(".approval-command").textContent).toContain("rm -rf /tmp/x");
    card.querySelectorAll("button")[1].click();
    await Promise.resolve();
    expect(onRespond.mock.calls[0][1].value).toEqual({
      sessionId: "s1", approvalId: "ap1", outcome: "allowed-once"
    });
    card.dispose();
  });

  it("拒绝按钮发 rejected", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = createApprovalCard(approval, { onRespond, store: null });
    card.querySelectorAll("button")[0].click();
    await Promise.resolve();
    expect(onRespond.mock.calls[0][1].value.outcome).toBe("rejected");
    card.dispose();
  });

  it("缺 reason 时回退到越权文案", () => {
    const card = createApprovalCard(approval, { onRespond: vi.fn(), store: null });
    expect(card.querySelector(".approval-reason").textContent).toContain("bash");
    card.dispose();
  });
});

describe("计划审阅卡", () => {
  const question = {
    rpcId: "p1", sessionId: "s1",
    questions: [{
      id: "q1", question: "执行这个计划?", detail: "# 计划\n1. 做事",
      multiSelect: false,
      intent: { kind: "plan-review", approve: "Approve" },
      options: [{ label: "Approve" }, { label: "Keep planning" }]
    }]
  };
  const build = (onRespond) =>
    createPlanReviewCard(question, routePlanReview(question.questions), { onRespond });

  it("渲染计划 markdown", () => {
    const card = build(vi.fn());
    expect(card.querySelector(".plan-body h1")).toBeTruthy();
    card.dispose();
  });

  it("空意见时主按钮批准", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = build(onRespond);
    card.querySelector(".btn.primary").click();
    await Promise.resolve();
    expect(answersOf(onRespond.mock.calls[0])).toEqual([{ id: "q1", selected: ["Approve"] }]);
    card.dispose();
  });

  it("写了意见后主按钮改为提交意见,且不再是批准", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = build(onRespond);
    const input = card.querySelector(".plan-feedback");
    input.value = "换个方案";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(card.querySelector(".btn.primary").textContent).toBe("Submit Notes");
    card.querySelector(".btn.primary").click();
    await Promise.resolve();
    const answer = answersOf(onRespond.mock.calls[0])[0];
    expect(answer).toEqual({ id: "q1", selected: [], custom: "换个方案" });
    card.dispose();
  });

  it("反馈框输入法组字确认候选不触发提交/批准", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = build(onRespond);
    const input = card.querySelector(".plan-feedback");
    input.value = "换个方案";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    keydownComposing(input, "Enter");
    await Promise.resolve();
    expect(onRespond).not.toHaveBeenCalled();
    card.dispose();
  });

  it("裸「修改」发 decline 标签", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = build(onRespond);
    [...card.querySelectorAll(".plan-actions button")].find((b) => b.textContent === "Revise").click();
    await Promise.resolve();
    expect(answersOf(onRespond.mock.calls[0])).toEqual([{ id: "q1", selected: ["Keep planning"] }]);
    card.dispose();
  });

  it("✕ 撤销走 cancelled", async () => {
    const onRespond = vi.fn().mockResolvedValue({ accepted: true });
    const card = build(onRespond);
    [...card.querySelectorAll(".plan-strip-btn")][1].click();
    await Promise.resolve();
    expect(onRespond.mock.calls[0][1].ok).toBe(false);
    card.dispose();
  });
});
