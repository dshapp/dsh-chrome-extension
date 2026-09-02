// @vitest-environment jsdom
// 端到端:一条同时含图片、公式、代码块的消息,走真实的 renderMarkdownInto。
// 这条测试的价值在于它跨过了模块边界 —— 各自单测都过、合起来相互踩坏的情况
// (数学吃掉代码里的 $、auto-link 改写 KaTeX 输出)只有在这里才暴露。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderMarkdownInto } from "../src/features/chat/chat-view.js";

const MESSAGE = [
  "先看图:",
  "",
  "![示意](https://e.com/a.png)",
  "",
  "公式 $E=mc^2$ 与块级:",
  "",
  "$$\\sum_{i=1}^n i$$",
  "",
  "代码:",
  "",
  "\`\`\`javascript",
  "const price = 100; // $100",
  "\`\`\`",
  "",
  "环境变量 \`$PATH\` 与链接 https://e.com/docs"
].join("\n");

describe("图片 + 公式 + 代码 混排", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    globalThis.katex = {
      renderToString: (tex, opts) =>
        `<span class="katex" data-display="${opts.displayMode}">${tex}</span>`
    };
  });
  afterEach(() => { delete globalThis.katex; });

  it("四种元素同时正确渲染,互不干扰", async () => {
    const body = document.createElement("div");
    body.className = "msg-agent";
    document.body.append(body);
    renderMarkdownInto(body, MESSAGE);
    // 等着色那一步的动态 import 落地。
    await new Promise((r) => setTimeout(r, 50));

    // 图片
    const img = body.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://e.com/a.png");
    expect(img?.getAttribute("alt")).toBe("示意");

    // 行内与块级公式各一
    const formulas = body.querySelectorAll(".katex");
    expect(formulas.length).toBe(2);
    expect([...formulas].some((n) => n.dataset.display === "true")).toBe(true);

    // 代码块着上色,且原文可读(复制按钮拿的是 textContent)
    const code = body.querySelector("pre[data-language] > code");
    expect(code?.textContent).toContain("const price = 100;");
    expect(code?.dataset.highlighted).toBe("javascript");

    // 代码块注释里的 $100 没有被当成公式吃掉
    expect(code?.textContent).toContain("// $100");

    // 行内 code 里的 $PATH 保持原样
    expect([...body.querySelectorAll("code")].some((n) => n.textContent === "$PATH")).toBe(true);

    // 裸 URL 成链
    expect(body.querySelector('a[href="https://e.com/docs"]')).toBeTruthy();
  });

  it("KaTeX 缺席时其余三样照常工作,公式降级为原文", async () => {
    delete globalThis.katex;
    const body = document.createElement("div");
    document.body.append(body);
    renderMarkdownInto(body, MESSAGE);
    await new Promise((r) => setTimeout(r, 50));

    expect(body.querySelector("img")).toBeTruthy();
    expect(body.querySelector("pre[data-language] > code")?.dataset.highlighted).toBe("javascript");
    expect(body.textContent).toContain("$E=mc^2$");
  });
});
