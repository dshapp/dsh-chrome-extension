import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 改动文件卡的 +N(绿) / −N(红)在 Windows 上上下错位:
//   - 等宽处写的是 var(--font-mono, monospace),而 --font-mono 从没定义过,落到泛型 monospace;
//     侧栏 <html lang="zh">,Windows 上 Chrome 把它映射成「新宋体」,+ 与 U+2212 减号/数字度量不一;
//   - 计数容器是 inline-flex 默认 stretch(按行盒顶对齐),一侧行盒更高时文字基线就错开。
const root = new URL("..", import.meta.url).pathname;
const read = (file) => readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const foundation = read("src/app/sidepanel/styles/foundation.css");
const conversation = read("src/app/sidepanel/styles/conversation.css");

function body(css, selector) {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, sel]) => sel.split(",").some((part) => part.trim() === selector));
  assert.ok(rule, selector + " rule exists");
  return rule[2];
}

test("--font-mono 有定义,且在泛型 monospace 之前点名 Windows 自带的等宽字体", () => {
  const match = foundation.match(/--font-mono:\s*([^;]+);/);
  assert.ok(match, "--font-mono is defined");
  const stack = match[1].split(",").map((part) => part.trim().replace(/"/g, ""));
  assert.equal(stack.at(-1), "monospace");
  assert.ok(stack.indexOf("Consolas") >= 0 && stack.indexOf("Consolas") < stack.length - 1, "Consolas precedes the generic fallback");
});

test("改动文件卡的 +N / −N 按基线对齐", () => {
  for (const selector of [".turn-changes-stat", ".turn-changes-counts"]) {
    assert.match(body(conversation, selector), /align-items:\s*baseline/, selector);
  }
});
