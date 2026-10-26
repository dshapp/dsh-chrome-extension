// Git 入口在 Windows 上的两处路径/失败处理:
//   - daemon 拒绝执行 git(HTTP 400 等)时,入口照旧隐藏,但控制台必须留下宿主给的原因 ——
//     Windows 上 daemon 只认 $HOME 时每条 /host/git 都被 400 拒掉,入口永不出现且毫无痕迹;
//   - worktree 占用表把 `worktree list` 的 C:/… 与会话 cwd 的 C:\… 认作同一个目录。
import test from "node:test";
import assert from "node:assert/strict";
import { createHostProxyClient } from "../src/platform/dsh/host-proxy-client.js";
import { createGitSummaryReader, NO_REPOSITORY } from "../src/features/host-proxy/git-summary.js";
import { occupancyMap, worktreeDisplayName } from "../src/features/host-proxy/worktree-occupancy.js";

function daemonAnswering(status, body) {
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, client: createHostProxyClient({ fetch }) };
}

test("宿主拒绝 git:摘要视为无仓库,并在控制台报出宿主原因(同一原因只报一次)", async () => {
  const { calls, client } = daemonAnswering(400, { error: "cannot determine HOME" });
  const warnings = [];
  const reader = createGitSummaryReader(client, { warn: (message) => warnings.push(message) });
  const cwd = "C:\\Users\\dev\\repo";

  assert.deepEqual(await reader.summary(cwd), NO_REPOSITORY);
  assert.deepEqual(await reader.summary(cwd), NO_REPOSITORY);

  assert.deepEqual(calls.map((c) => c.args.join(" ")), ["rev-parse --is-inside-work-tree", "rev-parse --is-inside-work-tree"]);
  assert.equal(calls[0].cwd, cwd);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /400 cannot determine HOME/);
  assert.match(warnings[0], /rev-parse --is-inside-work-tree/);
});

test("git 自己非零退出(真的不是仓库)不算宿主拒绝,不报警告", async () => {
  const { client } = daemonAnswering(200, { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" });
  const warnings = [];
  const reader = createGitSummaryReader(client, { warn: (message) => warnings.push(message) });
  assert.deepEqual(await reader.summary("C:\\Users\\dev\\notes"), NO_REPOSITORY);
  assert.deepEqual(warnings, []);
});

test("daemon 连不上仍按 unsupported 抛出,交给入口整体隐藏", async () => {
  const fetch = async () => { throw new TypeError("Failed to fetch"); };
  const reader = createGitSummaryReader(createHostProxyClient({ fetch }), { warn: () => assert.fail("不该报警") });
  await assert.rejects(reader.summary("C:\\Users\\dev\\repo"), (error) => error.isUnsupported);
});

test("Windows 分隔符与盘符大小写不同的同一目录,不把当前 worktree 算作占用", () => {
  const worktrees = [
    { path: "C:/Users/dev/repo", branch: "main" },
    { path: "C:/Users/dev/repo-feature", branch: "feature" }
  ];
  const map = occupancyMap(worktrees, "c:\\Users\\dev\\repo\\");
  assert.deepEqual([...map.keys()], ["feature"]);
  assert.equal(map.get("feature").displayName, "repo-feature");
});

test("POSIX 路径仍区分大小写", () => {
  const map = occupancyMap([{ path: "/Users/dev/Repo", branch: "main" }], "/Users/dev/repo");
  assert.deepEqual([...map.keys()], ["main"]);
});

test("worktree 展示名认反斜杠", () => {
  assert.equal(worktreeDisplayName("C:\\Users\\dev\\repo-feature\\"), "repo-feature");
  assert.equal(worktreeDisplayName("/Users/dev/repo/"), "repo");
});
