// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { mountTrajectoryPane } from "../src/features/trajectory/trajectory-view.js";
import { assembleTrajectory } from "../src/features/trajectory/trajectory-model.js";
import { _resetCardDetail } from "../src/features/chat/card-detail.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));
beforeEach(() => _resetCardDetail());

/// 真实事件窗口 → 轨迹快照,视图与装配走同一条路。
function trajectory() {
  const raw = [
    ["system/message", { message: { content: [{ type: "text", text: "SYS" }] } }],
    ["request/header", { reason: "initial", header: { config: { provider: "p", model: "m" }, tools: [{ name: "bash" }] } }],
    ["user/message", { id: "m1", content: [{ type: "text", text: "第一问" }], source: { kind: "user" } }],
    ["step/start", { turn: 1, step: 1 }],
    ["assistant/message", { turn: 1, step: 1, message: { content: [
      { type: "text", text: "回答" },
      { type: "tool-call", id: "c1", name: "bash", arguments: "ls" }
    ], source: { provider: "p", model: "m" } } }],
    ["tool/result", { message: { content: [{ type: "tool-result", toolCallId: "c1", isError: false, content: [{ type: "text", text: "ok" }] }] } }]
  ];
  const entries = raw.map(([type, data], index) => ({
    event: { type, seq: index + 1, time: 1000 + index, data },
    view: {}
  }));
  return assembleTrajectory(entries);
}

function mount() {
  document.body.innerHTML = `
    <div id="messages">
      <div id="msg-list"></div>
      <div id="trajectory-pane" hidden>
        <div class="trajectory-toolbar" role="toolbar">
          <button class="trajectory-toggle" data-action="turns" type="button"></button>
          <button class="trajectory-toggle" data-action="calls" type="button"></button>
          <div class="trajectory-search">
            <input id="trajectory-search" type="search" />
            <button class="trajectory-search-clear" type="button" hidden></button>
          </div>
          <button class="trajectory-close" type="button"></button>
        </div>
        <div class="trajectory-load-earlier" hidden>
          <button class="trajectory-load-btn" type="button"></button>
        </div>
        <div id="trajectory-ledger"></div>
      </div>
    </div>`;
  const pane = document.querySelector("#trajectory-pane");
  const ledger = document.querySelector("#trajectory-ledger");
  const snap = trajectory();
  let more = false;
  let loads = 0;
  let closes = 0;
  const view = mountTrajectoryPane({
    pane,
    ledger,
    getTrajectory: () => snap,
    hasMore: () => more,
    onLoadEarlier: async () => { loads += 1; more = false; },
    onClose: () => { closes += 1; }
  });
  return {
    pane, ledger, view, snap,
    setMore: (value) => { more = value; },
    loads: () => loads,
    closes: () => closes
  };
}

describe("轨迹视图", () => {
  it("打开后显示台账并给 #messages 打上 trajectory-open", () => {
    const { pane, ledger, view } = mount();
    view.open();
    expect(pane.hidden).toBe(false);
    expect(document.querySelector("#messages").classList.contains("trajectory-open")).toBe(true);
    expect(ledger.querySelectorAll(".trajectory-row").length).toBeGreaterThan(0);
    // 初始系统提示词、用户消息、助手、工具都在。
    expect(ledger.querySelector(".kind-system")).toBeTruthy();
    expect(ledger.querySelector(".kind-user")).toBeTruthy();
    expect(ledger.querySelector(".kind-assistant")).toBeTruthy();
    expect(ledger.querySelector(".kind-tool")).toBeTruthy();
  });

  it("行上带请求编号与状态点", () => {
    const { ledger, view } = mount();
    view.open();
    const meta = ledger.querySelector(".trajectory-row.kind-assistant .trajectory-row-meta").textContent;
    expect(meta).toContain("Request #");
    expect(ledger.querySelector(".trajectory-status-dot")).toBeTruthy();
  });

  it("搜索只留命中行,清空后恢复", () => {
    const { ledger, view } = mount();
    view.open();
    const input = document.querySelector("#trajectory-search");
    input.value = "第一问";
    input.dispatchEvent(new Event("input"));
    expect(ledger.querySelectorAll(".trajectory-row")).toHaveLength(1);
    expect(ledger.querySelector(".trajectory-row").classList.contains("kind-user")).toBe(true);
    // 系统提示词会命中所有共享该请求的记录(请求级搜索面)。
    input.value = "SYS";
    input.dispatchEvent(new Event("input"));
    expect(ledger.querySelectorAll(".trajectory-row").length).toBeGreaterThan(1);
    document.querySelector(".trajectory-search-clear").click();
    expect(ledger.querySelectorAll(".trajectory-row").length).toBeGreaterThan(1);
  });

  it("轮次折叠按钮把整轮折成摘要行", () => {
    const { ledger, view } = mount();
    view.open();
    const turns = document.querySelector('[data-action="turns"]');
    turns.click();
    expect(ledger.querySelector(".trajectory-folded-summary")).toBeTruthy();
    // 折叠保留轮内首行(初始系统提示词),其余藏进摘要。
    expect(ledger.querySelector(".trajectory-kind.kind-system")).toBeTruthy();
    expect(ledger.querySelector(".trajectory-kind.kind-user")).toBeFalsy();
  });

  it("调用折叠按钮隐藏工具行", () => {
    const { ledger, view } = mount();
    view.open();
    document.querySelector('[data-action="calls"]').click();
    expect(ledger.querySelector(".kind-tool")).toBeFalsy();
    expect(ledger.querySelector(".kind-assistant")).toBeTruthy();
  });

  it("点击行打开详情模态", () => {
    const { ledger, view } = mount();
    view.open();
    ledger.querySelector(".trajectory-row.kind-assistant").click();
    const dialog = document.querySelector("dialog.card-detail");
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector(".card-detail-title").textContent).toContain("助手");
    expect(dialog.querySelector(".card-detail-body").textContent).toContain("回答");
  });

  it("关闭后隐藏并移除类,且通知调用方持久化", () => {
    const h = mount();
    h.view.open();
    document.querySelector(".trajectory-close").click();
    expect(h.pane.hidden).toBe(true);
    expect(document.querySelector("#messages").classList.contains("trajectory-open")).toBe(false);
    expect(h.closes()).toBe(1);
  });

  it("有更早历史时显示加载按钮,点击后收起", async () => {
    const h = mount();
    h.setMore(true);
    h.view.open();
    const earlier = document.querySelector(".trajectory-load-earlier");
    expect(earlier.hidden).toBe(false);
    document.querySelector(".trajectory-load-btn").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loads()).toBe(1);
    expect(earlier.hidden).toBe(true);
  });

  it("⌘F 可聚焦搜索框", () => {
    const { view } = mount();
    view.open();
    view.focusSearch();
    expect(document.activeElement.id).toBe("trajectory-search");
  });

  it("空轨迹给出空态文案", () => {
    document.body.innerHTML = `
      <div id="messages"><div id="trajectory-pane" hidden>
        <div class="trajectory-toolbar"></div><div id="trajectory-ledger"></div>
      </div></div>`;
    const pane = document.querySelector("#trajectory-pane");
    const ledger = document.querySelector("#trajectory-ledger");
    const view = mountTrajectoryPane({
      pane, ledger,
      getTrajectory: () => ({ records: [], requests: [] }),
      hasMore: () => false
    });
    view.open();
    expect(ledger.querySelector(".trajectory-empty").textContent).toBe("暂无轨迹记录");
  });
});
