// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createElementPicker, isInternalPage, isSameElement, MAX_PICKED } from "../src/features/element-picker/element-picker.js";
import { formatPickedElementsContext } from "../src/features/element-picker/element-picker-context.js";
import { isElementPickerToggleChord, elementPickerShortcutLabel } from "../src/features/element-picker/element-picker-shortcut.js";
import { elementPickerSummaryScript } from "../src/features/element-picker/picker-element-summary.js";
import { elementPickerDrainScript, elementPickerStopScript } from "../src/features/element-picker/picker-lifecycle-scripts.js";
import { setLang } from "../src/shared/i18n.js";

beforeAll(() => setLang("zh"));

function fakeChrome({ tabs = [{ id: 7, url: "https://example.com" }], drain = [] } = {}) {
  const executed = [];
  return {
    executed,
    api: {
      tabs: {
        query: vi.fn().mockResolvedValue(tabs),
        get: vi.fn().mockImplementation((id) => Promise.resolve(tabs.find((t) => t.id === id) ?? tabs[0])),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
      scripting: {
        executeScript: vi.fn().mockImplementation(({ func }) => {
          executed.push(func.name);
          if (func.name === "elementPickerDrainScript") return Promise.resolve([{ result: { elements: drain } }]);
          return Promise.resolve([{ result: { ok: true } }]);
        })
      }
    }
  };
}
const make = (over = {}) => {
  const { api, executed } = fakeChrome(over);
  const showToast = vi.fn();
  const onChange = vi.fn();
  const picker = createElementPicker({ chromeApi: api, showToast, onChange, t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k) });
  return { picker, api, executed, showToast, onChange };
};

describe("内部页判定", () => {
  it("浏览器内部页不可注入", () => {
    for (const url of ["chrome://extensions", "chrome-extension://abc/x.html", "about:blank", "devtools://x", "view-source:http://a"]) {
      expect(isInternalPage(url), url).toBe(true);
    }
  });
  it("普通网页可注入", () => {
    expect(isInternalPage("https://example.com")).toBe(false);
    expect(isInternalPage("http://localhost:3000")).toBe(false);
  });
});

describe("去重判定", () => {
  it("ref 或 selector 命中即算同一元素", () => {
    expect(isSameElement({ ref: "r1" }, { ref: "r1" })).toBe(true);
    expect(isSameElement({ selector: "#a" }, { selector: "#a" })).toBe(true);
    expect(isSameElement({ ref: "r1" }, { ref: "r2" })).toBe(false);
    expect(isSameElement(null, { ref: "r1" })).toBe(false);
  });
});

describe("选取开关", () => {
  it("开启时按序注入摘要器与 overlay", async () => {
    const { picker, executed } = make();
    await picker.setActive(true);
    // 顺序有意义:overlay 的点击处理依赖页面上已存在的摘要构建器。
    expect(executed).toEqual(["elementPickerSummaryScript", "elementPickerPageScript"]);
    expect(picker.active).toBe(true);
    expect(picker.tabId).toBe(7);
  });

  it("内部页拒绝开启并提示", async () => {
    const { picker, showToast } = make({ tabs: [{ id: 9, url: "chrome://extensions" }] });
    await picker.setActive(true);
    expect(picker.active).toBe(false);
    expect(showToast).toHaveBeenCalledWith("picker.needsPage");
  });

  it("关闭时先收尾 drain 再停止页面脚本", async () => {
    const { picker, executed } = make();
    await picker.setActive(true);
    executed.length = 0;
    await picker.setActive(false);
    // 关闭前必须 drain 一次,否则最后一次点击还在队列里就被丢掉。
    expect(executed[0]).toBe("elementPickerDrainScript");
    expect(executed).toContain("elementPickerStopScript");
    expect(picker.active).toBe(false);
  });

  it("重复设置同一状态不重复注入", async () => {
    const { picker, executed } = make();
    await picker.setActive(true);
    const count = executed.length;
    await picker.setActive(true);
    expect(executed).toHaveLength(count);
  });

  it("toggle 在两态间切换", async () => {
    const { picker } = make();
    expect(await picker.toggle()).toBe(true);
    expect(await picker.toggle()).toBe(false);
  });
});

