// 长消息折叠策略 + 分片切割。
import { describe, it, expect } from "vitest";
import { foldMessageText, chunkText, FOLD_LIMIT, CHUNK_SIZE } from "../src/features/chat/long-message.js";

describe("foldMessageText", () => {
  it("leaves short text alone", () => {
    const fold = foldMessageText("hello");
    expect(fold.folded).toBe(false);
    expect(fold.preview).toBe("hello");
    expect(fold.hidden).toBe(0);
  });

  it("does not fold exactly at the limit", () => {
    const text = "x".repeat(FOLD_LIMIT);
    const fold = foldMessageText(text);
    expect(fold.folded).toBe(false);
    expect(fold.preview).toHaveLength(FOLD_LIMIT);
  });

  it("folds one character past the limit", () => {
    const text = "x".repeat(FOLD_LIMIT + 1);
    const fold = foldMessageText(text);
    expect(fold.folded).toBe(true);
    expect(fold.preview).toHaveLength(FOLD_LIMIT);
    expect(fold.hidden).toBe(1);
    expect(fold.total).toBe(FOLD_LIMIT + 1);
  });

  it("keeps the preview bounded no matter how long the input is", () => {
    const fold = foldMessageText("y".repeat(500000));
    expect(fold.preview).toHaveLength(FOLD_LIMIT);
    expect(fold.hidden).toBe(500000 - FOLD_LIMIT);
  });

  it("treats non-strings as empty", () => {
    expect(foldMessageText(null).folded).toBe(false);
    expect(foldMessageText(undefined).preview).toBe("");
  });

  // 气泡里贴一段以 emoji 跨越 limit 的长文本时,按码元切会把代理对劈成两半,
  // 末尾留下一个孤立高位代理,浏览器渲染成 "�"。
  it("never cuts a surrogate pair in half", () => {
    const text = "a".repeat(FOLD_LIMIT - 1) + "😀" + "b".repeat(50);
    const fold = foldMessageText(text);
    expect(fold.folded).toBe(true);
    // 整个 emoji 要么完整保留,要么整个留在折叠区,不能只剩一半。
    expect(/[�-�]$/.test(fold.preview)).toBe(false);
    expect(fold.preview).toBe("a".repeat(FOLD_LIMIT - 1));
    // hidden 仍要能和 preview 拼回原文,计数不能对不上。
    expect(fold.preview.length + fold.hidden).toBe(fold.total);
    expect(text.slice(fold.preview.length)).toHaveLength(fold.hidden);
  });

  it("keeps a pair that lands wholly inside the limit", () => {
    const text = "a".repeat(FOLD_LIMIT - 2) + "😀" + "b".repeat(50);
    const fold = foldMessageText(text);
    expect(fold.preview).toBe("a".repeat(FOLD_LIMIT - 2) + "😀");
    expect(fold.preview).toHaveLength(FOLD_LIMIT);
  });
});

describe("chunkText", () => {
  it("returns no chunks for empty text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText(null)).toEqual([]);
  });

  it("returns a single chunk below the size", () => {
    expect(chunkText("abc")).toEqual(["abc"]);
  });

  it("splits on the chunk boundary and loses nothing", () => {
    const text = "z".repeat(CHUNK_SIZE * 2 + 7);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(7);
    expect(chunks.join("")).toBe(text);
  });

  it("honours a custom size", () => {
    expect(chunkText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
  });

  // 分片是按 UTF-16 码元切的,切点可能落在代理对中间。相邻 Text 节点在排版时
  // 会重新拼合,所以弹窗里看不出问题;但每一片本身不是合法 Unicode 串,任何
  // 逐片消费的地方(复制、逐片写文件、发给宿主)都会拿到孤立代理项。
  it("分片不会把代理对切成两半", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const chunks = chunkText("a" + emoji.repeat(3), 4);
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
    // 拼回去仍须与原文逐字节一致 —— 修法不能吞字或补字。
    expect(chunks.join("")).toBe("a" + emoji.repeat(3));
  });
});
