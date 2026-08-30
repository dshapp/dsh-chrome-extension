import { describe, it, expect } from "vitest";
import { mdToHtml } from "../src/shared/md-to-html.js";
import { autoLinkUrls } from "../src/shared/auto-link.js";

// 聊天区里模型常直接吐裸 URL(不带 markdown 链接语法),需自动成链。
describe("裸 URL 自动探测", () => {
  it("散文里的裸 URL 转成链接", () => {
    const html = mdToHtml("详见 https://example.com/docs 谢谢");
    expect(html).toContain('<a href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("http 与 https 都识别,一行多个各自成链", () => {
    const html = mdToHtml("a https://a.com b http://b.com/c");
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it("保留查询串里的 &(转义为 &amp; 但不截断)", () => {
    const html = mdToHtml("见 https://e.com/a?b=1&c=2 结束");
    expect(html).toContain('href="https://e.com/a?b=1&amp;c=2"');
  });

  it("已有 markdown 链接不被二次改写", () => {
    const html = mdToHtml("[link](https://example.com)");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(">link</a>");
  });

  it("行内 code 里的 URL 保持代码样态", () => {
    const html = mdToHtml("\`https://example.com\`");
    expect(html).toContain("<code>https://example.com</code>");
    expect(html).not.toContain("<a ");
  });

  it("fenced code 里的 URL 不成链", () => {
    const html = mdToHtml("\`\`\`\nhttps://example.com\n\`\`\`");
    expect(html).not.toContain("<a ");
  });

  it("剪掉紧贴地址的句尾标点,标点仍留在正文", () => {
    const html = mdToHtml("打开 https://example.com/p. 然后");
    expect(html).toContain('href="https://example.com/p"');
    expect(html).toContain("</a>. 然后");
  });

  it("不把包裹用的右括号吞进地址", () => {
    const html = mdToHtml("(https://example.com/x)");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain("</a>)");
  });

  it("遇 CJK 全角标点即停", () => {
    const html = mdToHtml("见 https://example.com/a。下一句");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain("。下一句");
  });

  it("表格单元格内的裸 URL 也成链", () => {
    const html = mdToHtml("| 名 | 链接 |\n| --- | --- |\n| a | https://e.com/x |");
    expect(html).toContain('<td><a href="https://e.com/x"');
  });

  it("不注入 HTML:URL 里的尖括号已被转义,无法逃逸出属性", () => {
    const html = mdToHtml('https://e.com/"><img src=x>');
    expect(html).not.toContain("<img");
  });

  it("autoLinkUrls 对无 URL 文本保持原样", () => {
    expect(autoLinkUrls("普通文本")).toBe("普通文本");
  });
});
