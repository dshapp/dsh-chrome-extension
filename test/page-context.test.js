// @vitest-environment jsdom
// 「携带当前页面上下文」开关:XML 序列化与工厂的开关/取 tab/降级路径。
// 只带 tabId —— 页面内容由模型拿着 tabId 自己按需去取,这里不注入任何脚本。
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createPageContext, PAGE_CONTEXT_STORAGE_KEY } from "../src/features/page-context/page-context.js";
import { formatPageContext } from "../src/features/page-context/page-context-format.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));

const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

function fakeChrome({ tabs = [{ id: 7, url: "https://example.com/a", title: "示例页" }] } = {}) {
  const store = {};
  return {
    store,
    api: {
      tabs: { query: vi.fn().mockResolvedValue(tabs) },
      // 只传 tabId 之后不再需要 scripting;保留一个探针,断言"一次都没被碰过"。
      scripting: { executeScript: vi.fn() },
      storage: {
        local: {
          get: vi.fn(async (keys) => {
            const out = {};
            for (const key of keys) if (key in store) out[key] = store[key];
            return out;
          }),
          set: vi.fn(async (values) => { Object.assign(store, values); }),
          remove: vi.fn(async (keys) => { for (const key of keys) delete store[key]; })
        }
      }
    }
  };
}

