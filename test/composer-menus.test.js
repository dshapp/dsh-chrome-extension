// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createComposerMenus } from "../src/app/sidepanel/composer-menus.js";
import { t } from "../src/shared/i18n.js";

// jsdom 未实现原生 Popover API,用最小 stub 模拟 showPopover/hidePopover/:popover-open。
function stubPopover(el) {
  let open = false;
  el.showPopover = () => { open = true; };
  el.hidePopover = () => { open = false; };
  el.matches = (selector) => (selector === ":popover-open" ? open : false);
  return el;
}

function setup({ skills = [], commands = [] } = {}) {
  const dom = new JSDOM("<!DOCTYPE html><body></body></html>");
  const doc = dom.window.document;
  const elements = {
    input: doc.createElement("textarea"),
    skillsMenu: stubPopover(doc.createElement("div")),
    modelMenu: doc.createElement("div"),
    modelLabel: doc.createElement("span"),
    permBtn: doc.createElement("button"),
    permMenu: doc.createElement("div")
  };
  const state = { sessionId: "s1" };
  const deps = {
    skills: { skills, refresh: vi.fn() },
    commands: { commands, refresh: vi.fn(), execute: vi.fn() },
    sessions: {}
  };
  const menus = createComposerMenus({ elements, deps, state, showToast: vi.fn(), format: (e) => String(e) });
  return { elements, deps, menus };
}

function menuItemIds(menu) {
  return [...menu.querySelectorAll("[data-item-id]")].map((button) => button.dataset.itemId);
}

function groupLabels(menu) {
  return [...menu.querySelectorAll(".menu-group-label")].map((node) => node.textContent);
}

describe("composer-menus \"/\" 候选(命令 + 技能,与 dsh web 分组一致)", () => {
  const skills = [
    { name: "review", description: "代码审查" },
    { name: "release", description: "发布" }
  ];
  const commands = [
    { name: "compact", description: "压缩历史对话" },
    { name: "goal", description: "设置会话目标", input: { hint: "<text>" } },
    { name: "permission", description: "切换权限预设", input: { hint: "<preset>" } }
  ];

  it("输入 / 后命令组在前、技能组在后,分组标题与 dsh web 一致", () => {
    const { elements, menus } = setup({ skills, commands });
    elements.input.value = "/";
    elements.input.selectionStart = 1;
    menus.handleSlashInput();
    expect(elements.skillsMenu.matches(":popover-open")).toBe(true);
    expect(menuItemIds(elements.skillsMenu)).toEqual(["command:compact", "command:goal", "command:permission", "skill:review", "skill:release"]);
    expect(groupLabels(elements.skillsMenu)).toEqual([t("menu.commands"), t("skills.title")]);
  });

  it("命令组按模糊子序列打分排序,前缀命中优先", () => {
    const { elements, menus } = setup({ skills, commands });
    elements.input.value = "/co";
    elements.input.selectionStart = 3;
    menus.handleSlashInput();
    const ids = menuItemIds(elements.skillsMenu);
    expect(ids).toContain("command:compact");
    expect(ids).not.toContain("skill:review");
  });

  it("技能组保持纯前缀过滤(不做模糊匹配)", () => {
    const { elements, menus } = setup({ skills, commands: [] });
    elements.input.value = "/ev"; // "review" 中间包含 "ev" 但不是前缀,不应命中
    elements.input.selectionStart = 3;
    menus.handleSlashInput();
    expect(menuItemIds(elements.skillsMenu)).toEqual([]);
  });

  it("非行首/非空白后的 / 不触发弹窗", () => {
    const { elements, menus } = setup({ skills, commands });
    elements.input.value = "a/b";
    elements.input.selectionStart = 3;
    menus.handleSlashInput();
    expect(elements.skillsMenu.matches(":popover-open")).toBe(false);
  });

  it("查询无匹配候选时收起菜单", () => {
    const { elements, menus } = setup({ skills, commands });
    elements.input.value = "/zzz";
    elements.input.selectionStart = 4;
    menus.handleSlashInput();
    expect(elements.skillsMenu.matches(":popover-open")).toBe(false);
  });

  it("选中技能候选后只插入 \"/name \" 字面文本,不调用 commands/execute", () => {
    const { elements, deps, menus } = setup({ skills, commands });
    elements.input.value = "before /rev after";
    elements.input.selectionStart = 11; // 光标落在 "/rev" 末尾
    menus.handleSlashInput();
    elements.skillsMenu.querySelector('[data-item-id="skill:review"]').click();
    expect(elements.input.value).toBe("before /review  after");
    expect(elements.skillsMenu.matches(":popover-open")).toBe(false);
    expect(deps.commands.execute).not.toHaveBeenCalled();
  });

  it("选中命令候选后同样只插入文本,等发送时才真正执行", () => {
    const { elements, deps, menus } = setup({ skills, commands });
    elements.input.value = "/go";
    elements.input.selectionStart = 3;
    menus.handleSlashInput();
    elements.skillsMenu.querySelector('[data-item-id="command:goal"]').click();
    expect(elements.input.value).toBe("/goal ");
    expect(deps.commands.execute).not.toHaveBeenCalled();
  });

  it("tryDispatchCommand 命中已知命令时调用 commands/execute 并返回 true", async () => {
    const { deps, menus } = setup({ skills, commands });
    deps.commands.execute.mockResolvedValue({ commandId: "c1", result: { kind: "success" } });
    const handled = await menus.tryDispatchCommand("/compact");
    expect(handled).toBe(true);
    expect(deps.commands.execute).toHaveBeenCalledWith("s1", "/compact");
  });

  it("tryDispatchCommand 遇到未知命令名(如技能或普通文本)返回 false,不拦截发送", async () => {
    const { deps, menus } = setup({ skills, commands });
    expect(await menus.tryDispatchCommand("/review 麻烦看一下这段代码")).toBe(false);
    expect(await menus.tryDispatchCommand("普通消息,不是命令")).toBe(false);
    expect(deps.commands.execute).not.toHaveBeenCalled();
  });

  it("refreshSlashSources 会刷新命令和技能两路数据", async () => {
    const { deps, menus } = setup({ skills: [], commands: [] });
    await menus.refreshSlashSources();
    expect(deps.commands.refresh).toHaveBeenCalledWith("s1");
    expect(deps.skills.refresh).toHaveBeenCalledWith("s1");
  });
});
