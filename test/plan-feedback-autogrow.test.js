// @vitest-environment jsdom
// 对齐 dsh-macapp b841912:计划卡的修订备注输入框按行自动增高。
//
// 原来是单行 <input type="text">,输入多行意见时只看得见一行。Mac 端改成
// TextField(axis:.vertical) + lineLimit(1...5);Web 的对应物是 textarea
// rows=1 + 按 scrollHeight 增高,5 行封顶后内部滚动。
//
// 关键约束(与 Mac 注释同源):Return 必须仍然提交,换行走 Shift/Alt-Return。
// textarea 默认会把 Return 当换行吃掉,所以键盘处理必须显式区分。
import { describe, expect, it, vi } from "vitest";
import { createPlanReviewCard } from "../src/features/interactions/plan-review-card.js";

const review = {
  question: "Ready?",
  plan: "# Plan\n1. do it",
  approve: { label: "Approve", description: "go" },
  decline: { label: "Keep planning", description: "revise" }
};

function mount() {
  const onRespond = vi.fn().mockResolvedValue({ accepted: true });
  const card = createPlanReviewCard({ rpcId: "r1", sessionId: "s1" }, review, { onRespond });
  document.body.replaceChildren(card);
  return { card, onRespond, field: card.querySelector(".plan-feedback") };
}

describe("计划卡修订备注输入框", () => {
  it("是多行 textarea 而不是单行 input,起始一行", () => {
    const { field } = mount();
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.rows).toBe(1);
  });

  it("随内容增高,并在 5 行封顶后转为内部滚动", () => {
    const { field } = mount();
    // jsdom 不做布局,scrollHeight 恒为 0;用可控的行高桩模拟逐行增长。
    let lines = 1;
    Object.defineProperty(field, "scrollHeight", { get: () => lines * 20 });
    field.style.lineHeight = "20px";

    lines = 3;
    field.dispatchEvent(new Event("input"));
    const atThree = parseFloat(field.style.height);
    expect(atThree).toBeCloseTo(60, 0);

    lines = 9;                                  // 远超上限
    field.dispatchEvent(new Event("input"));
    const capped = parseFloat(field.style.height);
    expect(capped).toBeCloseTo(100, 0);         // 5 行 × 20px
    expect(capped).toBeLessThan(9 * 20);
    expect(field.style.overflowY).toBe("auto");
  });

  it("Return 仍然提交,不插入换行", () => {
    const { field, onRespond } = mount();
    field.value = "please tighten step 2";
    field.dispatchEvent(new Event("input"));
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it("Shift-Return 与 Alt-Return 换行,不提交", () => {
    const { field, onRespond } = mount();
    for (const mod of [{ shiftKey: true }, { altKey: true }]) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...mod });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onRespond).not.toHaveBeenCalled();
  });
});
