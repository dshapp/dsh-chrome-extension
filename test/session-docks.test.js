// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  mountGoalBar, mountTodoPanel, mountStatsBar,
  activeGoal, contextRatio, statsText, statsRows, formatTokens, formatDuration,
  formatStatsDuration, formatStatsTokens
} from "../src/features/docks/session-docks.js";
import { presetDisplayName, presetMenuLabel } from "../src/app/sidepanel/composer-dock.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("en"));
const mount = () => { const c = document.createElement("div"); document.body.append(c); return c; };
// 统计条现在是"底栏药丸 + popover 详情"两段结构。
const mountStats = () => {
  const trigger = document.createElement("button");
  trigger.innerHTML = '<span class="stats-ring"></span>';
  const menu = document.createElement("div");
  document.body.append(trigger, menu);
  return { trigger, menu };
};
const goal = (over = {}) => ({ id: "g1", revision: 1, objective: "做完这件事", phase: "active", blockedMessage: null, ...over });

describe("activeGoal 折叠", () => {
  it("无目标或已完成都视为无", () => {
    expect(activeGoal(null)).toBeNull();
    expect(activeGoal(goal({ phase: "complete" }))).toBeNull();
  });
  it("active/paused/blocked 都算生效中", () => {
    for (const phase of ["active", "paused", "blocked"]) {
      expect(activeGoal(goal({ phase }))).not.toBeNull();
    }
  });
});