describe("选取集合", () => {
  it("新增会去重并通知变化", () => {
    const { picker, onChange } = make();
    picker.add({ ref: "r1", name: "按钮" });
    picker.add({ ref: "r1", name: "按钮" });
    expect(picker.picked).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("超过上限时提示且不再收", () => {
    const { picker, showToast } = make();
    for (let i = 0; i < MAX_PICKED + 3; i++) picker.add({ ref: `r${i}` });
    expect(picker.picked).toHaveLength(MAX_PICKED);
    expect(showToast).toHaveBeenCalled();
  });

  it("按序号移除", () => {
    const { picker } = make();
    picker.add({ ref: "a" }); picker.add({ ref: "b" }); picker.add({ ref: "c" });
    picker.remove(1);
    expect(picker.picked.map((e) => e.ref)).toEqual(["a", "c"]);
    picker.remove(99);
    expect(picker.picked).toHaveLength(2);
  });

  it("清空", () => {
    const { picker } = make();
    picker.add({ ref: "a" });
    picker.clear();
    expect(picker.picked).toHaveLength(0);
  });

  it("drain 把页面队列并入选取集合", async () => {
    const { picker } = make({ drain: [{ ref: "d1" }, { ref: "d2" }] });
    await picker.setActive(true);
    await picker.drain();
    expect(picker.picked.map((e) => e.ref)).toEqual(expect.arrayContaining(["d1", "d2"]));
  });
});

describe("快捷键", () => {
  it("mac 用 ⌘. ,其他平台 Ctrl+.", () => {
    expect(isElementPickerToggleChord({ key: ".", metaKey: true }, { mac: true })).toBe(true);
    expect(isElementPickerToggleChord({ key: ".", ctrlKey: true }, { mac: false })).toBe(true);
    expect(isElementPickerToggleChord({ key: ".", ctrlKey: true }, { mac: true })).toBe(false);
  });
  it("输入法组字/长按/带额外修饰键不触发", () => {
    expect(isElementPickerToggleChord({ key: ".", metaKey: true, isComposing: true }, { mac: true })).toBe(false);
    expect(isElementPickerToggleChord({ key: ".", metaKey: true, repeat: true }, { mac: true })).toBe(false);
    expect(isElementPickerToggleChord({ key: ".", metaKey: true, shiftKey: true }, { mac: true })).toBe(false);
  });
  it("标签文案随平台", () => {
    expect(elementPickerShortcutLabel(true)).toBe("⌘.");
    expect(elementPickerShortcutLabel(false)).toBe("Ctrl+.");
  });
});

describe("XML 上下文序列化", () => {
  const element = {
    tag: "button", ref: "ref_1", selector: "#app > form > button",
    xpath: '//*[@id="submit"]', role: "button", name: "提交订单",
    text: "提交订单", attrs: { id: "submit", class: "btn primary" },
    rect: { x: 12, y: 340, width: 96, height: 44 },
    url: "https://shop.example/checkout", title: "结算页"
  };

  const parse = (xml) => new window.DOMParser().parseFromString(xml, "application/xml");

  it("空集合返回空串", () => {
    expect(formatPickedElementsContext([])).toBe("");
    expect(formatPickedElementsContext(null)).toBe("");
  });

  it("产出可被 DOMParser 解析的合法 XML", () => {
    const doc = parse(formatPickedElementsContext([element]));
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.tagName).toBe("selected_page_elements");
  });

  it("三种定位符都以属性形式挂在 element 上", () => {
    const el = parse(formatPickedElementsContext([element])).querySelector("element");
    expect(el.getAttribute("xpath")).toBe('//*[@id="submit"]');
    expect(el.getAttribute("css")).toBe("#app > form > button");
    expect(el.getAttribute("ref")).toBe("ref_1");
  });

  it("页面 url/title 与元素计数收进根节点属性", () => {
    const root = parse(formatPickedElementsContext([element])).documentElement;
    expect(root.getAttribute("url")).toBe("https://shop.example/checkout");
    expect(root.getAttribute("title")).toBe("结算页");
    expect(root.getAttribute("count")).toBe("1");
  });

  it("根节点只有 element 子节点(不再有说明句/page/elements 包装层)", () => {
    const doc = parse(formatPickedElementsContext([element]));
    const tags = [...doc.documentElement.children].map((n) => n.tagName);
    expect(tags).toEqual(["element"]);
    expect(formatPickedElementsContext([element])).not.toContain("<description");
  });

  it("特殊字符被转义且往返无损(否则 XML 结构会被内容破坏)", () => {
    const nasty = {
      ...element,
      selector: 'div[data-x="a&b"] > span',
      name: '他说 "你好" & <再见>',
      text: '他说 "你好" & <再见>',
      title: "标题 <含尖括号>"
    };
    const doc = parse(formatPickedElementsContext([nasty]));
    expect(doc.querySelector("parsererror")).toBeNull();
    // 定位符移进了属性,属性位的引号转义尤其要验。
    expect(doc.querySelector("element").getAttribute("css")).toBe('div[data-x="a&b"] > span');
    expect(doc.querySelector("element").textContent.trim()).toBe('他说 "你好" & <再见>');
    expect(doc.documentElement.getAttribute("title")).toBe("标题 <含尖括号>");
  });

  it("多个元素各自带序号 i", () => {
    const doc = parse(formatPickedElementsContext([element, { ...element, ref: "ref_2", name: "取消" }]));
    expect([...doc.querySelectorAll("element")].map((n) => n.getAttribute("i"))).toEqual(["1", "2"]);
  });

  it("不再输出 id/class/bounding_box(已被选择器编码 / 无消费方)", () => {
    const xml = formatPickedElementsContext([element]);
    expect(xml).not.toContain("bounding_box");
    expect(xml).not.toContain("btn primary");
    const el = parse(xml).querySelector("element");
    expect(el.getAttribute("id")).toBeNull();
    expect(el.getAttribute("class")).toBeNull();
  });

  it("role 与 tag 同义时省略,被显式改写才输出", () => {
    const same = parse(formatPickedElementsContext([element])).querySelector("element");
    expect(same.getAttribute("role")).toBeNull();
    const diff = parse(formatPickedElementsContext([{ ...element, role: "tab" }])).querySelector("element");
    expect(diff.getAttribute("role")).toBe("tab");
  });

  it("text 与 name 相同时不另起 text 子节点,不同才补", () => {
    expect(formatPickedElementsContext([element])).not.toContain("<text>");
    const doc = parse(formatPickedElementsContext([{ ...element, text: "提交订单(含运费)" }]));
    expect(doc.querySelector("text").textContent).toBe("提交订单(含运费)");
  });

  it("url 与定位符不被截断:半截 URL / 选择器等于不可用", () => {
    const url = "https://shop.example/checkout?" + "q=1&".repeat(60);
    const css = "body > " + "div:nth-of-type(2) > ".repeat(11) + "button";
    const doc = parse(formatPickedElementsContext([{ ...element, url, selector: css }]));
    expect(doc.documentElement.getAttribute("url")).toBe(url);
    expect(doc.querySelector("element").getAttribute("css")).toBe(css);
  });

  it("缺字段的元素不产出空标签,也不产出空属性", () => {
    const xml = formatPickedElementsContext([{ tag: "div", ref: "r", selector: "", xpath: "" }]);
    const doc = parse(xml);
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(xml).not.toContain('=""');
    const el = doc.querySelector("element");
    expect(el.getAttribute("xpath")).toBeNull();
    expect(el.getAttribute("ref")).toBe("r");
  });

  it("体积回归:两个元素的上下文远小于旧嵌套格式(旧版 ~1142 字符)", () => {
    const xml = formatPickedElementsContext([element, { ...element, ref: "ref_2", name: "取消" }]);
    expect(xml.length).toBeLessThan(500);
  });
});

describe("注入体(在 jsdom 里当作页面脚本直接跑)", () => {
  it("drain 取走并清空队列", () => {
    window.__cmPickerQueue = [{ ref: "a" }];
    expect(elementPickerDrainScript().elements).toEqual([{ ref: "a" }]);
    expect(window.__cmPickerQueue).toEqual([]);
  });

  it("stop 在未启动时安全返回", () => {
    window.__cmElementPicker = null;
    expect(elementPickerStopScript()).toEqual({ stopped: false });
  });

  it("摘要器挂载后能产出定位符", () => {
    document.body.innerHTML = '<div><button id="go" class="btn primary" aria-label="前进">走</button></div>';
    elementPickerSummaryScript({ maxTextLength: 120 });
    const summary = window.__cmPickerSummary.build(document.getElementById("go"));
    expect(summary.tag).toBe("button");
    expect(summary.attrs.id).toBe("go");
    expect(summary.name).toBe("前进");             // aria-label 优先
    expect(summary.xpath).toBe('//*[@id="go"]');   // id 唯一 → 短路
    expect(summary.selector).toContain("#go");
    expect(summary.ref).toMatch(/^ref_\d+$/);
  });

  it("无 id 时 XPath 逐级带下标,且只在有同名兄弟时加", () => {
    document.body.innerHTML = "<div><p>a</p><span>x</span><span>y</span></div>";
    elementPickerSummaryScript({ maxTextLength: 120 });
    const build = window.__cmPickerSummary.build;
    // 唯一的 p 不带下标;两个 span 中第二个带 [2]
    expect(build(document.querySelector("p")).xpath).toMatch(/\/p$/);
    expect(build(document.querySelectorAll("span")[1]).xpath).toMatch(/span\[2\]$/);
  });

  it("含引号的 id 退回纯路径(XPath 字面量无法转义引号)", () => {
    document.body.innerHTML = '<div><i id=\'a"b\'>x</i></div>';
    elementPickerSummaryScript({ maxTextLength: 120 });
    const xpath = window.__cmPickerSummary.build(document.querySelector("i")).xpath;
    expect(xpath).not.toContain('id="a"b"');
    expect(xpath).toMatch(/\/i$/);
  });

  it("密码类输入不泄漏值", () => {
    document.body.innerHTML = '<input type="password" name="pw" value="s3cret">';
    elementPickerSummaryScript({ maxTextLength: 120 });
    const summary = window.__cmPickerSummary.build(document.querySelector("input"));
    expect(JSON.stringify(summary)).not.toContain("s3cret");
  });
});

describe("目标页被关掉", () => {
  // attach() 挂了 onUpdated / onActivated,唯独没挂 onRemoved:目标页关掉后
  // picker 仍是 active、tabId 仍指着那个已死的 tab,drain 每 400ms 空转一次。
  // 真正的危害是 Chrome 会复用 tabId —— 死 id 被新页面复用后,drain 与 SW 的
  // stopPickerOnTab 会打到一个用户毫不相干的页面上。
  it("目标页关闭后选取模式收尾,不再盯着这个 tabId", async () => {
    const { picker, api } = make();
    const detach = picker.attach();
    await picker.setActive(true);
    expect(picker.active).toBe(true);
    expect(picker.tabId).toBe(7);

    const onRemoved = api.tabs.onRemoved.addListener.mock.calls[0]?.[0];
    expect(typeof onRemoved).toBe("function");
    onRemoved(7);

    expect(picker.active).toBe(false);
    expect(picker.tabId).toBe(null);
    detach();
  });

  it("关掉的是别的标签页则不受影响", async () => {
    const { picker, api } = make();
    const detach = picker.attach();
    await picker.setActive(true);
    const onRemoved = api.tabs.onRemoved.addListener.mock.calls[0]?.[0];
    onRemoved(999);
    expect(picker.active).toBe(true);
    expect(picker.tabId).toBe(7);
    detach();
  });

  it("detach 时把 onRemoved 一起摘掉", async () => {
    const { picker, api } = make();
    const detach = picker.attach();
    detach();
    expect(api.tabs.onRemoved.removeListener).toHaveBeenCalled();
  });
});
