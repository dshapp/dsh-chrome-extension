// @vitest-environment jsdom
//
// 卡片图标与 Mac 端对齐的回归护栏:
// - 思考卡 ThinkRow 用 SF Symbol `brain`(lucide `brain` 是同一网格上的等价线稿);
// - 代码执行卡(run_code)用 Mac 的 `chevron.left.forwardslash.chevron.right`(lucide `code-xml`)。
// 只钉字形几何,不钉具体 DOM 结构;颜色由 tools.css 的 .thinking-icon/.tool-icon 统一。
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantNode, createToolNode } from "../src/features/chat/node-views.js";
import { getToolPresentation } from "../src/features/chat/tool-presentation.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

const pathsOf = (root, selector) =>
  [...root.querySelectorAll(`${selector} svg path`)].map((p) => p.getAttribute("d"));

describe("卡片图标(对齐 Mac)", () => {
  it("思考卡用 brain 字形,不再是 sparkles", () => {
    const turn = createAssistantNode({ blocks: [{ type: "reasoning", text: "先想一下" }] }, {});
    const paths = pathsOf(turn, ".thinking-icon");
    expect(paths[0]).toBe("M12 18V5");
    expect(paths).toHaveLength(8);
  });

  it("代码执行卡(run_code)用 code-xml 字形,不再是 wrench", () => {
    expect(getToolPresentation("run_code")).toMatchObject({ category: "code", iconKey: "codeXml" });
    const row = createToolNode({
      name: "run_code",
      argsRaw: JSON.stringify({ description: "跑测试" }),
      result: { content: [{ type: "text", text: "ok" }] }
    }, {});
    expect(pathsOf(row, ".tool-icon")).toEqual(["m18 16 4-4-4-4", "m6 8-4 4 4 4", "m14.5 4-5 16"]);
  });

  it("两类卡片的图标与摘要同色(metadata 灰 --text-faint)", () => {
    const css = readFileSync(join(process.cwd(), "src/app/sidepanel/styles/tools.css"), "utf8");
    const rule = (name) => new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule("thinking-icon")).toContain("color: var(--text-faint)");
    expect(rule("thinking-icon")).not.toContain("opacity");
    expect(rule("tool-icon")).toContain("color: var(--text-faint)");
  });
});
