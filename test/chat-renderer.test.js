// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createChatRenderer, agentStatusLabel, isThinking } from "../src/features/chat/chat-renderer.js";
import { getToolPresentation, normalizeToolName, isCommandLikeToolName } from "../src/features/chat/tool-presentation.js";
import {
  userNode, steeringNode, assistantNode, toolCallNode, toolResult, turnErrorNode,
  compactionNode, modelRetryNode, commandNode, turnProcessNode, turnTailNode, turnMaxTokensNode, workflowRunNode,
  unknownSurfaceNode, AssistantStatus
} from "../src/features/sessions/chat-nodes.js";
import { setLang, t } from "../src/shared/i18n.js";
import { _resetCardDetail } from "../src/features/chat/card-detail.js";

/// 卡片详情弹窗是全局单例:每个用例前重置,避免上一条的正文渗进来。
function detail() {
  return document.querySelector("dialog.card-detail");
}
function detailBody() {
  return detail()?.querySelector(".card-detail-body");
}

beforeAll(() => setLang("en"));
beforeEach(() => _resetCardDetail());

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}
const text = (t) => ({ type: "text", text: t });

function assistantWith(blocks, over = {}) {
  const node = assistantNode({ turn: 1, step: 0, startSeq: 10, time: 1 });
  node.blocks = blocks;
  node.status = AssistantStatus.settled;
  return Object.assign(node, over);
}

describe("tool-presentation", () => {
  it("归一化工具名:mcp 前缀、dsh 前缀", () => {
    expect(normalizeToolName("mcp__acme__fetch")).toBe("fetch");
    expect(normalizeToolName("dsh-read")).toBe("read");
    expect(normalizeToolName("bash")).toBe("bash");
    expect(normalizeToolName("")).toBe("tool");
  });

  it("命令类工具识别与图标分类", () => {
    expect(isCommandLikeToolName("bash")).toBe(true);
    expect(isCommandLikeToolName("curl -s http://x")).toBe(true);
    expect(isCommandLikeToolName("Read")).toBe(false);
    expect(getToolPresentation("bash").iconKey).toBe("terminal");
    expect(getToolPresentation("Write").iconKey).toBe("documentEdit");
    expect(getToolPresentation("web_search").iconKey).toBe("sparkleSearch");
    expect(getToolPresentation("unknown_thing").iconKey).toBe("wrench");
  });
});

