// @vitest-environment jsdom
// 代码块着色:流式重复渲染是热点路径,未知语言是常态输入 —— 两者都必须安全。
import { describe, it, expect, beforeEach } from "vitest";
import { highlightCodeBlocks } from "../src/features/chat/code-highlight.js";
import { mdToHtml } from "../src/shared/md-to-html.js";

function mount(markdown) {
  const root = document.createElement("div");
  root.innerHTML = mdToHtml(markdown);
  document.body.append(root);
  return root;
}

const codes = (root) => [...root.querySelectorAll("pre[data-language] > code")];

describe("代码块着色", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("已注册语言着上 hljs 的 token 类", async () => {
    const root = mount("\`\`\`javascript\nconst a = 1;\n\`\`\`");
    await highlightCodeBlocks(root);
    expect(codes(root)[0].innerHTML).toContain("hljs-");
    expect(codes(root)[0].dataset.highlighted).toBe("javascript");
  });

  it("语言别名(sh / js / yml)归一到真实语言", async () => {
    for (const [alias, real] of [["sh", "bash"], ["js", "javascript"], ["yml", "yaml"]]) {
      const root = mount(`\`\`\`${alias}\necho hi\n\`\`\``);
      await highlightCodeBlocks(root);
      expect(codes(root)[0].dataset.highlighted, alias).toBe(real);
    }
  });

  it("未知语言不报错,原文保持不变", async () => {
    const root = mount("\`\`\`brainfuck\n+++++\n\`\`\`");
    const before = codes(root)[0].textContent;
    await expect(highlightCodeBlocks(root)).resolves.toBeUndefined();
    expect(codes(root)[0].textContent).toBe(before);
    expect(codes(root)[0].dataset.highlighted).toBe("skipped");
  });

  it("无语言标注(text)不着色", async () => {
    const root = mount("\`\`\`\nplain\n\`\`\`");
    await highlightCodeBlocks(root);
    expect(codes(root)[0].dataset.highlighted).toBe("skipped");
  });

  it("重复调用不重复着色(流式重画的热点路径)", async () => {
    const root = mount("\`\`\`javascript\nconst a = 1;\n\`\`\`");
    await highlightCodeBlocks(root);
    const first = codes(root)[0].innerHTML;
    await highlightCodeBlocks(root);
    // 二次着色会把上一次产出的 <span> 当源码重新扫,结果必然与首次不同。
    expect(codes(root)[0].innerHTML).toBe(first);
  });

  it("流式进行中跳过最后一个代码块(它可能还没写完)", async () => {
    const root = mount("\`\`\`javascript\nconst a = 1;\n\`\`\`\n\n\`\`\`javascript\nconst b =\n\`\`\`");
    await highlightCodeBlocks(root, { streaming: true });
    const all = codes(root);
    expect(all[0].dataset.highlighted).toBe("javascript");
    expect(all[all.length - 1].dataset.highlighted).toBeUndefined();
  });

  it("流结束后补上此前跳过的那个块", async () => {
    const root = mount("\`\`\`javascript\nconst a = 1;\n\`\`\`\n\n\`\`\`javascript\nconst b = 2;\n\`\`\`");
    await highlightCodeBlocks(root, { streaming: true });
    await highlightCodeBlocks(root, { streaming: false });
    expect(codes(root).every((c) => c.dataset.highlighted === "javascript")).toBe(true);
  });

  it("空容器与无代码块的容器都安全返回", async () => {
    await expect(highlightCodeBlocks(null)).resolves.toBeUndefined();
    await expect(highlightCodeBlocks(mount("普通段落"))).resolves.toBeUndefined();
  });

  it("着色不改变代码的可读文本(复制按钮仍拿到原文)", async () => {
    const source = "const a = 1;";
    const root = mount(`\`\`\`javascript\n${source}\n\`\`\``);
    await highlightCodeBlocks(root);
    expect(codes(root)[0].textContent).toBe(source);
  });
});
