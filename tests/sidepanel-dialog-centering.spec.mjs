import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// foundation.css 的 `* { margin: 0 }` 会盖掉 UA 给模态 <dialog> 的 margin:auto,
// 漏写的弹窗会贴在侧栏左上角。侧栏 index.html 里每个 <dialog> 都必须自己写回居中。
const root = new URL("..", import.meta.url).pathname;
const html = readFileSync(join(root, "pages/sidepanel/index.html"), "utf8");
const cssFiles = [
  ...readdirSync(join(root, "src/app/sidepanel/styles")).map((name) => join(root, "src/app/sidepanel/styles", name)),
  join(root, "src/features/onboarding/setup-guide.css")
].filter((file) => file.endsWith(".css"));
const css = cssFiles.map((file) => readFileSync(file, "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsFor(id) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter(([, selector]) => selector.split(",").some((part) => part.trim() === "#" + id))
    .map(([, , body]) => body)
    .join(";");
}

test("every side panel <dialog> re-centres itself after the global margin reset", () => {
  assert.match(css, /\*\s*\{[^}]*margin:\s*0/, "the reset this test guards against is still there");
  const ids = [...html.matchAll(/<dialog\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.includes("perm-confirm"), "the full-access confirmation is a <dialog>");
  for (const id of ids) {
    const body = declarationsFor(id);
    assert.match(body, /(^|;)\s*margin:\s*auto\s*(;|$)/, "#" + id + " needs margin:auto");
    assert.match(body, /(^|;)\s*inset:\s*0\s*(;|$)/, "#" + id + " needs inset:0");
    assert.match(body, /(^|;)\s*position:\s*fixed\s*(;|$)/, "#" + id + " needs position:fixed");
  }
});
