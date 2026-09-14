// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  stableCut, renderIncrementalMarkdown, UNSTABLE_TAIL_BLOCKS
} from "../src/features/chat/incremental-markdown.js";

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

describe("stableCut", () => {
  it("保留最后 UNSTABLE_TAIL_BLOCKS 个块为尾部", () => {
    const text = "p1\n\np2\n\np3\n\np4\n";
    const cut = stableCut(text);
    expect(cut).toBe(text.indexOf("p3"));
    expect(text.slice(cut)).toContain("p4");
  });

  it("不足尾部块数时整段不冻结", () => {
    expect(stableCut("a\n\nb")).toBeNull();
    expect(stableCut("solo")).toBeNull();
  });

  it("代码围栏内的空行不算切点", () => {
    const text = "before\n\n\`\`\`\na\n\nb\n\`\`\`\n\nafter";
    // 栏外空行:after "before" 与 after 收尾围栏之后;围栏内的空行必须跳过。
    expect(stableCut(text, 1)).toBe(text.indexOf("after"));
    expect(text.slice(0, stableCut(text, 1)).endsWith("\`\`\`\n\n")).toBe(true);
  });
});

describe("renderIncrementalMarkdown", () => {
  it("追加时冻结前缀 DOM 原地保留", () => {
    const host = mount();
    const first = "para one\n\npara two\n\npara three\n";
    renderIncrementalMarkdown(host, first);
    const head = host.querySelector(".md-head");
    const headChildren = [...head.children];
    expect(headChildren.length).toBeGreaterThan(0);

    renderIncrementalMarkdown(host, first + "para four\n");
    expect(host.querySelector(".md-head")).toBe(head);
    expect([...head.children]).toEqual(headChildren);
    expect(host.querySelector(".md-tail").textContent).toContain("para four");
  });

  it("相同文本重入不重建任何节点", () => {
    const host = mount();
    const text = "a\n\nb\n\nc\n";
    renderIncrementalMarkdown(host, text);
    const tail = host.querySelector(".md-tail");
    const child = tail.firstElementChild;
    renderIncrementalMarkdown(host, text);
    expect(tail.firstElementChild).toBe(child);
  });

  it("默认尾部块数常量与 web 一致", () => {
    expect(UNSTABLE_TAIL_BLOCKS).toBe(2);
  });
});