const make = (over = {}) => {
  const { api, store } = fakeChrome(over);
  const showToast = vi.fn();
  const onChange = vi.fn();
  const pageContext = createPageContext({ chromeApi: api, showToast, onChange, t });
  return { pageContext, api, store, showToast, onChange };
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

describe("开关与取 tab", () => {
  it("默认关闭:context 回空串,tabs 一次都不查", async () => {
    const { pageContext, api } = make();
    expect(pageContext.enabled).toBe(false);
    expect(await pageContext.context()).toBe("");
    expect(await pageContext.capture()).toBeNull();
    expect(api.tabs.query).not.toHaveBeenCalled();
  });

  it("开启后取当前活动标签页并拼出上下文块", async () => {
    const { pageContext, api } = make();
    pageContext.toggle();
    const text = await pageContext.context();
    expect(api.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(text).toBe("当前页面tabId=7");
  });

  it("全程不往页面注入任何脚本", async () => {
    const { pageContext, api } = make();
    pageContext.toggle();
    await pageContext.context();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("内部页照样只给 tabId —— 不读内容就没有注入限制", async () => {
    const { pageContext } = make({ tabs: [{ id: 3, url: "chrome://settings", title: "设置" }] });
    pageContext.toggle();
    expect(await pageContext.capture()).toEqual({ tabId: 3 });   // capture 不扣额度
    expect(await pageContext.context()).toBe("当前页面tabId=3");
  });

  it("没有活动标签页时安静地回 null", async () => {
    const { pageContext } = make({ tabs: [] });
    pageContext.toggle();
    expect(await pageContext.capture()).toBeNull();
    expect(await pageContext.context()).toBe("");
  });

  it("tabs.query 抛错不外泄,降级成没有上下文", async () => {
    const { pageContext, api } = make();
    api.tabs.query.mockRejectedValue(new Error("tabs 挂了"));
    pageContext.toggle();
    await expect(pageContext.capture()).resolves.toBeNull();
    await expect(pageContext.context()).resolves.toBe("");
  });

  it("关态同步返回空串,不欠一个微任务", () => {
    const { pageContext } = make();
    const result = pageContext.context();
    expect(typeof result).toBe("string");
    expect(result instanceof Promise).toBe(false);
  });
});

describe("只在开启后的第一条追加", () => {
  it("第一条带 tabId,之后每一条都不再带", async () => {
    const { pageContext, api } = make();
    pageContext.toggle();
    expect(pageContext.pending).toBe(true);

    expect(await pageContext.context()).toBe("当前页面tabId=7");
    expect(pageContext.pending).toBe(false);

    // 第二、三条:开关仍是开着的,但额度已经用掉。
    expect(await pageContext.context()).toBe("");
    expect(await pageContext.context()).toBe("");
    expect(pageContext.enabled).toBe(true);
    // 后两条一次 tabs.query 都不该再发。
    expect(api.tabs.query).toHaveBeenCalledTimes(1);
  });

  it("额度用完后同步返回空串,不欠一个微任务", async () => {
    const { pageContext } = make();
    pageContext.toggle();
    await pageContext.context();                 // 消耗掉
    const second = pageContext.context();
    expect(second instanceof Promise).toBe(false);
    expect(second).toBe("");
  });

  it("关掉再打开就重新装填,可以再带一次", async () => {
    const { pageContext } = make();
    pageContext.toggle();
    expect(await pageContext.context()).toBe("当前页面tabId=7");
    expect(await pageContext.context()).toBe("");

    pageContext.toggle();                        // 关
    pageContext.toggle();                        // 再开 → 重新装填
    expect(pageContext.pending).toBe(true);
    expect(await pageContext.context()).toBe("当前页面tabId=7");
    expect(await pageContext.context()).toBe("");
  });

  it("发送失败也算用掉 —— 额度在 context() 就扣,不等发送成功", async () => {
    const { pageContext } = make();
    pageContext.toggle();
    // 模拟"取到了文本但这条消息发失败了":调用方不会回滚额度。
    expect(await pageContext.context()).toBe("当前页面tabId=7");
    expect(pageContext.pending).toBe(false);
    expect(await pageContext.context()).toBe("");
  });

  it("取不到 tab 也照样消耗额度,不会一直重试", async () => {
    const { pageContext } = make({ tabs: [] });
    pageContext.toggle();
    expect(await pageContext.context()).toBe("");
    expect(pageContext.pending).toBe(false);
  });

  it("侧栏重开:从 storage 读回开态时重新装填一次", async () => {
    const pageContext = createPageContext({
      chromeApi: {
        tabs: { query: async () => [{ id: 11 }] },
        storage: { local: {
          get: async () => ({ [PAGE_CONTEXT_STORAGE_KEY]: true }),
          set: async () => {}, remove: async () => {}
        } }
      },
      t
    });
    expect(pageContext.pending).toBe(false);
    await pageContext.load();
    expect(pageContext.enabled).toBe(true);
    expect(pageContext.pending).toBe(true);
    expect(await pageContext.context()).toBe("当前页面tabId=11");
    expect(await pageContext.context()).toBe("");
  });

  it("读回关态不装填额度", async () => {
    const pageContext = createPageContext({
      chromeApi: { storage: { local: {
        get: async () => ({}), set: async () => {}, remove: async () => {}
      } } },
      t
    });
    await pageContext.load();
    expect(pageContext.pending).toBe(false);
  });

  it("切换写入 storage 并可被 load 读回", async () => {
    const { pageContext, store, onChange, showToast } = make();
    pageContext.toggle();
    expect(pageContext.enabled).toBe(true);
    expect(onChange).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("pageCtx.on");
    await Promise.resolve();
    expect(store[PAGE_CONTEXT_STORAGE_KEY]).toBe(true);

    const revived = createPageContext({ chromeApi: { storage: { local: {
      get: async () => ({ [PAGE_CONTEXT_STORAGE_KEY]: true }), set: async () => {}, remove: async () => {}
    } } }, t });
    expect(await revived.load()).toBe(true);
  });

  it("关闭时清掉 storage 里的键,而不是写 false", async () => {
    const { pageContext, store, showToast } = make();
    pageContext.toggle();
    await Promise.resolve();
    pageContext.toggle();
    await Promise.resolve();
    expect(pageContext.enabled).toBe(false);
    expect(PAGE_CONTEXT_STORAGE_KEY in store).toBe(false);
    expect(showToast).toHaveBeenLastCalledWith("pageCtx.off");
  });

  it("重复设置同一状态不重复通知", () => {
    const { pageContext, onChange, showToast } = make();
    pageContext.setEnabled(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("读盘未返回前用户已切换的,不被读回的旧值盖掉", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const pageContext = createPageContext({
      chromeApi: { storage: { local: {
        get: () => pending.then(() => ({})),   // 旧值:未开启
        set: async () => {}, remove: async () => {}
      } } },
      t
    });

    const loading = pageContext.load();
    pageContext.setEnabled(true);
    release();
    await loading;

    expect(pageContext.enabled).toBe(true);
  });

  it("用户没碰过时,读盘结果照常生效", async () => {
    const pageContext = createPageContext({
      chromeApi: { storage: { local: {
        get: async () => ({ [PAGE_CONTEXT_STORAGE_KEY]: true }),
        set: async () => {}, remove: async () => {}
      } } },
      t
    });
    await pageContext.load();
    expect(pageContext.enabled).toBe(true);
  });

  it("非扩展环境(无 chrome API)不炸,只是没有上下文可带", async () => {
    const pageContext = createPageContext({ chromeApi: null, t });
    expect(await pageContext.load()).toBe(false);
    pageContext.setEnabled(true);
    expect(await pageContext.capture()).toBeNull();
  });
});
