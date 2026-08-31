import { describe, it, expect } from "vitest";
import {
  detectTrigger, fuzzyScore, filterByFuzzy, createMenuState, menuOnHit,
  menuOnSettled, menuOnFailed, menuMove, menuRows, menuHighlightedItem,
  menuClose, applyPick, deriveDecorations
} from "../src/app/sidepanel/composer-triggers.js";
import { formatFileMention, fileCandidates, sessionCandidates } from "../src/features/references/reference-service.js";

describe("触发检测", () => {
  it("行首的 / 触发", () => {
    const hit = detectTrigger("/comp", 5);
    expect(hit).toMatchObject({ trigger: "/", query: "comp", position: "leading" });
    expect(hit.span).toEqual({ start: 0, end: 5 });
  });

  it("空白后的 @ 触发,标为 inline", () => {
    // "看看 @src".length === 7,光标在末尾。
    const hit = detectTrigger("看看 @src", 7);
    expect(hit).toMatchObject({ trigger: "@", query: "src", position: "inline" });
  });

  it("紧贴单词的 @ 不触发(邮箱/URL)", () => {
    expect(detectTrigger("a@b", 3)).toBeNull();
    expect(detectTrigger("http://x", 8)).toBeNull();
  });

  it("触发符与光标之间有空白则不触发", () => {
    expect(detectTrigger("/cmd arg", 8)).toBeNull();
  });

  it("空查询词也算触发(刚敲下触发符)", () => {
    expect(detectTrigger("/", 1)).toMatchObject({ trigger: "/", query: "" });
  });

  it("光标在中间时只看光标之前", () => {
    expect(detectTrigger("/abc def", 4)).toMatchObject({ query: "abc" });
  });

  it("路径里的斜杠不阻断触发(目录下钻的前提)", () => {
    // '/' 本身也是触发符;遇到它就否决会让 @src/... 与 @content/ 永远检测不到。
    expect(detectTrigger("@content/", 9)).toMatchObject({ trigger: "@", query: "content/" });
    expect(detectTrigger("@src/features/chat", 18)).toMatchObject({ trigger: "@", query: "src/features/chat" });
    expect(detectTrigger("看看 @src/a", 9)).toMatchObject({ trigger: "@", query: "src/a" });
  });

  it("未闭合引号的 mention 里空白属于内容", () => {
    const hit = detectTrigger('@"my dir/', 9);
    expect(hit).toMatchObject({ trigger: "@", query: '"my dir/' });
    expect(hit.span).toEqual({ start: 0, end: 9 });
    expect(detectTrigger('看看 @"my dir/sub', 15)).toMatchObject({ query: '"my dir/sub' });
  });

  it("引号闭合后不再视为进行中的触发", () => {
    expect(detectTrigger('@"my file.ts" ', 14)).toBeNull();
  });

  it("普通文本里的斜杠不误触发", () => {
    expect(detectTrigger("前缀/notcmd", 9)).toBeNull();
  });
});

describe("模糊打分", () => {
  it("前缀命中最高", () => {
    expect(fuzzyScore("compact", "comp")).toBe(100);
  });
  it("不匹配返回 -1", () => {
    expect(fuzzyScore("compact", "xyz")).toBe(-1);
  });
  it("子序列可命中,边界加权", () => {
    expect(fuzzyScore("web_search", "ws")).toBeGreaterThan(0);
  });
  it("过滤按分数再按原序稳定排序", () => {
    const items = [{ name: "search" }, { name: "compact" }, { name: "commit" }];
    expect(filterByFuzzy(items, "com").map((i) => i.name)).toEqual(["compact", "commit"]);
  });
  it("空查询保留全部", () => {
    const items = [{ name: "a" }, { name: "b" }];
    expect(filterByFuzzy(items, "")).toHaveLength(2);
  });
});

describe("菜单状态机", () => {
  const hit = { trigger: "/", query: "c", position: "leading", span: { start: 0, end: 2 } };

  it("命中开新一代并把来源置 pending", () => {
    const s = menuOnHit(createMenuState(), hit, ["commands", "skills"]);
    expect(s.open).toBe(true);
    expect(s.groups.map((g) => g.status)).toEqual(["pending", "pending"]);
    expect(s.generation).toBe(1);
  });

  it("来源结算后填充候选并自动高亮首项", () => {
    let s = menuOnHit(createMenuState(), hit, ["commands"]);
    s = menuOnSettled(s, s.generation, "commands", [{ name: "compact" }]);
    expect(s.groups[0].status).toBe("ready");
    expect(menuHighlightedItem(s).name).toBe("compact");
  });

  it("迟到的上一代结果被丢弃", () => {
    let s = menuOnHit(createMenuState(), hit, ["commands"]);
    const stale = s.generation;
    s = menuOnHit(s, { ...hit, query: "cc" }, ["commands"]);
    const after = menuOnSettled(s, stale, "commands", [{ name: "旧结果" }]);
    expect(after.groups[0].items).toHaveLength(0);
    expect(after).toBe(s);
  });

  it("来源失败标记 ready 且候选为空", () => {
    let s = menuOnHit(createMenuState(), hit, ["skills"]);
    s = menuOnFailed(s, s.generation, "skills");
    expect(s.groups[0]).toMatchObject({ status: "ready", items: [] });
  });

  it("高亮跨组循环移动", () => {
    let s = menuOnHit(createMenuState(), hit, ["a", "b"]);
    s = menuOnSettled(s, s.generation, "a", [{ name: "a1" }]);
    s = menuOnSettled(s, s.generation, "b", [{ name: "b1" }]);
    expect(menuRows(s)).toHaveLength(2);
    s = menuMove(s, 1);
    expect(menuHighlightedItem(s).name).toBe("b1");
    s = menuMove(s, 1);
    expect(menuHighlightedItem(s).name).toBe("a1");
    s = menuMove(s, -1);
    expect(menuHighlightedItem(s).name).toBe("b1");
  });

  it("关闭重置但推进 generation", () => {
    let s = menuOnHit(createMenuState(), hit, ["a"]);
    const closed = menuClose(s);
    expect(closed.open).toBe(false);
    expect(closed.generation).toBeGreaterThan(s.generation);
  });
});

