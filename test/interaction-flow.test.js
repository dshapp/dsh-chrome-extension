import { describe, it, expect } from "vitest";
import {
  routePlanReview, classifyQuestions, approveAnswer, reviseAnswer, submitAnswer,
  resolveTakeover, pendingInteractionStatus,
  createQuestionFlow, flowChoose, flowChooseSettling, flowSetCustom, flowSkip,
  flowContinue, flowValidate, flowAnswers, flowPrevious, flowCurrent,
  recommendedLabel, optionShortcutDigit, bashCommand, resolveApprovalPresentation,
  cancelledResult
} from "../src/features/interactions/interaction-flow.js";

const planQuestion = (over = {}) => ({
  id: "q1",
  question: "Ready to implement this plan?",
  detail: "# Plan\n1. do it",
  multiSelect: false,
  intent: { kind: "plan-review", approve: "Approve" },
  options: [{ label: "Approve" }, { label: "Keep planning" }],
  ...over
});

describe("plan-review 路由", () => {
  it("识别合法的计划审阅", () => {
    const review = routePlanReview([planQuestion()]);
    expect(review.plan).toContain("do it");
    expect(review.approve.label).toBe("Approve");
    expect(review.decline.label).toBe("Keep planning");
  });
  it("缺 detail 不是计划审阅", () => {
    expect(routePlanReview([planQuestion({ detail: null })])).toBeNull();
  });
  it("intent 不是 plan-review 则不是", () => {
    expect(routePlanReview([planQuestion({ intent: { kind: "other" } })])).toBeNull();
  });
  it("多选不是", () => {
    expect(routePlanReview([planQuestion({ multiSelect: true })])).toBeNull();
  });
  it("选项超过两个不是", () => {
    expect(routePlanReview([planQuestion({ options: [{ label: "Approve" }, { label: "b" }, { label: "c" }] })])).toBeNull();
  });
  it("选项里没有具名 approve 标签则不是", () => {
    expect(routePlanReview([planQuestion({ options: [{ label: "x" }] })])).toBeNull();
  });
  it("多题不是", () => {
    expect(routePlanReview([planQuestion(), planQuestion({ id: "q2" })])).toBeNull();
  });
  it("只有 approve 一个选项也成立(decline 为 null)", () => {
    const review = routePlanReview([planQuestion({ options: [{ label: "Approve" }] })]);
    expect(review.decline).toBeNull();
  });
  it("classify 与 route 判定一致", () => {
    expect(classifyQuestions([planQuestion()])).toBe("planReview");
    expect(classifyQuestions([planQuestion({ detail: null })])).toBe("question");
  });
});

describe("plan-review 线协议(批准/意见互斥)", () => {
  const review = routePlanReview([planQuestion()]);

  it("批准:selected=[approve] 且 custom 必须为 null", () => {
    // custom 必须被省略而不是发 null(宿主 schema 只接受 string)。
    expect(approveAnswer(review)).toEqual({ id: "q1", selected: ["Approve"] });
    expect("custom" in approveAnswer(review)).toBe(false);
  });

  it("带意见:custom 单独发出,selected 必须为空", () => {
    const a = reviseAnswer(review, "改成 B 方案");
    expect(a.selected).toEqual([]);
    expect(a.custom).toBe("改成 B 方案");
  });

  it("裸拒绝:发 decline 标签,custom 为 null", () => {
    expect(reviseAnswer(review, "")).toEqual({ id: "q1", selected: ["Keep planning"] });
  });

  it("纯空格意见等同裸拒绝", () => {
    expect(reviseAnswer(review, "   ")).toEqual({ id: "q1", selected: ["Keep planning"] });
  });

  it("主按钮:空意见批准,有意见转为反馈", () => {
    expect(submitAnswer(review, "")).toEqual({ id: "q1", selected: ["Approve"] });
    const withNotes = submitAnswer(review, "再想想");
    expect(withNotes.selected).toEqual([]);
    expect(withNotes.custom).toBe("再想想");
  });

  it("任何答案都不会同时带非空 selected 与 custom", () => {
    for (const notes of ["", "  ", "x", "很长的意见"]) {
      for (const a of [submitAnswer(review, notes), reviseAnswer(review, notes)]) {
        expect(a.selected.length > 0 && a.custom != null).toBe(false);
        // 永远不出现 custom: null —— 那会被宿主判 bad-response。
        expect(!("custom" in a) || typeof a.custom === "string").toBe(true);
      }
    }
  });

  it("无 decline 选项时裸拒绝发空 selected(宿主仍读作继续规划)", () => {
    const solo = routePlanReview([planQuestion({ options: [{ label: "Approve" }] })]);
    expect(reviseAnswer(solo, "")).toEqual({ id: "q1", selected: [] });
  });
});