describe("节点渲染", () => {
  it("user 消息:结构、图片条、操作行", () => {
    const c = mount();
    createChatRenderer(c).render([userNode({
      seq: 1, time: Date.now(), messageId: "m1",
      content: [text("你好"), { type: "image", data: "AAA", mediaType: "image/png" }]
    })]);
    expect(c.querySelector(".msg-user-turn")).toBeTruthy();
    expect(c.querySelector(".msg-imgs img").src).toContain("data:image/png;base64,AAA");
    expect(c.querySelector(".msg-user").textContent).toContain("你好");
    expect(c.querySelector(".msg-user-actions .act-btn")).toBeTruthy();
  });

  it("历史图片按 attachmentId 读回,不会出现 base64,undefined", async () => {
    const c = mount();
    const asked = [];
    const r = createChatRenderer(c, {
      getContext: () => ({
        readAttachment: (id) => { asked.push(id); return Promise.resolve({ attachment: { mediaType: "image/webp" }, data: "QkJC" }); }
      })
    });
    r.render([userNode({
      seq: 1, time: 1, messageId: "m1",
      content: [
        text("看图"),
        { type: "image", attachment: { attachmentId: "sha256:x", mediaType: "image/webp", name: "p.png" } }
      ]
    })]);
    const img = c.querySelector(".msg-imgs img");
    expect(img.src).not.toContain("undefined");
    expect(img.alt).toBe("p.png");
    expect(asked).toEqual(["sha256:x"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(img.src).toBe("data:image/webp;base64,QkJC");
    expect(img.classList.contains("img-loading")).toBe(false);
  });

  it("assistant 图片块也支持 attachmentId 读回", async () => {
    const c = mount();
    const r = createChatRenderer(c, {
      getContext: () => ({ readAttachment: () => Promise.resolve({ attachment: { mediaType: "image/png" }, data: "QUFB" }) })
    });
    r.render([assistantWith([{ type: "image", attachment: { attachmentId: "a1", name: "shot.png" } }])]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(c.querySelector(".msg-agent-img").src).toBe("data:image/png;base64,QUFB");
  });

  it("user 消息渲染文件卡、引用 chip 与引用摘要", () => {
    const c = mount();
    const opened = [];
    const r = createChatRenderer(c, { getContext: () => ({ onOpenFile: (p) => opened.push(p) }) });
    r.render([Object.assign(userNode({
      seq: 1, time: 1, messageId: "u1",
      content: [
        { type: "text", text: "看 @src/a.ts" },
        { type: "file", attachment: { name: "doc.pdf", bytes: 2048, attachmentId: "f1" } }
      ]
    }), { referenceLabels: ["Notes"] })]);
    expect(c.querySelector(".file-card .file-name").textContent).toBe("doc.pdf");
    expect(c.querySelector(".file-meta").textContent).toContain("PDF");
    expect(c.querySelector(".msg-reference-summary").textContent).toContain("Notes");
    const chip = c.querySelector('button[data-ref-chip="file"]');
    expect(chip.textContent).toContain("a.ts");
    chip.click();
    expect(opened).toEqual(["src/a.ts"]);
  });

  it("assistant 文本渲染 markdown 与代码块工具栏", () => {
    const c = mount();
    createChatRenderer(c).render([assistantWith([text("# 标题\n\n\`\`\`js\nlet a=1\n\`\`\`")])]);
    // h1/h2 保留语义层级;尺寸由 .msg-agent h1…h6 限定,不会溢到侧栏标题。
    expect(c.querySelector(".msg-agent h1")).toBeTruthy();
    expect(c.querySelector(".code-block .code-copy-btn")).toBeTruthy();
  });

  it("assistant 的 reasoning 只留入口,点击才弹出全文", () => {
    const c = mount();
    createChatRenderer(c).render([assistantWith([{ type: "reasoning", text: "推理中" }, text("答案")])]);
    const bubble = c.querySelector(".thinking-bubble");
    // 记录流里不再挂正文
    expect(bubble.querySelector(".thinking-body")).toBeNull();
    expect(detailBody()).toBeFalsy();
    bubble.querySelector(".thinking-header").click();
    expect(detailBody().querySelector(".thinking-body").textContent).toBe("推理中");
  });

  it("被打断且无内容的 step 仍留下停止痕迹", () => {
    const c = mount();
    createChatRenderer(c).render([assistantWith([], { status: AssistantStatus.interrupted, interrupted: true })]);
    expect(c.querySelector(".msg-interrupted")).toBeTruthy();
  });

  it("steering 行与普通用户消息同一种样式", () => {
    const c = mount();
    createChatRenderer(c).render([steeringNode({ seq: 1, time: 1, messageId: "s1", content: [text("插一句")] })]);
    expect(c.querySelector(".msg-user-turn.steering")).toBeNull();
    expect(c.querySelector(".steering-badge")).toBeNull();
    expect(c.querySelector(".msg-user-turn .msg-user").textContent).toContain("插一句");
  });

  // 对齐 Mac 的 ChatNodeRow:.assistant 只渲染正文,复制/分叉/时钟统一由每轮
  // 末尾的 turnTail 页脚承担,整轮只出现一次。
  it("assistant step 不挂操作行", () => {
    const c = mount();
    createChatRenderer(c, { onFork: vi.fn() }).render([assistantWith([text("答")])]);
    expect(c.querySelector(".msg-turn .msg-actions")).toBeNull();
  });

  it("只发起工具调用的 step 不留空的操作行", () => {
    const c = mount();
    createChatRenderer(c).render([assistantWith([])]);
    // 没有任何内容块 → 整行不该在记录里留下可见残骸。
    expect(c.querySelector(".msg-actions")).toBeNull();
    expect(c.querySelector(".msg-timestamp")).toBeNull();
  });
});

describe("工具行", () => {
  const call = (over = {}) => Object.assign(
    toolCallNode({ callId: "c1", name: "bash", argsRaw: '{"command":"ls"}', turn: 1, step: 0, startSeq: 5, time: 1 }),
    over
  );

  it("运行中显示 running 图标与命令摘要", () => {
    const c = mount();
    createChatRenderer(c).render([call()]);
    expect(c.querySelector(".tool-row").dataset.state).toBe("running");
    expect(c.querySelector(".tool-icon.running")).toBeTruthy();
    expect(c.querySelector(".tool-label").textContent).toBe("ls");
  });

  it("结果到达后行内更新为 ok 并可展开输出", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.render([call()]);
    const before = c.querySelector(".tool-row");
    r.render([call({ result: toolResult({ seq: 6, time: 2, content: [text("file.txt")], isError: false }) })]);
    expect(c.querySelector(".tool-row")).toBe(before);
    expect(before.dataset.state).toBe("ok");
    // 输出不再内联,点开入口才建
    expect(before.querySelector(".tool-output")).toBeNull();
    before.querySelector(".tool-header").click();
    expect(detailBody().querySelector(".tool-output pre").textContent).toBe("file.txt");
  });

  it("错误行显示错误首行", () => {
    const c = mount();
    createChatRenderer(c).render([call({
      result: toolResult({ seq: 6, time: 2, content: [text("boom\ndetail")], isError: true })
    })]);
    expect(c.querySelector(".tool-row").dataset.state).toBe("error");
    expect(c.querySelector(".tool-label").textContent).toBe("boom");
  });

  it("子调用只在弹窗里嵌套渲染,记录流里不留痕迹", () => {
    const c = mount();
    const root = call({ name: "run_code", argsRaw: '{"description":"跑一下"}' });
    root.subCalls = [toolCallNode({ callId: "s1", name: "read", argsRaw: '{"path":"/a"}', turn: 1, step: 0, startSeq: 6, time: 2 })];
    createChatRenderer(c).render([root]);
    // 记录流里既没有嵌套树,也没有计数徽标。
    expect(c.querySelectorAll(".tool-subcalls")).toHaveLength(0);
    expect(c.querySelector(".tool-subcount")).toBeNull();
    // 树在点开后才建。
    c.querySelector(".tool-header").click();
    expect(detailBody().querySelectorAll(".tool-subcalls .tool-row")).toHaveLength(1);
  });

  it("只有子调用的行也可点开", () => {
    const c = mount();
    const root = toolCallNode({ callId: "r1", name: "run_code", turn: 1, step: 0, startSeq: 5, time: 1 });
    root.subCalls = [toolCallNode({ callId: "s1", name: "read", argsRaw: '{"path":"/a"}', turn: 1, step: 0, startSeq: 6, time: 2 })];
    createChatRenderer(c).render([root]);
    expect(c.querySelector(".tool-row").classList.contains("no-detail")).toBe(false);
  });

  it("exit_plan_mode 展开体渲染计划 markdown", () => {
    const c = mount();
    createChatRenderer(c).render([call({ name: "exit_plan_mode", argsRaw: JSON.stringify({ plan: "# 计划\n做事" }) })]);
    expect(c.querySelector(".plan-inline")).toBeNull();
    c.querySelector(".tool-header").click();
    expect(detailBody().querySelector(".plan-inline h1")).toBeTruthy();
  });
});

describe("其他节点", () => {
  it("turnError 是 role=alert 的卡片", () => {
    const c = mount();
    createChatRenderer(c).render([turnErrorNode({ seq: 1, time: 1, turn: 1, message: "炸了", code: "E1" })]);
    const err = c.querySelector(".msg-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("炸了");
  });

  it("连续图片合成为一组,单图仍是独立 img", () => {
    const c = mount();
    const r = createChatRenderer(c);
    const img = (data) => ({ type: "image", attachment: { data, mediaType: "image/png", name: `${data}.png` } });
    r.render([assistantWith([img("A"), img("B")])]);
    const group = c.querySelector(".msg-img-group");
    expect(group).toBeTruthy();
    expect(group.querySelectorAll("img")).toHaveLength(2);
    r.render([assistantWith([img("A")])]);
    expect(c.querySelector(".msg-img-group")).toBeNull();
    expect(c.querySelectorAll(".msg-agent-img")).toHaveLength(1);
  });

  it("工具行路径可点,按 cwd 解析且不触发详情", () => {
    const c = mount();
    const opened = [];
    const r = createChatRenderer(c, {
      getContext: () => ({ cwd: "/work", onOpenPath: (p) => opened.push(p) })
    });
    const tool = toolCallNode({
      callId: "c1", name: "read", argsRaw: JSON.stringify({ file_path: "src/a.ts" }),
      turn: 1, step: 0, startSeq: 1, time: 1
    });
    tool.result = { seq: 2, time: 2, content: [], isError: false, error: null, meta: null, resultView: null };
    r.render([tool]);
    const path = c.querySelector(".tool-path");
    expect(path).toBeTruthy();
    expect(path.title).toBe("/work/src/a.ts");
    path.click();
    expect(opened).toEqual(["/work/src/a.ts"]);
    expect(detail()).toBeNull();
  });

  it("compaction 显示隐去 token 数", () => {
    const c = mount();
    createChatRenderer(c).render([Object.assign(compactionNode({ compactionId: "k", seq: 1, time: 1 }), { shadowedTokenCount: 900 })]);
    expect(c.querySelector(".compaction-chip").textContent).toContain("900");
  });

  it("retry 显示重试次数与原因", () => {
    const c = mount();
    createChatRenderer(c).render([Object.assign(modelRetryNode({ retryId: "r", seq: 1, time: 1 }),
      { retry: 2, maxRetries: 3, failureMessage: "429" })]);
    const chip = c.querySelector(".retry-chip");
    expect(chip.textContent).toContain("429");
    // 未耗尽:不转错误色
    expect(chip.classList.contains("exhausted")).toBe(false);
  });

  it("retry 耗尽时转错误色并给出失败原因入口", () => {
    const c = mount();
    createChatRenderer(c).render([Object.assign(modelRetryNode({ retryId: "r", seq: 1, time: 1 }),
      { retryState: "started", retry: 3, maxRetries: 3, failureMessage: "quota exhausted\n详情第二行" })]);
    const chip = c.querySelector(".retry-chip");
    expect(chip.classList.contains("exhausted")).toBe(true);
    // started 态标签不含 reason,详情弹窗承载完整失败原因与延迟
    const more = chip.querySelector(".chip-more");
    expect(more.textContent).toBe("Details");
    more.click();
    expect(detailBody().textContent).toContain("quota exhausted");
    expect(detailBody().textContent).toContain("详情第二行");
  });

  it("retry 等待期内显示倒计时", () => {
    const c = mount();
    createChatRenderer(c).render([Object.assign(modelRetryNode({ retryId: "r", seq: 1, time: 1 }),
      { retryState: "scheduled", retry: 1, maxRetries: 3, delayMs: 3000, failureMessage: "429" })]);
    expect(c.querySelector(".retry-chip .chip-seconds").textContent).toContain("s");
  });

  it("turnError 详情弹窗含完整文案与错误码", () => {
    const c = mount();
    createChatRenderer(c).render([turnErrorNode({ seq: 1, time: 1, turn: 1, message: "炸了", code: "E1" })]);
    c.querySelector(".msg-error .chip-more").click();
    expect(detailBody().textContent).toContain("炸了");
    expect(detailBody().textContent).toContain("E1");
  });

  it("maxTokens 提供 hint 详情", () => {
    const c = mount();
    createChatRenderer(c).render([turnMaxTokensNode({ seq: 1, time: 1, turn: 1 })]);
    c.querySelector(".maxtokens-chip .chip-more").click();
    expect(detailBody().textContent).toContain("output token cap");
  });

  it("retry ∞ 模式(maxRetries 为 null)永不进入耗尽态", () => {
    const c = mount();
    createChatRenderer(c).render([Object.assign(modelRetryNode({ retryId: "r", seq: 1, time: 1 }),
      { retry: 99, maxRetries: null, failureMessage: "429" })]);
    expect(c.querySelector(".retry-chip").classList.contains("exhausted")).toBe(false);
  });

  it("command 行显示名称", () => {
    const c = mount();
    createChatRenderer(c).render([Object.assign(commandNode({ commandId: "x", seq: 1, time: 1 }),
      { name: "compact", outcome: { kind: "success", text: "完成" } })]);
    expect(c.querySelector(".command-chip").textContent).toContain("/compact");
  });

  it("turnTail 有指标才成行", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.render([turnTailNode({ turn: 1, seq: 9, time: 1 })]);
    expect(c.querySelector(".turn-tail")).toBeNull();
    r.render([Object.assign(turnTailNode({ turn: 1, seq: 9, time: 1 }), { ttftMs: 250, usage: { outputTokens: 30 } })]);
    expect(c.querySelector(".turn-tail").textContent).toContain("250");
    // 对齐 Mac 的 TurnTailIconActions:复用 msg-actions 的 hover 语义,
    // 时间戳 + 指标是同一行里左对齐的一簇,指标紧跟时间戳,中间没有 spacer。
    const row = c.querySelector(".turn-tail-actions");
    expect(row.classList.contains("msg-actions")).toBe(true);
    expect(row.querySelector(".interaction-spacer")).toBeNull();
    expect([...row.children].map((n) => n.className.split(" ")[0]))
      .toEqual(["msg-timestamp", "turn-tail"]);
    // 最新一轮常显(Mac 口径)。
    expect(row.classList.contains("always")).toBe(true);
  });

  it("turnTail 带收尾消息时给出复制 + 分叉,顺序为 复制→分叉→时钟", () => {
    const c = mount();
    const forked = [];
    const r = createChatRenderer(c, { onFork: (n) => forked.push(n) });
    const tail = Object.assign(turnTailNode({ turn: 1, seq: 9, time: 1 }),
      { ttftMs: 250, messageId: "m1", closingText: "hi" });
    r.render([tail]);
    const row = c.querySelector(".turn-tail-actions");
    expect([...row.children].map((n) => n.className.split(" ")[0]))
      .toEqual(["act-btn", "act-btn", "msg-timestamp", "turn-tail"]);
    // 分叉按 turn/end 的 seq 落点(assistant step 的 seq 会被服务端以 OPEN_TURN 拒绝)。
    const fork = [...row.querySelectorAll(".act-btn")].find((b) => b.title === t("fork"));
    expect(fork.disabled).toBe(false);
    fork.click();
    expect(forked).toHaveLength(1);
    expect(forked[0].seq).toBe(9);
  });

  it("每个完成轮次的 turnTail 都可分叉;只有最新一轮常显", () => {
    const c = mount();
    const r = createChatRenderer(c, { onFork: () => {} });
    const t1 = Object.assign(turnTailNode({ turn: 1, seq: 9, time: 1 }), { messageId: "m1", closingText: "a" });
    r.render([t1]);
    const rowOf = (i) => c.querySelectorAll(".turn-tail-actions")[i];
    const forkOf = (i) => [...rowOf(i).querySelectorAll(".act-btn")].find((b) => b.title === t("fork"));
    expect(forkOf(0).disabled).toBe(false);
    expect(rowOf(0).classList.contains("always")).toBe(true);
    // 交互口径=Mac:旧轮次依然可分叉,只是动作行改为 hover 浮现。
    const t2 = Object.assign(turnTailNode({ turn: 2, seq: 20, time: 2 }), { messageId: "m2", closingText: "b" });
    r.render([t1, t2]);
    expect(forkOf(0).disabled).toBe(false);
    expect(rowOf(0).classList.contains("always")).toBe(false);
    expect(forkOf(1).disabled).toBe(false);
    expect(rowOf(1).classList.contains("always")).toBe(true);
  });

  it("turnTail 渲染本轮产出 chips 与 present 交付卡,点击走 openPath", () => {
    const c = mount();
    const opened = [];
    const r = createChatRenderer(c, {
      getContext: () => ({
        producedPaths: (turn) => (turn === 1 ? ["out/a.txt", "out/b.txt"] : []),
        presentedFiles: (turn) => (turn === 1
          ? [{ seq: 5, index: 0, path: "reports/x.md", description: "报告" }]
          : []),
        onOpenPath: (p) => opened.push(p)
      })
    });
    const tail = Object.assign(turnTailNode({ turn: 1, seq: 9, time: 1 }),
      { ttftMs: 250, messageId: "m1", closingText: "hi" });
    r.render([tail]);
    expect(c.querySelectorAll(".turn-produce-chip")).toHaveLength(2);
    expect(c.querySelector(".turn-produce-chip").textContent).toContain("a.txt");
    expect(c.querySelector(".turn-produce-chip .turn-produce-name").textContent).toBe("a.txt");
    c.querySelector(".turn-produce-chip").click();
    expect(opened).toEqual(["out/a.txt"]);
    const present = c.querySelector(".turn-present-card");
    expect(present.querySelector(".turn-present-name").textContent).toBe("x.md");
    // lucide 线稿:图标盒里是 svg,不再用扩展名文字。
    expect(present.querySelector(".turn-present-icon svg")).toBeTruthy();
    expect(present.querySelector(".turn-present-icon").classList.contains("file-type-markdown")).toBe(true);
    expect(present.querySelector(".turn-present-desc").textContent).toBe("报告");
    present.click();
    expect(opened).toEqual(["out/a.txt", "reports/x.md"]);
    c.querySelector(".turn-present-open").click();
    expect(opened).toEqual(["out/a.txt", "reports/x.md", "reports/x.md"]);
    // 产出在图标动作行之前(web TurnTail chain / mac ProducedFilesRow)。
    const wrap = c.querySelector(".turn-tail-node");
    expect([...wrap.children].map((n) => n.className.split(" ")[0]))
      .toEqual(["turn-produces", "turn-presents", "msg-actions"]);
  });

  it("交付卡按会话 cwd 解析相对路径;菜单区分默认应用打开与在 Finder 中显示", () => {
    const c = mount();
    const opened = [];
    const revealed = [];
    const r = createChatRenderer(c, {
      getContext: () => ({
        cwd: "/work",
        presentedFiles: () => [{ seq: 5, index: 0, path: "reports/x.md", description: "报告" }],
        onOpenPath: (p) => opened.push(p),
        onRevealPath: (p) => revealed.push(p)
      })
    });
    r.render([Object.assign(turnTailNode({ turn: 1, seq: 9, time: 1 }),
      { messageId: "m1", closingText: "hi" })]);
    // 卡片整体点击 = 默认应用打开;相对路径必须先按 cwd 补绝对,
    // 否则宿主会把 open 到自己的工作目录(实测)。
    c.querySelector(".turn-present-card").click();
    expect(opened).toEqual(["/work/reports/x.md"]);
    const chevron = c.querySelector(".turn-present-chevron");
    expect(chevron.querySelector("svg")).toBeTruthy();
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    chevron.click();
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    expect(c.querySelector(".turn-present-menu").classList.contains("open")).toBe(true);
    const items = c.querySelectorAll(".turn-present-menu-item");
    expect([...items].map((n) => n.textContent)).toEqual([
      t("turn.openWithDefault"), t("turn.revealInFolder")
    ]);
    items[0].click();
    expect(opened).toEqual(["/work/reports/x.md", "/work/reports/x.md"]);
    items[1].click();
    expect(revealed).toEqual(["/work/reports/x.md"]);
    expect(c.querySelector(".turn-present-menu").classList.contains("open")).toBe(false);
  });

  it("收尾 assistant 的行内 code 产出路径可点;非收尾不装饰", () => {
    const c = mount();
    const opened = [];
    const r = createChatRenderer(c, {
      getContext: () => ({
        producedPaths: () => ["out/a.txt"],
        onOpenPath: (p) => opened.push(p)
      })
    });
    const closing = assistantWith([text("done \`a.txt\`")], { closing: true, messageId: "m1" });
    r.render([closing]);
    const btn = c.querySelector(".mention-link");
    expect(btn).toBeTruthy();
    btn.click();
    expect(opened).toEqual(["out/a.txt"]);
    // 非 closing:同一路径保持普通 code。
    r.render([assistantWith([text("done \`a.txt\`")], { closing: false, messageId: "m1" })]);
    expect(c.querySelector(".mention-link")).toBeNull();
    expect(c.querySelector(".msg-agent code")).toBeTruthy();
  });

  it("同一 assistant 流式追加复用 text 元素与冻结前缀", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.render([assistantWith([text("para one\n\npara two\n\npara three")], { status: AssistantStatus.running })]);
    const body = c.querySelector(".msg-agent");
    const head = body.querySelector(".md-head");
    r.render([assistantWith([text("para one\n\npara two\n\npara three four")], { status: AssistantStatus.running })]);
    expect(c.querySelector(".msg-agent")).toBe(body);
    expect(c.querySelector(".md-head")).toBe(head);
    expect(c.querySelector(".md-tail").textContent).toContain("three four");
  });

  it("turnProcess 折叠头默认收起,点击展开成员,独立行不受影响", () => {
    const c = mount();
    const r = createChatRenderer(c);
    const process = Object.assign(turnProcessNode({
      turn: 1, seq: 10, controlAnchorSeq: 10, processStartSeq: 9,
      answerAnchorSeq: 13, answerStep: 1, inlineReasoning: true,
      messageCount: 0, toolCallCount: 1, subagentCount: 0, memberCount: 2
    }), {});
    const step0 = Object.assign(assistantWith([text("hmm")], { closing: false, messageId: "m0" }), { firstVisibleSeq: 10 });
    const call = toolCallNode({ callId: "c1", name: "read", argsRaw: "{}", turn: 1, step: 0, startSeq: 11, time: 1 });
    const answer = Object.assign(assistantWith([text("final")], { closing: true, messageId: "m1" }), { firstVisibleSeq: 13, step: 1 });
    const user = userNode({ seq: 8, time: 1, messageId: "u1", content: [{ type: "text", text: "ask" }] });
    r.render([user, process, step0, call, answer]);

    const head = c.querySelector(".turn-process");
    expect(head.textContent).toContain("1 tool calls");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector('[data-node-id="a-1:0"]').hidden).toBe(true);
    expect(c.querySelector('[data-node-id="t-c1"]').hidden).toBe(true);
    // 答案与用户消息不折叠。
    expect(c.querySelector('[data-node-id="a-1:1"]').hidden).toBe(false);
    expect(c.querySelector('[data-node-id="u-u1"]').hidden).toBe(false);

    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(c.querySelector('[data-node-id="a-1:0"]').hidden).toBe(false);
    expect(c.querySelector('[data-node-id="t-c1"]').hidden).toBe(false);

    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector('[data-node-id="t-c1"]').hidden).toBe(true);
  });

  it("未知 assistant 块渲染成 JSON 入口,点击看原文", () => {
    const c = mount();
    createChatRenderer(c).render([assistantWith([{ type: "other", value: { type: "video", url: "https://e.com/v" } }])]);
    const summary = c.querySelector(".unknown-summary");
    expect(summary.textContent).toContain("video");
    expect(c.querySelector(".msg-agent pre")).toBeNull();
    summary.click();
    expect(detailBody().textContent).toContain("https://e.com/v");
  });

  it("workflow 按 phase 渲染成员", () => {
    const c = mount();
    createChatRenderer(c).render([workflowRunNode({
      runId: "w", name: "audit", status: "running", anchorSeq: 1,
      phases: [{ key: "p", phase: "scan", members: [{ seq: 1, label: "a", childId: "c", status: "running" }] }]
    })]);
    expect(c.querySelector(".workflow-member-label")).toBeNull();
    c.querySelector(".workflow-header").click();
    expect(detailBody().querySelector(".workflow-member-label").textContent).toBe("a");
  });

  it("未知事件保留可折叠的原始 JSON 行", () => {
    const c = mount();
    createChatRenderer(c).render([unknownSurfaceNode({ seq: 1, time: 1, type: "x/y", data: { a: 1 } })]);
    expect(c.querySelector(".unknown-summary").textContent).toContain("x/y");
    expect(c.querySelector(".unknown-node pre")).toBeNull();
    c.querySelector(".unknown-summary").click();
    expect(detailBody().querySelector("pre").textContent).toContain('"a": 1');
  });
});

