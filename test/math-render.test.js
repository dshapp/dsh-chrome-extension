import { describe, it, expect, afterEach } from "vitest";
import { splitMathSegments, renderMath } from "../src/shared/math-render.js";
import { mdToHtml } from "../src/shared/md-to-html.js";

// 输入是 escapeHtml 之后的文本,所以测试里也用转义态喂它。
describe("数学段切分", () => {
  it("识别行内 $…$", () => {
    const segs = splitMathSegments("设 $E=mc^2$ 成立");
    expect(segs.map((s) => s.kind)).toEqual(["text", "math", "text"]);
    expect(segs[1].value).toBe("E=mc^2");
    expect(segs[1].display).toBe(false);
  });

  it("识别块级 $$…$$ 并标记 display", () => {
    const segs = splitMathSegments("$$\\int_0^1 x dx$$");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("math");
    expect(segs[0].display).toBe(true);
  });

  it("货币金额不被当成公式", () => {
    for (const input of ["价格 $5 和 $10", "$ 100 起", "共 100 $"]) {
      expect(splitMathSegments(input).every((s) => s.kind === "text"), input).toBe(true);
    }
  });

  it("紧跟数字的 $ 不开公式(5$x$)", () => {
    expect(splitMathSegments("5$x$").every((s) => s.kind === "text")).toBe(true);
  });

  it("行内公式不跨行", () => {
    expect(splitMathSegments("$a\nb$").every((s) => s.kind === "text")).toBe(true);
  });

  it("转义的 \\$ 是字面美元符,不参与配对", () => {
    expect(splitMathSegments("\\$5 与 \\$9").every((s) => s.kind === "text")).toBe(true);
  });

  it("没有闭合符时按普通文本处理", () => {
    expect(splitMathSegments("单独一个 $ 符号").every((s) => s.kind === "text")).toBe(true);
  });

  it("空公式不成段", () => {
    expect(splitMathSegments("$$").every((s) => s.kind === "text")).toBe(true);
  });
});

describe("KaTeX 缺席时的降级", () => {
  afterEach(() => { delete globalThis.katex; });

  it("未加载 KaTeX 时 renderMath 返回 null", () => {
    delete globalThis.katex;
    expect(renderMath("x^2", {})).toBeNull();
  });

  it("未加载时公式在正文里保持原样,不丢内容", () => {
    delete globalThis.katex;
    const html = mdToHtml("设 $E=mc^2$ 成立");
    expect(html).toContain("$E=mc^2$");
  });

  it("KaTeX 抛错时也降级为 null,不冒泡", () => {
    globalThis.katex = { renderToString() { throw new Error("boom"); } };
    expect(renderMath("\\bad", {})).toBeNull();
  });
});

describe("接入 md-to-html", () => {
  afterEach(() => { delete globalThis.katex; });

  it("公式段交给 KaTeX,且不再过 markdown 行内规则", () => {
    globalThis.katex = {
      renderToString: (tex, opts) => `<span class="katex" data-display="${opts.displayMode}">${tex}</span>`
    };
    const html = mdToHtml("公式 $a_1 * b_2$ 完");
    // 下划线与星号原样交给 KaTeX,没有被 <em>/<strong> 切碎。
    expect(html).toContain('<span class="katex"');
    expect(html).toContain("a_1 * b_2");
    expect(html).not.toContain("<em>");
  });

  it("TeX 源码在喂给 KaTeX 前已从转义态还原", () => {
    let received = null;
    globalThis.katex = { renderToString: (tex) => { received = tex; return "<span></span>"; } };
    mdToHtml("$a < b$");
    expect(received).toBe("a < b");
  });

  it("行内 code 里的 $ 不被当公式", () => {
    globalThis.katex = { renderToString: () => "<span class=\"katex\"></span>" };
    const html = mdToHtml("\`$PATH\` 与 \`$HOME\`");
    expect(html).toContain("<code>$PATH</code>");
    expect(html).not.toContain('class="katex"');
  });

  it("公式里的 URL 不会被 auto-link 改写", () => {
    globalThis.katex = { renderToString: () => '<span class="katex">https://x.test/a</span>' };
    const html = mdToHtml("$https://x.test/a$");
    expect(html).not.toContain("<a ");
  });
});
