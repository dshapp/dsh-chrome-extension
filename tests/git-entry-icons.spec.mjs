// Git 入口图标:linked worktree 与普通 checkout 必须是两个不同的 lucide 图标,
// 且分别对应 Mac 的 square.stack(gallery-vertical-end)与 arrow.triangle.branch(split)。
import test from "node:test";
import assert from "node:assert/strict";
import { lucideIconSvg } from "../src/features/chat/file-icons.js";
import { ICON_WORKTREE, ICON_BRANCH } from "../src/app/sidepanel/git-entry-view.js";

test("worktree 用 gallery-vertical-end,普通分支用 split", () => {
  assert.equal(ICON_WORKTREE, lucideIconSvg("gallery-vertical-end", { size: 13 }));
  assert.equal(ICON_BRANCH, lucideIconSvg("split", { size: 13 }));
});

test("两个图标都已内联(不会退回通用 file 图标)且彼此不同", () => {
  const fallback = lucideIconSvg("file", { size: 13 });
  assert.notEqual(ICON_WORKTREE, fallback);
  assert.notEqual(ICON_BRANCH, fallback);
  assert.notEqual(ICON_WORKTREE, ICON_BRANCH);
  assert.match(ICON_WORKTREE, /<rect width="18" height="12" x="3" y="10" rx="2"/);
  assert.match(ICON_BRANCH, /M12 22v-8\.3a4 4 0 0 0-1\.172-2\.872L3 3/);
});