describe("撤销应答契约", () => {
  it("cancelled 必须携带 details(缺了会被判 bad-response)", () => {
    const r = cancelledResult();
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("cancelled");
    // details 是宿主 rpcErrorSchema 每个分支的必填字段。
    expect(r.error.details).toEqual({});
    expect(typeof r.error.message).toBe("string");
  });
});

describe("takeover 与状态分类", () => {
  it("question 优先于 approval", () => {
    const t = resolveTakeover({ question: { questions: [] }, approval: { toolName: "bash" } });
    expect(t.kind).toBe("question");
  });
  it("只有 approval 时取 approval", () => {
    expect(resolveTakeover({ approval: { toolName: "bash" } }).kind).toBe("approval");
  });
  it("都没有则为 null", () => {
    expect(resolveTakeover({})).toBeNull();
  });
  it("pendingInteractionStatus 区分三态", () => {
    expect(pendingInteractionStatus({ approval: {} })).toBe("approval");
    expect(pendingInteractionStatus({ question: { questions: [planQuestion()] } })).toBe("planReview");
    expect(pendingInteractionStatus({ question: { questions: [{ id: "a", question: "?" }] } })).toBe("question");
    expect(pendingInteractionStatus({})).toBeNull();
  });
});

describe("问答向导", () => {
  const two = [
    { id: "a", question: "Q1", options: [{ label: "A1" }, { label: "A2" }] },
    { id: "b", question: "Q2", options: [{ label: "B1" }] }
  ];

  it("单选自动前进到下一题", () => {
    const s = flowChoose(createQuestionFlow(two), "A1");
    expect(s.index).toBe(1);
    expect(s.drafts[0].selected).toEqual(["A1"]);
  });

  it("末题单选结算整批", () => {
    let s = flowChoose(createQuestionFlow(two), "A1");
    const r = flowChooseSettling(s, "B1");
    expect(r.submit).toBe(true);
    expect(flowAnswers(r.state)).toEqual([
      { id: "a", selected: ["A1"] },
      { id: "b", selected: ["B1"] }
    ]);
  });

  it("末题选中但前面有未答题 → 跳回去并给 incomplete", () => {
    // 直接跳到末题(不回答第一题)
    let s = createQuestionFlow(two);
    s = { ...s, index: 1 };
    const r = flowChooseSettling(s, "B1");
    expect(r.submit).toBe(false);
    expect(r.state.index).toBe(0);
    expect(r.state.validation).toBe("incomplete");
  });

  it("多选累加与取消,不自动前进", () => {
    const multi = [{ id: "m", question: "M", multiSelect: true, options: [{ label: "x" }, { label: "y" }] }];
    let s = flowChoose(createQuestionFlow(multi), "x");
    s = flowChoose(s, "y");
    expect(s.drafts[0].selected).toEqual(["x", "y"]);
    expect(s.index).toBe(0);
    s = flowChoose(s, "x");
    expect(s.drafts[0].selected).toEqual(["y"]);
  });

  it("单选题写自由文本会清空选项", () => {
    let s = flowChoose(createQuestionFlow([two[0]]), "A1");
    s = flowSetCustom(s, "我的答案");
    expect(s.drafts[0].selected).toEqual([]);
    expect(flowAnswers(s)).toEqual([{ id: "a", selected: [], custom: "我的答案" }]);
  });

  it("多选题的自由文本与选项共存", () => {
    const multi = [{ id: "m", question: "M", multiSelect: true, options: [{ label: "x" }] }];
    let s = flowChoose(createQuestionFlow(multi), "x");
    s = flowSetCustom(s, "补充");
    expect(flowAnswers(s)).toEqual([{ id: "m", selected: ["x"], custom: "补充" }]);
  });

  it("跳过末题即结算,答案为空", () => {
    let s = flowChoose(createQuestionFlow(two), "A1");
    const r = flowSkip(s);
    expect(r.submit).toBe(true);
    expect(flowAnswers(r.state)[1]).toEqual({ id: "b", selected: [] });
  });

  it("未答就点继续 → unanswered", () => {
    const r = flowContinue(createQuestionFlow(two));
    expect(r.submit).toBe(false);
    expect(r.state.validation).toBe("unanswered");
  });

  it("上一题可回退且清空校验", () => {
    let s = flowChoose(createQuestionFlow(two), "A1");
    s = flowPrevious(s);
    expect(s.index).toBe(0);
    expect(flowCurrent(s).id).toBe("a");
  });

  it("全部完成才放行提交", () => {
    let s = flowChoose(createQuestionFlow(two), "A1");
    expect(flowValidate(s).submit).toBe(false);
    s = flowChoose(s, "B1");
    expect(flowValidate(s).submit).toBe(true);
  });

  it("纯空格的自由文本不算已答", () => {
    const s = flowSetCustom(createQuestionFlow([two[0]]), "   ");
    expect(flowValidate(s).submit).toBe(false);
  });
});