describe("按 id 对账", () => {
  it("中间插入新行不重建既有行", () => {
    const c = mount();
    const r = createChatRenderer(c);
    const u1 = userNode({ seq: 1, time: 1, messageId: "m1", content: [text("一")] });
    const u3 = userNode({ seq: 3, time: 3, messageId: "m3", content: [text("三")] });
    r.render([u1, u3]);
    const first = c.children[0];
    const last = c.children[1];
    r.render([u1, userNode({ seq: 2, time: 2, messageId: "m2", content: [text("二")] }), u3]);
    expect(c.children[0]).toBe(first);
    expect(c.children[2]).toBe(last);
    expect(c.children[1].textContent).toContain("二");
  });

  it("消失的行被移除(重试抹除)", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.render([assistantWith([text("坏")])]);
    expect(c.querySelector(".msg-turn")).toBeTruthy();
    r.render([]);
    expect(c.querySelector(".msg-turn")).toBeNull();
  });

  it("reset 清空全部", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.render([userNode({ seq: 1, time: 1, messageId: "m1", content: [text("x")] })]);
    r.reset();
    expect(c.children).toHaveLength(0);
    expect(r.count).toBe(0);
  });
});

describe("状态文案", () => {
  const running = (nodes) => ({ running: true, nodes });

  it("等待 turn 开始时报准备中", () => {
    expect(agentStatusLabel({ running: false, nodes: [] }, { awaitingTurnStart: true })).toBe("Preparing session…");
  });

  it("空闲返回 null", () => {
    expect(agentStatusLabel({ running: false, nodes: [] })).toBeNull();
  });

  it("刚发出用户消息 → 等待模型", () => {
    expect(agentStatusLabel(running([userNode({ seq: 1, time: 1, messageId: "m", content: [] })]))).toBe("Waiting for model…");
  });

  it("assistant 流式 → 生成中", () => {
    const a = assistantNode({ turn: 1, step: 0, startSeq: 2, time: 1 });
    a.blocks = [text("部分")];
    expect(agentStatusLabel(running([a]))).toBe("Generating reply…");
  });

  it("有工具在跑 → 报该工具摘要", () => {
    const tool = toolCallNode({ callId: "c", name: "bash", argsRaw: '{"command":"npm test"}', turn: 1, step: 0, startSeq: 3, time: 1 });
    expect(agentStatusLabel(running([tool]))).toBe("npm test");
  });

  it("流式 reasoning 交给 thinking 指示", () => {
    const a = assistantNode({ turn: 1, step: 0, startSeq: 2, time: 1 });
    a.blocks = [{ type: "reasoning", text: "想" }];
    const snap = running([a]);
    expect(isThinking(snap)).toBe(true);
    expect(agentStatusLabel(snap)).toBeNull();
  });

  it("已产出文本后不再算思考中", () => {
    const a = assistantNode({ turn: 1, step: 0, startSeq: 2, time: 1 });
    a.blocks = [{ type: "reasoning", text: "想" }, text("答")];
    expect(isThinking(running([a]))).toBe(false);
  });
});

