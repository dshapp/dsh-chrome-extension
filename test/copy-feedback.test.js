// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { attachCopyFeedback, COPY_FEEDBACK_MS } from "../src/features/chat/copy-feedback.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));
afterEach(() => { vi.useRealTimers(); });

function mount(writeText) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText }, configurable: true
  });
  const button = document.createElement("button");
  button.textContent = "⧉";
  button.title = "Copy";
  attachCopyFeedback(button, () => "hi", { render: (done) => { button.textContent = done ? "✓" : "⧉"; } });
  document.body.append(button);
  return button;
}

describe("attachCopyFeedback", () => {
  it("写入成功才切到 ✓,窗口结束恢复", async () => {
    vi.useFakeTimers();
    let writes = 0;
    const button = mount(async () => { writes += 1; });
    button.click();
    await Promise.resolve();
    expect(button.textContent).toBe("✓");
    expect(button.title).toBe("Copied");
    vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    expect(button.textContent).toBe("⧉");
    expect(button.title).toBe("Copy");
    expect(writes).toBe(1);
  });

  it("反馈窗口内的重复点击不再写剪贴板", async () => {
    vi.useFakeTimers();
    let writes = 0;
    const button = mount(async () => { writes += 1; });
    button.click();
    await Promise.resolve();
    button.click();
    await Promise.resolve();
    expect(writes).toBe(1);
  });

  it("写入失败不切换到 ✓", async () => {
    const button = mount(async () => { throw new Error("denied"); });
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button.textContent).toBe("⧉");
  });
});