describe("目标条", () => {
  const handlers = () => ({
    onPause: vi.fn().mockResolvedValue(), onResume: vi.fn().mockResolvedValue(),
    onEdit: vi.fn().mockResolvedValue(), onClear: vi.fn().mockResolvedValue()
  });

  it("无目标时整条隐藏", () => {
    const c = mount();
    mountGoalBar(c, handlers()).set(null);
    expect(c.hidden).toBe(true);
  });

  it("显示目标内容与阶段", () => {
    const c = mount();
    mountGoalBar(c, handlers()).set(goal());
    expect(c.hidden).toBe(false);
    expect(c.querySelector(".goal-objective").textContent).toBe("做完这件事");
    expect(c.querySelector(".goal-label").textContent).toBe("Goal");
  });

  it("active 显示暂停,paused 显示继续", () => {
    const c = mount();
    const h = handlers();
    const bar = mountGoalBar(c, h);
    bar.set(goal());
    const buttons = () => [...c.querySelectorAll(".goal-btn")].map((b) => b.title);
    expect(buttons()).toContain("Pause goal");
    bar.set(goal({ phase: "paused" }));
    expect(buttons()).toContain("Resume goal");
  });

  it("blocked 阶段把原因挂成 tooltip", () => {
    const c = mount();
    mountGoalBar(c, handlers()).set(goal({ phase: "blocked", blockedMessage: "缺少凭据" }));
    expect(c.querySelector(".goal-objective").title).toBe("缺少凭据");
  });

  it("点击暂停触发回调", async () => {
    const c = mount();
    const h = handlers();
    mountGoalBar(c, h).set(goal());
    [...c.querySelectorAll(".goal-btn")].find((b) => b.title === "Pause goal").click();
    await Promise.resolve();
    expect(h.onPause).toHaveBeenCalled();
  });

  it("编辑:回车提交修改后的内容", async () => {
    const c = mount();
    const h = handlers();
    mountGoalBar(c, h).set(goal());
    [...c.querySelectorAll(".goal-btn")].find((b) => b.title === "Edit goal").click();
    const input = c.querySelector(".goal-edit-input");
    expect(input.value).toBe("做完这件事");
    input.value = "改成这个";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(h.onEdit).toHaveBeenCalledWith("改成这个");
  });

  it("编辑:Escape 取消且不提交", () => {
    const c = mount();
    const h = handlers();
    mountGoalBar(c, h).set(goal());
    [...c.querySelectorAll(".goal-btn")].find((b) => b.title === "Edit goal").click();
    const input = c.querySelector(".goal-edit-input");
    input.value = "不要保存";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.onEdit).not.toHaveBeenCalled();
    expect(c.querySelector(".goal-edit-input")).toBeNull();
  });

  it("空白内容不提交", async () => {
    const c = mount();
    const h = handlers();
    mountGoalBar(c, h).set(goal());
    [...c.querySelectorAll(".goal-btn")].find((b) => b.title === "Edit goal").click();
    const input = c.querySelector(".goal-edit-input");
    input.value = "   ";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it("目标身份变化时作废未提交的编辑(否则会写到新目标上)", () => {
    const c = mount();
    const bar = mountGoalBar(c, handlers());
    bar.set(goal());
    [...c.querySelectorAll(".goal-btn")].find((b) => b.title === "Edit goal").click();
    expect(c.querySelector(".goal-edit-input")).toBeTruthy();
    bar.set(goal({ id: "g2", objective: "另一个目标" }));
    expect(c.querySelector(".goal-edit-input")).toBeNull();
    expect(c.querySelector(".goal-objective").textContent).toBe("另一个目标");
  });
});

describe("待办面板", () => {
  const todos = [
    { content: "第一件", status: "completed" },
    { content: "第二件", status: "in_progress" },
    { content: "第三件", status: "pending" }
  ];

  it("无待办时隐藏", () => {
    const c = mount();
    mountTodoPanel(c).set([]);
    expect(c.hidden).toBe(true);
  });

  // 对齐 Mac 的 progressLabel:分状态计数,顺序为 已完成 → 待处理 → 进行中,
  // 每段各自配色;标题是当前进行中的那条(headerTitle)。
  it("折叠态按状态分段计数,标题为进行中的那条", () => {
    const c = mount();
    mountTodoPanel(c).set(todos);
    expect([...c.querySelectorAll(".todo-seg")].map((n) => n.textContent))
      .toEqual(["1 completed", "1 pending", "1 in progress"]);
    expect(c.querySelector(".todo-current").textContent).toBe("第二件");
  });

  it("计数只列出非零的状态段", () => {
    const c = mount();
    mountTodoPanel(c).set([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" }
    ]);
    expect([...c.querySelectorAll(".todo-seg")].map((n) => n.textContent))
      .toEqual(["2 in progress"]);
  });

  it("无进行中项时标题回退为通用标签", () => {
    const c = mount();
    mountTodoPanel(c).set([{ content: "a", status: "pending" }]);
    expect(c.querySelector(".todo-current").textContent).toBe("Todos");
  });

  it("展开后逐条列出并带状态类", () => {
    const c = mount();
    mountTodoPanel(c).set(todos);
    const items = c.querySelectorAll(".todo-item");
    expect(items).toHaveLength(3);
    expect(items[0].classList.contains("todo-completed")).toBe(true);
    expect(items[1].classList.contains("todo-in_progress")).toBe(true);
  });

  it("点击标题可折叠", () => {
    const c = mount();
    mountTodoPanel(c).set(todos);
    expect(c.querySelector(".todo-list")).toBeTruthy();
    c.querySelector(".todo-head").click();
    expect(c.querySelector(".todo-list")).toBeNull();
  });
});

describe("上下文与统计", () => {
  it("contextRatio 用 projected 优先并夹紧到 0..1", () => {
    expect(contextRatio({ projectedTokens: 500, pressureTokens: 100, contextWindow: 1000 })).toBe(0.5);
    expect(contextRatio({ pressureTokens: 250, contextWindow: 1000 })).toBe(0.25);
    expect(contextRatio({ projectedTokens: 5000, contextWindow: 1000 })).toBe(1);
    expect(contextRatio({ contextWindow: 0 })).toBeNull();
    expect(contextRatio(null)).toBeNull();
  });

  it("formatTokens / formatDuration 人读", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });

  it("统计行合并轮次、耗时、速度与计费", () => {
    const text = statsText(
      { turns: 4, steps: 183, llmMs: 2928815, toolMs: 697367, ttftMs: 521784, ttftSteps: 184, decodeMs: 2407031, decodeTokens: 234165 },
      { uncachedInputTokens: 368, outputTokens: 234165, cacheReadTokens: 52780826, cacheWriteTokens: 580101 }
    );
    expect(text).toContain("4 turns");
    expect(text).toContain("183 steps");
    expect(text).toContain("LLM");
    expect(text).toContain("tok/s");
    expect(text).toContain("↑");   // 计费输入
    expect(text).toContain("↓");   // 输出
  });

  it("无统计与用量时为空", () => {
    expect(statsText(null, null)).toBe("");
    expect(statsText({ turns: 0, steps: 0 }, null)).toBe("");
  });

  it("高占用给出预警与压缩入口", () => {
    const { trigger, menu } = mountStats();
    const onCompact = vi.fn();
    const bar = mountStatsBar(trigger, menu, { onCompact });
    bar.set({ contextPressure: { projectedTokens: 950, contextWindow: 1000 }, sessionStats: null, tokenUsage: null });
    expect(menu.querySelector(".context-meter").classList.contains("critical")).toBe(true);
    expect(trigger.classList.contains("critical")).toBe(true);
    menu.querySelector(".context-compact").click();
    expect(onCompact).toHaveBeenCalled();
  });

  it("低占用不显示压缩入口", () => {
    const { trigger, menu } = mountStats();
    mountStatsBar(trigger, menu, { onCompact: vi.fn() }).set({
      contextPressure: { projectedTokens: 100, contextWindow: 1000 }, sessionStats: null, tokenUsage: null
    });
    expect(menu.querySelector(".context-compact")).toBeNull();
    expect(menu.querySelector(".stats-menu-title").textContent).toContain("10%");
    // 触发钮上只剩圆环:占比走 CSS 变量,读数只在浮层里(不挂 title)。
    expect(trigger.querySelector(".stats-ring").style.getPropertyValue("--stats-pct")).toBe("10%");
    expect(trigger.title).toBe("");
    expect(trigger.getAttribute("aria-label")).toContain("10%");
  });

  it("完全无数据时药丸隐藏且浮层清空", () => {
    const { trigger, menu } = mountStats();
    mountStatsBar(trigger, menu, {}).set({ contextPressure: null, sessionStats: null, tokenUsage: null });
    expect(trigger.hidden).toBe(true);
    expect(menu.children.length).toBe(0);
  });

  it("详情浮层把统计拆成键值行", () => {
    const { trigger, menu } = mountStats();
    mountStatsBar(trigger, menu, {}).set({
      contextPressure: null,
      sessionStats: { turns: 3, steps: 12, llmMs: 4200, toolMs: 900, ttftMs: 2400, ttftSteps: 12, decodeMs: 3000, decodeTokens: 600 },
      tokenUsage: { uncachedInputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 50 }
    });
    expect(trigger.hidden).toBe(false);
    // 无上下文投影时药丸退回步数摘要
    // 无上下文读数时环画成空槽,按钮不再显示任何文字。
    expect(trigger.querySelector(".stats-ring").style.getPropertyValue("--stats-pct")).toBe("0%");
    expect(trigger.textContent.trim()).toBe("");
    const keys = [...menu.querySelectorAll(".stats-row-value")].map((n) => n.dataset.key);
    expect(keys).toEqual(["turns", "llm", "tool", "ttft", "tps", "input", "cache", "output"]);
    const byKey = (k) => menu.querySelector(`.stats-row-value[data-key="${k}"]`).textContent;
    expect(byKey("cache")).toBe("80%");   // 800 / (200+800+0)
    expect(byKey("tps")).toContain("200"); // 600 tok / 3s
  });

  it("预设名显示在浮层里(有上下文读数时跟在 head 后)", () => {
    const { menu } = mountStats();
    mountStatsBar(menu.ownerDocument.createElement("button"), menu, {}).set({
      contextPressure: { projectedTokens: 100, contextWindow: 1000 },
      sessionStats: null, tokenUsage: null, presetName: "code-with-eye"
    });
    expect(menu.querySelector(".stats-menu-preset").textContent).toBe("code-with-eye");
  });

  it("没有上下文读数时预设名仍有落点", () => {
    const { trigger, menu } = mountStats();
    mountStatsBar(trigger, menu, {}).set({
      contextPressure: null,
      sessionStats: { turns: 1, steps: 2 }, tokenUsage: null, presetName: "PTC 模式"
    });
    expect(menu.querySelector(".stats-menu-preset").textContent).toBe("PTC 模式");
  });

  it("无预设名时不画那一段", () => {
    const { trigger, menu } = mountStats();
    mountStatsBar(trigger, menu, {}).set({
      contextPressure: { projectedTokens: 100, contextWindow: 1000 },
      sessionStats: null, tokenUsage: null, presetName: null
    });
    expect(menu.querySelector(".stats-menu-preset")).toBeNull();
  });

  it("statsRows 无数据为空", () => {
    expect(statsRows(null, null)).toEqual([]);
    expect(statsRows({ turns: 0, steps: 0 }, null)).toEqual([]);
  });
});