describe("小工具", () => {
  it("剥离推荐后缀", () => {
    expect(recommendedLabel("快速 (Recommended)")).toEqual({ label: "快速", recommended: true });
    expect(recommendedLabel("稳妥（推荐）")).toEqual({ label: "稳妥", recommended: true });
    expect(recommendedLabel("普通")).toEqual({ label: "普通", recommended: false });
  });
  it("数字键只覆盖 1..9", () => {
    expect(optionShortcutDigit(1)).toBe("1");
    expect(optionShortcutDigit(9)).toBe("9");
    expect(optionShortcutDigit(10)).toBeNull();
    expect(optionShortcutDigit(0)).toBeNull();
  });
  it("解析 bash command", () => {
    expect(bashCommand('{"command":"ls"}')).toBe("ls");
    expect(bashCommand("not json")).toBeNull();
    expect(bashCommand('{"x":1}')).toBeNull();
  });
});

describe("审批展示", () => {
  const tFn = (k, p) => (k === "approval.escalation" ? `工具 ${p.tool} 请求越权执行` : k);

  it("bash 未结算调用会解出 command", () => {
    const store = { toolCall: () => ({ argsRaw: '{"command":"rm -rf /"}', result: null }) };
    const p = resolveApprovalPresentation({ toolName: "bash", callId: "c1" }, store, tFn);
    expect(p.command).toBe("rm -rf /");
  });

  it("已结算的调用不再展示 command", () => {
    const store = { toolCall: () => ({ argsRaw: '{"command":"ls"}', result: {} }) };
    expect(resolveApprovalPresentation({ toolName: "bash", callId: "c1" }, store, tFn).command).toBeNull();
  });

  it("非 bash 工具不解析 command", () => {
    const store = { toolCall: () => ({ argsRaw: '{"command":"ls"}', result: null }) };
    expect(resolveApprovalPresentation({ toolName: "write", callId: "c1" }, store, tFn).command).toBeNull();
  });

  it("缺 reason 时回退到越权文案", () => {
    const p = resolveApprovalPresentation({ toolName: "bash" }, null, tFn);
    expect(p.reason).toBe("工具 bash 请求越权执行");
  });

  it("有 reason 时原样使用", () => {
    expect(resolveApprovalPresentation({ toolName: "bash", reason: "自定义" }, null, tFn).reason).toBe("自定义");
  });
});
