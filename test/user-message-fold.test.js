// @vitest-environment jsdom
// 长用户消息在记录流里的实际渲染:气泡只有前 1000 字 + "查看全部",
// 全文只在弹窗里出现,且不常驻 DOM。
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createChatRenderer } from "../src/features/chat/chat-renderer.js";
import { userNode } from "../src/features/sessions/chat-nodes.js";
import { setLang } from "../src/shared/i18n.js";
import { _resetCardDetail } from "../src/features/chat/card-detail.js";
import { FOLD_LIMIT } from "../src/features/chat/long-message.js";

beforeAll(() => setLang("en"));
beforeEach(() => {
  _resetCardDetail();
  document.body.replaceChildren();
});

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

const text = (t) => ({ type: "text", text: t });
const detail = () => document.querySelector("dialog.card-detail");
const detailBody = () => detail()?.querySelector(".card-detail-body");

function renderUser(body) {
  const container = mount();
  const renderer = createChatRenderer(container, {});
  renderer.render([userNode({ seq: 1, time: 1, messageId: "m1", content: [text(body)] })]);
  return container;
}

describe("long user message folding", () => {
  it("renders a short message inline with no view-all affordance", () => {
    const container = renderUser("hello there");
    expect(container.textContent).toContain("hello there");
    expect(container.querySelector(".msg-user-more")).toBeNull();
  });

  it("caps the bubble at the fold limit and offers view-all", () => {
    const long = "A".repeat(FOLD_LIMIT) + "B".repeat(5000);
    const container = renderUser(long);
    const preview = container.querySelector(".msg-user-preview");
    expect(preview).not.toBeNull();
    expect(preview.textContent).toHaveLength(FOLD_LIMIT);
    // 折叠掉的那部分不能出现在气泡里 —— 这正是不卡的原因。
    expect(container.querySelector(".msg-user").textContent).not.toContain("B");
    expect(container.querySelector(".msg-user-more")).not.toBeNull();
  });

  it("puts the full text in the dialog only after the click", () => {
    const long = "A".repeat(FOLD_LIMIT) + "TAILMARK";
    const container = renderUser(long);
    // 点击前弹窗里没有任何正文。
    expect(detailBody()?.textContent ?? "").not.toContain("TAILMARK");

    container.querySelector(".msg-user-more").click();
    expect(detail().open).toBe(true);
    const full = detailBody().querySelector(".msg-full-text");
    expect(full).not.toBeNull();
    // 首片同步渲染,弹窗一开就有内容。
    expect(full.textContent.length).toBeGreaterThan(0);
    expect(long.startsWith(full.textContent)).toBe(true);
  });

  it("clears the full text out of the DOM when the dialog closes", () => {
    const container = renderUser("A".repeat(FOLD_LIMIT + 10));
    container.querySelector(".msg-user-more").click();
    expect(detailBody().querySelector(".msg-full-text")).not.toBeNull();

    const dialog = detail();
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
    expect(detailBody().querySelector(".msg-full-text")).toBeNull();
  });
});