describe("插入候选", () => {
  const hit = (start, end, trigger = "/") => ({ trigger, query: "", position: "leading", span: { start, end } });

  it("普通候选插入 token 并补空格", () => {
    const r = applyPick("/comp", hit(0, 5), { name: "compact" });
    expect(r.text).toBe("/compact ");
    expect(r.caret).toBe(9);
    expect(r.keepOpen).toBe(false);
  });

  it("保留光标之后的文本", () => {
    const r = applyPick("/comp 尾巴", hit(0, 5), { name: "compact" });
    expect(r.text).toBe("/compact  尾巴");
  });

  it("目录候选下钻:原样插入 mention、不补空格、保持菜单打开", () => {
    const r = applyPick("@sr", hit(0, 3, "@"), { name: "文件夹 · src/", value: "@src/", insertsPlainText: true });
    expect(r.text).toBe("@src/");
    expect(r.keepOpen).toBe(true);
  });

  it("已格式化的 mention 原样插入(含引号)", () => {
    // value 由 formatFileMention 产出,已经带好 '@' 与引号,这里不得再包一层。
    const r = applyPick("@my", hit(0, 3, "@"), { name: "文件 · my file.ts", value: '@"my file.ts"' });
    expect(r.text).toBe('@"my file.ts" ');
  });

  it("会话 mention 原样插入", () => {
    const mention = "@[某会话](dsh-session:AAAA)";
    const r = applyPick("@a", hit(0, 2, "@"), { name: "会话 · 某会话", value: mention });
    expect(r.text).toBe(mention + " ");
  });
});

describe("草稿装饰", () => {
  const lex = { "/": new Set(["compact"]), "@": new Set(["src/a.ts"]) };

  it("已知 / 与 @ 名标为 textRef", () => {
    const d = deriveDecorations("/compact 然后 @src/a.ts", lex);
    expect(d.map((x) => x.kind)).toEqual(["textRef", "textRef"]);
  });

  it("未知 @ 名标红", () => {
    const d = deriveDecorations("@nope", lex);
    expect(d[0].kind).toBe("invalidRef");
  });

  it("未知 / 名不标记(可能只是普通斜杠)", () => {
    expect(deriveDecorations("/unknown", lex)).toHaveLength(0);
  });

  it("不在边界的触发符被忽略", () => {
    expect(deriveDecorations("a@b", lex)).toHaveLength(0);
  });

  it("区间覆盖整个 token", () => {
    const [d] = deriveDecorations("/compact", lex);
    expect(d).toMatchObject({ start: 0, end: 8 });
  });

  it("空草稿返回空", () => {
    expect(deriveDecorations("", lex)).toEqual([]);
  });
});

describe("mention 格式化(对齐 Mac formatFileMention)", () => {
  it("普通路径不加引号", () => {
    expect(formatFileMention("src/a.ts", false)).toBe("@src/a.ts");
  });
  it("目录保留结尾斜杠", () => {
    expect(formatFileMention("src", true)).toBe("@src/");
  });
  it("含空白的文件加成对引号", () => {
    expect(formatFileMention("my file.ts", false)).toBe('@"my file.ts"');
  });
  it("含空白的目录只加开引号(便于继续下钻)", () => {
    expect(formatFileMention("my dir", true)).toBe('@"my dir/');
  });
  it("含引号或控制字符的路径无法表示", () => {
    expect(formatFileMention('a"b', false)).toBeNull();
    expect(formatFileMention("a\u0001b", false)).toBeNull();
  });
});

describe("引用候选映射", () => {
  it("文件行映射出 mention 与下钻标记", () => {
    const [file, dir] = fileCandidates([
      { path: "src/a.ts", kind: "file" },
      { path: "src", kind: "directory" }
    ]);
    expect(file.value).toBe("@src/a.ts");
    expect(file.insertsPlainText).toBeFalsy();
    expect(dir.value).toBe("@src/");
    expect(dir.insertsPlainText).toBe(true);
  });
  it("会话行原样采用宿主给的 mention", () => {
    const [s] = sessionCandidates([{
      mention: "@[标题](dsh-session:XX)", sessionId: "session-1",
      label: "标题", cwd: "/w", createdAt: 1700000000000
    }]);
    expect(s.value).toBe("@[标题](dsh-session:XX)");
    expect(s.description).toContain("/w");
  });
  it("缺失或非法 createdAt 不抛异常,会话仍可引用", () => {
    const [a, b] = sessionCandidates([
      { mention: "@[A](dsh-session:1)", sessionId: "s1", label: "A", cwd: "/w" },
      { mention: "@[B](dsh-session:2)", sessionId: "s2", label: "B", cwd: null, createdAt: "not-a-date" }
    ]);
    expect(a.value).toBe("@[A](dsh-session:1)");
    expect(a.description).toContain("/w");
    expect(b.value).toBe("@[B](dsh-session:2)");
    expect(b.description).not.toContain("Invalid");
  });
});
