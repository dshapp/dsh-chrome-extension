// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mountFindBar } from "../src/features/chat/find-in-chat.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

function build() {
  const root = document.createElement("div");
  root.innerHTML = `<div id="root"><p>alpha beta</p><p>Alpha gamma</p><span>beta tail</span></div>`;
  document.body.append(root);
  const bar = document.createElement("div");
  bar.dataset.findSkip = "1";
  const input = document.createElement("input");
  const count = document.createElement("span");
  const prev = document.createElement("button");
  const next = document.createElement("button");
  const close = document.createElement("button");
  bar.append(input, count, prev, next, close);
  document.body.append(bar);
  const find = mountFindBar({ bar, input, count, prev, next, close }, { getRoot: () => root.querySelector("#root") });
  return { root, input, count, prev, next, close, find };
}

beforeEach(() => { document.body.replaceChildren(); });

describe("mountFindBar", () => {
  it("输入即时高亮,大小写不敏感,计数正确", () => {
    const { input, count, find } = build();
    find.open();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("mark.find-hit")).toHaveLength(2);
    expect(count.textContent).toBe("1/2");
  });

  it("下一项/上一项循环并更新 current", () => {
    const { input, next, prev, find } = build();
    find.open();
    input.value = "beta";
    input.dispatchEvent(new Event("input"));
    const marks = [...document.querySelectorAll("mark.find-hit")];
    expect(marks[0].classList.contains("current")).toBe(true);
    next.click();
    expect(document.querySelectorAll("mark.find-hit")[1].classList.contains("current")).toBe(true);
    next.click();
    expect(document.querySelectorAll("mark.find-hit")[0].classList.contains("current")).toBe(true);
    prev.click();
    expect(document.querySelectorAll("mark.find-hit")[1].classList.contains("current")).toBe(true);
  });

  it("关闭后还原文本节点,不再有标记", () => {
    const { root, input, find } = build();
    find.open();
    input.value = "gamma";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("mark.find-hit")).toHaveLength(1);
    find.close();
    expect(document.querySelectorAll("mark.find-hit")).toHaveLength(0);
    expect(root.textContent).toContain("Alpha gamma");
  });

  it("detach 单独调用也能还原", () => {
    const { input, find } = build();
    find.open();
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));
    find.detach();
    expect(document.querySelectorAll("mark.find-hit")).toHaveLength(0);
  });

  it("无匹配时显示无结果", () => {
    const { input, count, find } = build();
    find.open();
    input.value = "zzz";
    input.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("No results");
  });
});
