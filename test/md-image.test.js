import { describe, it, expect } from "vitest";
import { mdToHtml } from "../src/shared/md-to-html.js";
import { isSafeImageSrc } from "../src/shared/image-src.js";

// Markdown 图片:模型会直接吐 ![](https://…) 或工具结果里的 base64 截图。
// src 是唯一一处"模型可控字符串进入属性位置"的地方,所以白名单单独测。
describe("图片 src 白名单", () => {
  it("放行 https 与四种 base64 位图", () => {
    expect(isSafeImageSrc("https://e.com/a.png")).toBe(true);
    expect(isSafeImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeImageSrc("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(isSafeImageSrc("data:image/webp;base64,UklGRg==")).toBe(true);
  });

  it("拒绝 javascript: 与 vbscript:", () => {
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
    expect(isSafeImageSrc("vbscript:msgbox")).toBe(false);
  });

  it("拒绝 http:(扩展页里是混合内容,会被浏览器拦掉)", () => {
    expect(isSafeImageSrc("http://e.com/a.png")).toBe(false);
  });

  it("拒绝 svg data URI —— SVG 能带 <script>", () => {
    expect(isSafeImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
  });

  it("拒绝 file: / blob: / 相对路径 / 空值", () => {
    expect(isSafeImageSrc("file:///etc/passwd")).toBe(false);
    expect(isSafeImageSrc("blob:https://e.com/x")).toBe(false);
    expect(isSafeImageSrc("./local.png")).toBe(false);
    expect(isSafeImageSrc("")).toBe(false);
  });

  it("拒绝夹了控制字符的伪协议(java\\0script:)", () => {
    expect(isSafeImageSrc("java\u0000script:alert(1)")).toBe(false);
  });
});

describe("Markdown 图片渲染", () => {
  it("https 图片渲染成 <img>,带 alt 与懒加载", () => {
    const html = mdToHtml("![一只猫](https://e.com/cat.png)");
    expect(html).toContain('<img src="https://e.com/cat.png"');
    expect(html).toContain('alt="一只猫"');
    expect(html).toContain('loading="lazy"');
  });

  it("base64 截图渲染成 <img>", () => {
    const html = mdToHtml("![](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("白名单外的地址按字面文本留在正文,不生成标签", () => {
    const html = mdToHtml("![x](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).toContain("![x](javascript:alert(1))");
  });

  it("图片语法不被链接规则吃掉(! 不会落单)", () => {
    const html = mdToHtml("![a](https://e.com/a.png)");
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/!\s*<a/);
  });

  it("alt 里的引号被转义,无法逃逸出属性", () => {
    const html = mdToHtml('![" onerror="alert(1)](https://e.com/a.png)');
    // 引号在 escapeHtml 阶段就成了 &quot;,永远合不拢属性。
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot; onerror=&quot;");
  });

  it("图片与链接可以共存于同一行", () => {
    const html = mdToHtml("![i](https://e.com/i.png) 见 [文档](https://e.com/d)");
    expect(html).toContain("<img src=");
    expect(html).toContain('<a href="https://e.com/d"');
  });

  it("fenced code 里的图片语法不渲染", () => {
    const html = mdToHtml("\`\`\`\n![a](https://e.com/a.png)\n\`\`\`");
    expect(html).not.toContain("<img");
  });
});
