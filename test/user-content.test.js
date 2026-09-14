// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import {
  splitUserContent, projectUserText, referenceSummary, fileExtension, fileSizeText
} from "../src/features/chat/user-content.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));

describe("splitUserContent", () => {
  it("文本拼接、图片/文件/其余块分流", () => {
    const { text, images, files, rest } = splitUserContent([
      { type: "text", text: "hello " },
      { type: "image", data: "AAA", mediaType: "image/png", name: "a.png" },
      { type: "file", attachment: { attachmentId: "f1", name: "doc.pdf", bytes: 2048 } },
      { type: "text", text: "world" },
      { type: "audio", data: "x" }
    ]);
    expect(text).toBe("hello world");
    expect(images[0]).toMatchObject({ data: "AAA", name: "a.png" });
    expect(files[0]).toMatchObject({ name: "doc.pdf", bytes: 2048 });
    expect(rest).toEqual([{ type: "audio", data: "x" }]);
  });

  it("历史图片保留 attachmentId(字节要按需读回)", () => {
    const { images } = splitUserContent([
      { type: "image", attachment: { attachmentId: "sha256:abc", mediaType: "image/webp", name: "p.png" } }
    ]);
    expect(images[0]).toEqual({
      data: undefined, mediaType: "image/webp", name: "p.png", attachmentId: "sha256:abc"
    });
  });

  it("扩展名与文件大小", () => {
    expect(fileExtension("a/b/c.tar.gz")).toBe("gz");
    expect(fileSizeText(512)).toBe("512 B");
    expect(fileSizeText(2048)).toBe("2.0 KB");
    expect(fileSizeText(null)).toBe("");
  });
});

describe("projectUserText", () => {
  it("wire 会话引用折叠成 label,sessionLabels 装饰裸 @label", () => {
    const frag = projectUserText("见 @[研究笔记](dsh-session:s1) 和 @研究笔记", { sessionLabels: ["研究笔记"] });
    const host = document.createElement("div");
    host.append(frag);
    const chips = host.querySelectorAll('[data-ref-chip="session"]');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain("研究笔记");
    expect(host.textContent).not.toContain("dsh-session:");
  });

  it("@文件 chip 可点,/skill 仅在已加载名单内装饰", () => {
    const opened = [];
    const frag = projectUserText("看 @src/a.ts 和 /demo 与 /other", {
      slashNames: ["demo"],
      onOpenFile: (p) => opened.push(p)
    });
    const host = document.createElement("div");
    host.append(frag);
    const file = host.querySelector('button[data-ref-chip="file"]');
    expect(file.textContent).toContain("a.ts");
    file.click();
    expect(opened).toEqual(["src/a.ts"]);
    const skills = host.querySelectorAll('[data-ref-chip="skill"]');
    expect(skills).toHaveLength(1);
    expect(skills[0].textContent).toContain("/demo");
  });

  it("无装饰时原样返回文本", () => {
    const frag = projectUserText("plain text", {});
    const host = document.createElement("div");
    host.append(frag);
    expect(host.textContent).toBe("plain text");
    expect(host.querySelector(".ref-chip")).toBeNull();
  });
});

describe("referenceSummary", () => {
  it("无标签返回 null,有标签拼摘要", () => {
    expect(referenceSummary([])).toBeNull();
    const node = referenceSummary(["A", "B"]);
    expect(node.textContent).toContain("A, B");
  });
});
