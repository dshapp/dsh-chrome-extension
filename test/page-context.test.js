// @vitest-environment jsdom
// 「当前网页」取数层:提示词序列化 + captureCurrentTab 的取 tab/降级路径。
// 只带 tabId —— 页面内容由模型拿着 tabId 自己按需去取,这里不注入任何脚本。
//
// 这一层**没有开关**:带不带由输入框里的「当前网页」胶囊决定(见 trigger-menu)。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createPageContext } from "../src/features/page-context/page-context.js";
import { formatPageContext } from "../src/features/page-context/page-context-format.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));

function fakeChrome({ tabs = [{ id: 7, url: "https://example.com/a", title: "示例页" }] } = {}) {
  return {
    tabs: { query: vi.fn().mockResolvedValue(tabs) },
    // 只传 tabId 之后不再需要 scripting;保留一个探针,断言"一次都没被碰过"。
    scripting: { executeScript: vi.fn() }
  };
}

const make = (over = {}) => {
  const api = fakeChrome(over);
  return { pageContext: createPageContext({ chromeApi: api }), api };
};

describe("提示词序列化", () => {
  it("就是一行纯文字,没有 XML 包裹", () => {
    expect(formatPageContext({ tabId: 7 })).toBe("当前页面tabId=7");
  });

  it("不带尖括号/换行,单行到底", () => {
    const text = formatPageContext({ tabId: 7 });
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("多余字段一律忽略,不会漏进输出", () => {
    const text = formatPageContext({ tabId: 7, url: "https://a.com/?x=1&y=2", title: '<b>"标题"</b>' });
    expect(text).toBe("当前页面tabId=7");
    expect(text).not.toContain("a.com");
    expect(text).not.toContain("标题");
  });

  it("没有 tabId 就回空串,调用方据此不拼接", () => {
    expect(formatPageContext(null)).toBe("");
    expect(formatPageContext({})).toBe("");
    expect(formatPageContext({ url: "https://a.com" })).toBe("");
    // 非整数 id 不该被当成合法 tab。
    expect(formatPageContext({ tabId: "7" })).toBe("");
  });
});

describe("captureCurrentTab", () => {
  it("取的是用户当前正在看的那个标签页", async () => {
    const { pageContext, api } = make();
    expect(await pageContext.captureCurrentTab()).toEqual({ tabId: 7 });
    expect(api.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });

  it("全程不往页面注入任何脚本", async () => {
    const { pageContext, api } = make();
    await pageContext.captureCurrentTab();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("内部页照样只给 tabId —— 不读内容就没有注入限制", async () => {
    const { pageContext } = make({ tabs: [{ id: 3, url: "chrome://settings", title: "设置" }] });
    expect(await pageContext.captureCurrentTab()).toEqual({ tabId: 3 });
  });

  it("没有活动标签页时安静地回 null", async () => {
    const { pageContext } = make({ tabs: [] });
    expect(await pageContext.captureCurrentTab()).toBeNull();
  });

  it("tabs.query 抛错不外泄,降级成 null", async () => {
    const { pageContext, api } = make();
    api.tabs.query.mockRejectedValue(new Error("tabs 挂了"));
    await expect(pageContext.captureCurrentTab()).resolves.toBeNull();
  });

  it("非扩展环境(无 chrome API)不炸,只是没有网页可引用", async () => {
    const pageContext = createPageContext({ chromeApi: null });
    expect(await pageContext.captureCurrentTab()).toBeNull();
  });
});
