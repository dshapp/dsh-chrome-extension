const B = "\\";

import { describe, expect, it } from "vitest";
import { deliverablesBasename, producedPath, presentedFiles, resolveMention } from "../src/features/sessions/turn-deliverables.js";

describe("deliverablesBasename", () => {
  it("取末尾路径段,斜杠或反斜杠分隔", () => {
    expect(deliverablesBasename("/a/b/c.ts")).toBe("c.ts");
    expect(deliverablesBasename("C:" + B + "work" + B + "x.md")).toBe("x.md");
    expect(deliverablesBasename("plain.txt")).toBe("plain.txt");
  });
});

describe("producedPath", () => {
  it("write 从 file_path 抽路径,缺 content 不贡献", () => {
    expect(producedPath("write", JSON.stringify({ content: "x", file_path: "a.txt" }))).toBe("a.txt");
    expect(producedPath("write", JSON.stringify({ file_path: "a.txt" }))).toBeNull();
  });

  it("edit 要求非空 old_string 且 old≠new,replace_all 必须是布尔", () => {
    expect(producedPath("edit", JSON.stringify({ old_string: "a", new_string: "b", file_path: "a.txt" }))).toBe("a.txt");
    expect(producedPath("edit", JSON.stringify({ old_string: "", new_string: "b", file_path: "a.txt" }))).toBeNull();
    expect(producedPath("edit", JSON.stringify({ old_string: "a", new_string: "a", file_path: "a.txt" }))).toBeNull();
    expect(producedPath("edit", JSON.stringify({ old_string: "a", new_string: "b", replace_all: "yes", file_path: "a.txt" }))).toBeNull();
  });

  it("str_replace_editor 只从完整变更命令抽路径", () => {
    expect(producedPath("str_replace_editor", JSON.stringify({ command: "create", path: "a.txt", file_text: "x" }))).toBe("a.txt");
    expect(producedPath("str_replace_editor", JSON.stringify({ command: "str_replace", path: "a.txt", old_str: "x" }))).toBe("a.txt");
    expect(producedPath("str_replace_editor", JSON.stringify({ command: "insert", path: "a.txt", insert_line: 3, new_str: "x" }))).toBe("a.txt");
    expect(producedPath("str_replace_editor", JSON.stringify({ command: "view", path: "a.txt" }))).toBeNull();
    expect(producedPath("str_replace_editor", JSON.stringify({ command: "create", path: "a.txt" }))).toBeNull();
  });

  it("非变更工具/非法参数不贡献", () => {
    expect(producedPath("bash", JSON.stringify({ command: "ls" }))).toBeNull();
    expect(producedPath("write", "{not json")).toBeNull();
    expect(producedPath("write", JSON.stringify({ content: "x", file_path: "  " }))).toBeNull();
  });
});

describe("presentedFiles", () => {
  it("解析 turn 与 files,空白/非字符串路径跳过", () => {
    const parsed = presentedFiles(7, { turn: 3, files: [
      { path: "a.txt", description: "d" },
      { path: "  " },
      { path: 42 },
      { path: "b.md" }
    ] });
    expect(parsed.turn).toBe(3);
    expect(parsed.files.map((f) => f.path)).toEqual(["a.txt", "b.md"]);
    expect(parsed.files[0]).toMatchObject({ seq: 7, index: 0, description: "d" });
  });

  it("缺 turn/空 files 返回 null", () => {
    expect(presentedFiles(1, { files: [] })).toBeNull();
    expect(presentedFiles(1, null)).toBeNull();
  });
});

describe("resolveMention", () => {
  it("精确路径优先,其次唯一 basename,不猜", () => {
    expect(resolveMention("a/b.ts", ["a/b.ts", "a/c.ts"])).toBe("a/b.ts");
    expect(resolveMention("b.ts", ["x/y/b.ts", "a/c.ts"])).toBe("x/y/b.ts");
    expect(resolveMention("b.ts", ["x/b.ts", "y/b.ts"])).toBeNull();
    expect(resolveMention("nope.ts", ["a.ts"])).toBeNull();
  });
});
