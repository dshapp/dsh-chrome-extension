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
});
