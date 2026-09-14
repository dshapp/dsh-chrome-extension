// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fileTypeKind, fileTypeIconName, linkIconName, lucideIcon, lucideIconSvg } from "../src/features/chat/file-icons.js";

describe("file-icons(lucide)", () => {
  it("细分类对齐 web classifyFileType", () => {
    expect(fileTypeKind("src/a.ts")).toBe("code");
    expect(fileTypeKind("a.PNG")).toBe("image");
    expect(fileTypeKind("README.md")).toBe("markdown");
    expect(fileTypeKind("doc.pdf")).toBe("pdf");
    expect(fileTypeKind("deck.key")).toBe("ppt");
    expect(fileTypeKind("data.xlsx")).toBe("excel");
    expect(fileTypeKind("notes.docx")).toBe("word");
    expect(fileTypeKind("clip.mp4")).toBe("video");
    expect(fileTypeKind("Makefile")).toBe("code");
    expect(fileTypeKind("LICENSE")).toBe("other");
  });

  it("present 卡用细分类图标,产出 chip 用 LinkIcon 粗分类", () => {
    expect(fileTypeIconName("a.ts")).toBe("file-code");
    expect(fileTypeIconName("README.md")).toBe("file-pen");
    expect(fileTypeIconName("doc.pdf")).toBe("file-type");
    expect(fileTypeIconName("data.xlsx")).toBe("file-spreadsheet");
    expect(fileTypeIconName("deck.key")).toBe("presentation");
    expect(fileTypeIconName("clip.mp4")).toBe("file-play");
    // LinkIcon:markdown/video/other 都退回通用纸页(与 web classifyLinkPath 一致)。
    expect(linkIconName("README.md")).toBe("file");
    expect(linkIconName("clip.mp4")).toBe("file");
    expect(linkIconName("a.ts")).toBe("file-code");
    expect(linkIconName("a.png")).toBe("file-image");
    expect(linkIconName("doc.pdf")).toBe("file-text");
  });

  it("lucideIcon 生成 stroke 线稿 svg", () => {
    const svg = lucideIcon("file-code", { size: 20 });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.querySelectorAll("path")).toHaveLength(4);
    // 未知名字退回通用 file,不是空 svg。
    expect(lucideIcon("nope").querySelectorAll("path")).toHaveLength(2);
  });

  it("折叠/展开用到的 chevron 与 plus/minus 都在本地图标表里", () => {
    expect(lucideIcon("chevron-right").querySelector("path").getAttribute("d")).toBe("m9 18 6-6-6-6");
    expect(lucideIcon("chevron-up").querySelector("path").getAttribute("d")).toBe("m18 15-6-6-6 6");
    expect(lucideIcon("plus").querySelectorAll("path")).toHaveLength(2);
    expect(lucideIcon("minus").querySelectorAll("path")).toHaveLength(1);
    expect(lucideIcon("arrow-up-down").querySelectorAll("path")).toHaveLength(4);
  });

  it("lucideIconSvg 给出同样的 stroke 线稿字符串", () => {
    const markup = lucideIconSvg("chevron-down", { size: 13, className: "dropdown-chevron" });
    expect(markup).toContain('<svg class="dropdown-chevron" width="13" height="13"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain("m6 9 6 6 6-6");
    expect(markup).not.toContain("undefined");
  });
});