// 统计数字的格式化:与 Mac StatsLine 逐字对齐(统计行已撤,格式化仍供浮层使用)。
describe("统计数字格式化", () => {
  it("Mac 专用格式:60s 内保留一位小数、分秒不留空格、token 恒一位小数", () => {
    expect(formatStatsDuration(54700)).toBe("54.7s");
    expect(formatStatsDuration(1900)).toBe("1.9s");
    expect(formatStatsDuration(20 * 60 * 1000 + 8 * 1000)).toBe("20m8s");
    expect(formatStatsDuration(30000)).toBe("30s");
    expect(formatStatsDuration(0)).toBe("0s");
    expect(formatStatsTokens(17800000)).toBe("17.8M");
    expect(formatStatsTokens(84500)).toBe("84.5K");
    expect(formatStatsTokens(999)).toBe("999");
  });
});

// 当前模式名:出厂预设走本地化文案(Mac agentPresetDisplayText),
// 用户自建预设保留其自有 name 并在菜单里追加自定义标记。
describe("预设展示名", () => {
  const sys = (id, name) => ({ id, trust: "system", name });

  it("出厂预设用本地化文案,code 即 PTC 模式", () => {
    setLang("zh");
    expect(presetDisplayName(sys("code", "Code"))).toBe("PTC 模式");
    expect(presetDisplayName(sys("standard", "Standard"))).toBe("标准模式");
    expect(presetDisplayName(sys("minimal", "Minimal"))).toBe("极简模式");
    expect(presetDisplayName(sys("cordis", "Cordis"))).toBe("创造模式");
    setLang("en");
    expect(presetDisplayName(sys("code", "Code"))).toBe("Code mode");
  });

  it("未知 id 的出厂预设退回宿主 name", () => {
    expect(presetDisplayName(sys("whatever", "Host Name"))).toBe("Host Name");
  });

  it("用户自建预设不翻译,菜单里标记为自定义", () => {
    const own = { id: "mine", trust: "user", name: "我的预设" };
    expect(presetDisplayName(own)).toBe("我的预设");
    expect(presetMenuLabel(own)).toBe("我的预设 · Custom");
    // 出厂预设不带标记
    expect(presetMenuLabel(sys("code", "Code"))).toBe("Code mode");
  });

  it("无预设或无名时为空", () => {
    expect(presetDisplayName(null)).toBeNull();
    expect(presetMenuLabel(null)).toBe("");
    expect(presetDisplayName({ id: "x" })).toBe("x");
  });
});
