// @vitest-environment jsdom
// 排队面板:对齐 Mac 端 QueueDock 的行结构与编辑/插队语义。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createQueuePanel, editableText } from "../src/features/prompt-queue/queue-panel.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

const text = (t) => ({ type: "text", text: t });
const item = (id, over = {}) => ({ id, placement: "queued", message: { content: [text(`msg ${id}`)] }, ...over });
const mount = (items, opts = {}) => {
  const panel = createQueuePanel(items, { onAction: vi.fn(), ...opts });
  document.body.append(panel);
  return panel;
};
const titles = (panel) => [...panel.querySelectorAll(".queue-btn")].map((b) => b.title);

describe("editableText", () => {
  it("纯文本块可编辑,多块用换行拼接", () => {
    expect(editableText({ content: [text("a"), text("b")] })).toBe("a\nb");
  });
  it("空内容、非文本块、空串都不可编辑", () => {
    expect(editableText({ content: [] })).toBeNull();
    expect(editableText({ content: [{ type: "image", url: "x" }] })).toBeNull();
    expect(editableText({ content: [text("")] })).toBeNull();
  });
});

describe("排队面板渲染", () => {
  it("空队列整块隐藏", () => {
    expect(mount([]).hidden).toBe(true);
    expect(mount(null).hidden).toBe(true);
  });

  it("每条一行,没有计数头", () => {
    const panel = mount([item("a"), item("b")]);
    expect(panel.hidden).toBe(false);
    expect(panel.querySelectorAll(".queue-row")).toHaveLength(2);
    expect(panel.querySelector(".queue-head")).toBeNull();
    expect(panel.querySelector(".queue-count")).toBeNull();
  });

  it("只渲染 queued,steering/context 不入列", () => {
    const panel = mount([item("a"), item("b", { placement: "steering" }), item("c", { placement: "context" })]);
    expect(panel.querySelectorAll(".queue-row")).toHaveLength(1);
    expect(panel.querySelector(".queue-text").textContent).toBe("msg a");
  });

  it("预览文本单行并挂完整内容为 title", () => {
    const panel = mount([item("a")]);
    expect(panel.querySelector(".queue-text").title).toBe("msg a");
  });

  it("子代理会话只读:不渲染任何动作", () => {
    const panel = mount([item("a")], { mutable: false });
    expect(panel.querySelector(".queue-actions")).toBeNull();
  });
});

describe("插队可用性", () => {
  it("运行中才可插队,否则禁用并说明原因", () => {
    const idle = mount([item("a")], { running: false });
    const steerIdle = idle.querySelector('[data-action="steer"]');
    expect(steerIdle.disabled).toBe(true);
    expect(steerIdle.title).toBe("Available while the agent is running");

    const live = mount([item("a")], { running: true });
    const steerLive = live.querySelector('[data-action="steer"]');
    expect(steerLive.disabled).toBe(false);
    expect(steerLive.title).toBe("Run next");
  });

  it("非纯文本条目禁用编辑,但仍可删除", () => {
    const panel = mount([item("a", { message: { content: [{ type: "image", url: "x" }] } })]);
    expect(panel.querySelector('[data-action="edit"]').disabled).toBe(true);
    expect(panel.querySelector('[data-action="remove"]').disabled).toBe(false);
  });
});

describe("动作派发", () => {
  it("删除/插队发出对应 action", async () => {
    const onAction = vi.fn().mockResolvedValue();
    const panel = mount([item("a")], { onAction, running: true });
    panel.querySelector('[data-action="remove"]').click();
    expect(onAction).toHaveBeenCalledWith("a", "remove");
    await Promise.resolve();
    panel.querySelector('[data-action="steer"]').click();
    expect(onAction).toHaveBeenCalledWith("a", "steer");
  });

  it("请求在飞时该行压暗,期间不再重复派发", async () => {
    let release;
    const onAction = vi.fn(() => new Promise((r) => { release = r; }));
    const panel = mount([item("a")], { onAction });
    panel.querySelector('[data-action="remove"]').click();
    expect(panel.querySelector(".queue-row").classList.contains("is-busy")).toBe(true);
    panel.querySelector('[data-action="remove"]')?.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(panel.querySelector(".queue-row").classList.contains("is-busy")).toBe(false);
  });
});

describe("行内编辑", () => {
  it("点编辑换成输入框并预填原文", () => {
    const panel = mount([item("a")]);
    panel.querySelector('[data-action="edit"]').click();
    expect(panel.querySelector(".queue-edit-input").value).toBe("msg a");
    expect(titles(panel)).toEqual(["Save", "Cancel"]);
  });

  it("Enter 保存为 edit action,内容包成文本块", async () => {
    const onAction = vi.fn().mockResolvedValue();
    const panel = mount([item("a")], { onAction });
    panel.querySelector('[data-action="edit"]').click();
    const input = panel.querySelector(".queue-edit-input");
    input.value = "改过了";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onAction).toHaveBeenCalledWith("a", { kind: "edit", text: "改过了" });
  });

  it("Escape 与取消都退出编辑且不派发", () => {
    const onAction = vi.fn();
    const panel = mount([item("a")], { onAction });
    panel.querySelector('[data-action="edit"]').click();
    panel.querySelector(".queue-edit-input")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.querySelector(".queue-edit-input")).toBeNull();

    panel.querySelector('[data-action="edit"]').click();
    panel.querySelector('[data-action="cancel"]').click();
    expect(panel.querySelector(".queue-edit-input")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("空白内容不提交", () => {
    const onAction = vi.fn();
    const panel = mount([item("a")], { onAction });
    panel.querySelector('[data-action="edit"]').click();
    panel.querySelector(".queue-edit-input").value = "   ";
    panel.querySelector('[data-action="save"]').click();
    expect(onAction).not.toHaveBeenCalled();
  });
});