describe("等待指示", () => {
  it("setTyping 显示文案并贴底", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.render([userNode({ seq: 1, time: 1, messageId: "m", content: [text("x")] })]);
    r.setTyping(true, "工作中");
    expect(c.lastElementChild.classList.contains("typing-indicator")).toBe(true);
    expect(c.querySelector(".typing-label").textContent).toBe("工作中");
    r.setTyping(false);
    expect(c.querySelector(".typing-indicator")).toBeNull();
  });

  it("working → thinking 切换不残留", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.setTyping(true, "工作中");
    r.setThinking(true);
    expect(c.querySelectorAll(".typing-indicator")).toHaveLength(1);
    expect(c.querySelector(".typing-indicator").classList.contains("thinking")).toBe(true);
    r.setThinking(false);
    expect(c.querySelector(".typing-indicator")).toBeNull();
  });
});

// 回归:一条用户消息被重复画出 N 遍。
//
// 触发链(真实日志复现):带 surfaceOp 的事件让 store 走整窗重放 → 每次 rebuild
// 都产出**新的**节点对象 → 用户行不支持原地更新,渲染器走 replaceWith 重建。
// 旧代码在 replaceWith 之后仍拿已脱离容器的旧元素当 insertBefore 的锚点,
// 抛 NotFoundError 中断整趟渲染:rendered 表没回写,这一趟建出的元素成了
// 无人认领的孤儿,每来一条事件就再攒一份。
describe("对账健壮性", () => {
  const t2 = (x) => ({ type: "text", text: x });
  const mkUser = () => userNode({ seq: 1, time: 1, messageId: "m1", content: [t2("hi")] });

  it("重建的行正好是游标时不中断渲染,也不留孤儿", () => {
    const c = mount();
    const r = createChatRenderer(c);
    r.render([mkUser(), assistantWith([t2("答")])]);
    expect(() => {
      for (let i = 0; i < 5; i++) r.render([mkUser(), assistantWith([t2("答" + i)])]);
    }).not.toThrow();
    expect(c.querySelectorAll(".msg-user-turn")).toHaveLength(1);
    expect(c.querySelectorAll(".msg-turn")).toHaveLength(1);
  });

  it("同一 id 在一趟里出现两次也不堆积", () => {
    const c = mount();
    const r = createChatRenderer(c);
    for (let i = 0; i < 4; i++) r.render([mkUser(), mkUser()]);
    expect(c.querySelectorAll(".msg-user-turn")).toHaveLength(1);
  });
});
