// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElementPicker, isInternalPage, isSameElement, MAX_PICKED } from "../src/features/element-picker/element-picker.js";
import { formatPickedElementsContext } from "../src/features/element-picker/element-picker-context.js";
import { isElementPickerToggleChord, elementPickerShortcutLabel } from "../src/features/element-picker/element-picker-shortcut.js";
import { elementPickerSummaryScript } from "../src/features/element-picker/picker-element-summary.js";
import { elementPickerPageScript } from "../src/features/element-picker/picker-overlay-script.js";
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

  it("批注作为 <note> 子节点输出(原话可能多行,塞属性行既难读又易超宽)", () => {
    const doc = parse(formatPickedElementsContext([{ ...element, note: "点了没反应" }]));
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("note").textContent).toBe("点了没反应");
  });

  it("没有批注时不产出空的 <note>", () => {
    expect(formatPickedElementsContext([element])).not.toContain("<note>");
  });

  it("批注里的特殊字符被转义,不破坏 XML 结构", () => {
    const doc = parse(formatPickedElementsContext([{ ...element, note: '把 <b> 换成 "粗体" & 加粗' }]));
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("note").textContent).toBe('把 <b> 换成 "粗体" & 加粗');
  });

  it("批注与 text 并存时两个子节点都在,且仍是合法 XML", () => {
    const doc = parse(formatPickedElementsContext([{ ...element, text: "提交订单(含运费)", note: "改文案" }]));
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("text").textContent).toBe("提交订单(含运费)");
    expect(doc.querySelector("note").textContent).toBe("改文案");
  });

  it("批注上限比正文宽:160 字的批注不该被截(截了等于丢需求)", () => {
    const note = "改".repeat(200);
    const doc = parse(formatPickedElementsContext([{ ...element, note }]));
    expect(doc.querySelector("note").textContent).toBe(note);
  });

  it("超长批注仍有上限,不至于把整条消息撑爆", () => {
    const doc = parse(formatPickedElementsContext([{ ...element, note: "改".repeat(900) }]));
    expect(doc.querySelector("note").textContent.length).toBeLessThan(600);
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

describe("批注弹窗(注入体在 jsdom 里当作页面脚本直接跑)", () => {
  const labels = {
    submit: "提交", next: "下一个", close: "退出圈选",
    placeholder: "说点什么", annotated: "已批注 {n} 个"
  };

  beforeEach(() => {
    document.body.innerHTML = '<div><button id="go">走</button><a id="link" href="/x">链接</a></div>';
    window.__cmPickerQueue = [];
    window.__cmPickerSubmit = false;
    window.__cmPickerCancel = false;
    // commit() 会走 chrome.runtime.sendMessage 这条快通道;页面上没有扩展上下文时
    // 它本就该静默失败,这里给个假的免得测试噪音。
    globalThis.chrome = { runtime: { sendMessage: vi.fn() } };
    elementPickerSummaryScript({ maxTextLength: 120 });
    elementPickerPageScript({ maxTextLength: 120, labels });
  });

  afterEach(() => {
    window.__cmElementPicker?.stop?.();
  });

  const panel = () => document.getElementById("__cm-element-picker-annotate");
  const buttonByText = (text) =>
    [...panel().querySelectorAll("button")].find((b) => b.textContent === text);

  /// 注入体靠 elementFromPoint 命中目标,jsdom 里它恒返回 null,
  /// 所以直接桩掉,让 targetAt 落到我们指定的元素上。
  const clickOn = (el) => {
    document.elementFromPoint = () => el;
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };

  it("点中元素后在页面上弹出批注框并聚焦输入", () => {
    expect(panel()).toBeNull();
    clickOn(document.getElementById("go"));
    expect(panel()).not.toBeNull();
    const textarea = panel().querySelector("textarea");
    expect(textarea.placeholder).toBe("说点什么");
    expect(document.activeElement).toBe(textarea);
  });

  it("弹窗开着时页面点击仍被吞掉,且不顶掉正在批注的目标", () => {
    clickOn(document.getElementById("go"));
    const event = clickOn(document.getElementById("link"));
    expect(event.defaultPrevented).toBe(true);
    // 批注写到一半被顶掉最恼人:标题仍指向最初选中的元素。
    expect(panel().querySelector("span").textContent).toContain("go");
  });

  it("弹窗内部的点击不被吞掉,否则输入框根本点不进", () => {
    clickOn(document.getElementById("go"));
    const textarea = panel().querySelector("textarea");
    for (const type of ["mousedown", "mouseup", "click"]) {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(false);
    }
  });

  it("「下一个」收下这一条带批注的元素,弹窗消失并回到圈选态", () => {
    clickOn(document.getElementById("go"));
    panel().querySelector("textarea").value = "  这个按钮点了没反应  ";
    buttonByText("下一个").click();
    expect(panel()).toBeNull();
    expect(window.__cmPickerQueue).toHaveLength(1);
    expect(window.__cmPickerQueue[0].note).toBe("这个按钮点了没反应");
    expect(window.__cmPickerQueue[0].ref).toMatch(/^ref_\d+$/);
    // 没有置提交/取消标志:用户只是要接着选下一个。
    expect(window.__cmPickerSubmit).toBe(false);
    expect(window.__cmPickerCancel).toBe(false);
    clickOn(document.getElementById("link"));
    expect(panel()).not.toBeNull();
  });

  it("批注为空也能收下(元素本身就是指代),但不产出 note 字段", () => {
    clickOn(document.getElementById("go"));
    buttonByText("下一个").click();
    expect(window.__cmPickerQueue).toHaveLength(1);
    expect(window.__cmPickerQueue[0].note).toBeUndefined();
  });

  it("「提交」先把这一条入队再置标志位,并自我收尾", () => {
    clickOn(document.getElementById("go"));
    panel().querySelector("textarea").value = "改成蓝色";
    buttonByText("提交").click();
    // 顺序要紧:标志位为真时元素必须已经在队列里,否则侧栏会发出一条缺元素的消息。
    expect(window.__cmPickerQueue).toHaveLength(1);
    expect(window.__cmPickerQueue[0].note).toBe("改成蓝色");
    expect(window.__cmPickerSubmit).toBe(true);
    // 自我收尾:覆盖层与弹窗都拆掉,页面立刻恢复可用,不必等侧栏那次异步往返。
    expect(panel()).toBeNull();
    expect(document.getElementById("__cm-element-picker-overlay")).toBeNull();
    expect(window.__cmElementPicker).toBeNull();
  });

  it("右上角关闭丢弃这一条批注并退出圈选,已收下的不受影响", () => {
    clickOn(document.getElementById("go"));
    buttonByText("下一个").click();
    clickOn(document.getElementById("link"));
    panel().querySelector("textarea").value = "这条不要";
    panel().querySelector("button[aria-label='退出圈选']").click();
    expect(window.__cmPickerCancel).toBe(true);
    expect(window.__cmPickerSubmit).toBe(false);
    // 关闭丢的是当前这一条,不是整轮:先前点过「下一个」的仍在队列里。
    expect(window.__cmPickerQueue).toHaveLength(1);
    expect(window.__cmPickerQueue[0].note).toBeUndefined();
    expect(window.__cmElementPicker).toBeNull();
  });

  /// 重开一次弹窗,好让每个按键用例从干净状态起步。
  const reopen = () => {
    window.__cmPickerSubmit = false;
    window.__cmPickerCancel = false;
    window.__cmElementPicker?.stop?.();
    elementPickerPageScript({ maxTextLength: 120, labels });
    clickOn(document.getElementById("go"));
  };
  const press = (init) =>
    panel().dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

  it("Escape 等于关闭", () => {
    clickOn(document.getElementById("go"));
    press({ key: "Escape" });
    expect(window.__cmPickerCancel).toBe(true);
  });

  it("Enter 直接提交", () => {
    reopen();
    panel().querySelector("textarea").value = "改成蓝色";
    press({ key: "Enter" });
    expect(window.__cmPickerSubmit).toBe(true);
    expect(window.__cmPickerQueue.at(-1).note).toBe("改成蓝色");
  });

  it("Shift+Enter 换行,不提交(要留给 textarea 自己插入换行)", () => {
    reopen();
    const event = new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    panel().dispatchEvent(event);
    expect(window.__cmPickerSubmit).toBe(false);
    expect(panel()).not.toBeNull();
    // 不能拦下默认行为,否则 textarea 根本换不了行。
    expect(event.defaultPrevented).toBe(false);
  });

  it("⌘/Ctrl+Enter 同样提交(两种习惯都不落空)", () => {
    reopen();
    press({ key: "Enter", metaKey: true });
    expect(window.__cmPickerSubmit).toBe(true);

    reopen();
    press({ key: "Enter", ctrlKey: true });
    expect(window.__cmPickerSubmit).toBe(true);
  });

  // 中文用户每选一个候选词都会按 Enter;不挡住的话批注刚打一半就被发出去了。
  it("输入法组字中的 Enter 是选词,不提交", () => {
    reopen();
    press({ key: "Enter", isComposing: true });
    expect(window.__cmPickerSubmit).toBe(false);
    expect(panel()).not.toBeNull();

    // 部分输入法不给 isComposing,只给得出 keyCode 229。
    reopen();
    press({ key: "Enter", keyCode: 229 });
    expect(window.__cmPickerSubmit).toBe(false);
    expect(panel()).not.toBeNull();
  });

  it("stop() 把弹窗一起拆掉,不留残影", () => {
    clickOn(document.getElementById("go"));
    window.__cmElementPicker.stop();
    expect(panel()).toBeNull();
  });
});

describe("drain 的提交/取消标志位", () => {
  it("读走后即清空,不会被下一轮重复消费", () => {
    window.__cmPickerQueue = [{ ref: "a" }];
    window.__cmPickerSubmit = true;
    window.__cmPickerCancel = true;
    expect(elementPickerDrainScript()).toEqual({ elements: [{ ref: "a" }], submit: true, cancel: true });
    expect(elementPickerDrainScript()).toEqual({ elements: [], submit: false, cancel: false });
  });
});

describe("页面出口驱动侧栏", () => {
  /// 让 drain 返回指定的标志位,其余注入体照常成功。
  const withDrain = (result) => {
    const { api } = fakeChrome();
    api.scripting.executeScript = vi.fn().mockImplementation(({ func }) => {
      if (func.name === "elementPickerDrainScript") return Promise.resolve([{ result }]);
      return Promise.resolve([{ result: { ok: true } }]);
    });
    return api;
  };

  it("drain 读到 submit:先并入元素再回调,且不清空已选(发送失败要能重试)", async () => {
    const onSubmit = vi.fn();
    const api = withDrain({ elements: [{ ref: "d1", note: "改文案" }], submit: true, cancel: false });
    const picker = createElementPicker({ chromeApi: api, showToast: vi.fn(), onSubmit, t: (k) => k });
    await picker.setActive(true);
    await picker.drain();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 回调时元素必须已经在集合里,否则发出去的是一条缺了元素的消息。
    expect(picker.picked.map((e) => e.ref)).toEqual(["d1"]);
    expect(picker.active).toBe(false);
  });

  it("drain 读到 cancel:退出圈选但不发送,已选元素保留在药丸里", async () => {
    const onSubmit = vi.fn();
    const api = withDrain({ elements: [{ ref: "keep" }], submit: false, cancel: true });
    const picker = createElementPicker({ chromeApi: api, showToast: vi.fn(), onSubmit, t: (k) => k });
    await picker.setActive(true);
    await picker.drain();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(picker.active).toBe(false);
    expect(picker.picked.map((e) => e.ref)).toEqual(["keep"]);
  });

  it("注入 overlay 时把已本地化文案一并传过去(注入体引用不到 t())", async () => {
    const { picker, api } = make();
    await picker.setActive(true);
    const call = api.scripting.executeScript.mock.calls
      .find(([arg]) => arg.func.name === "elementPickerPageScript");
    expect(call[0].args[0].labels).toMatchObject({
      submit: expect.any(String), next: expect.any(String),
      close: expect.any(String), placeholder: expect.any(String), annotated: expect.any(String)
    });
  });
});

describe("同一元素补批注", () => {
  it("重选同一元素并写批注时更新那一条,而不是静默丢弃", () => {
    const { picker, onChange } = make();
    picker.add({ ref: "r1", name: "按钮" });
    picker.add({ ref: "r1", name: "按钮", note: "改成蓝色" });
    expect(picker.picked).toHaveLength(1);
    expect(picker.picked[0].note).toBe("改成蓝色");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("重复的同一元素且没有新批注:仍然去重,不惊动订阅者", () => {
    const { picker, onChange } = make();
    picker.add({ ref: "r1", note: "保留" });
    onChange.mockClear();
    picker.add({ ref: "r1" });
    expect(picker.picked[0].note).toBe("保留");
    expect(onChange).not.toHaveBeenCalled();
  });
});
describe("批注弹窗的落位:锚在点击点,并做边缘避让", () => {
  const labels = {
    submit: "提交", next: "下一个", close: "退出圈选",
    placeholder: "说点什么", annotated: "已批注 {n} 个"
  };
  const W = 280, H = 150, GAP = 8;

  beforeEach(() => {
    document.body.innerHTML = '<div><button id="go">走</button></div>';
    window.__cmPickerQueue = [];
    window.__cmPickerSubmit = false;
    window.__cmPickerCancel = false;
    globalThis.chrome = { runtime: { sendMessage: vi.fn() } };
    // jsdom 不做布局:offsetWidth/Height 恒为 0,几何断言就无从谈起。
    // 给弹窗钉上真实尺寸,让 placePanel 的避让逻辑可测。
    Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() { return this.id === "__cm-element-picker-annotate" ? W : 0; }
    });
    Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() { return this.id === "__cm-element-picker-annotate" ? H : 0; }
    });
    window.innerWidth = 1000;
    window.innerHeight = 800;
    window.scrollX = 0;
    window.scrollY = 0;
    elementPickerSummaryScript({ maxTextLength: 120 });
    elementPickerPageScript({ maxTextLength: 120, labels });
  });

  afterEach(() => {
    window.__cmElementPicker?.stop?.();
    delete window.HTMLElement.prototype.offsetWidth;
    delete window.HTMLElement.prototype.offsetHeight;
  });

  const panel = () => document.getElementById("__cm-element-picker-annotate");
  /// 在视口 (x, y) 处点击目标元素。
  const clickAt = (x, y) => {
    const el = document.getElementById("go");
    document.elementFromPoint = () => el;
    el.dispatchEvent(new window.MouseEvent("click", {
      bubbles: true, cancelable: true, clientX: x, clientY: y
    }));
  };
  const box = () => ({
    left: parseFloat(panel().style.left),
    top: parseFloat(panel().style.top)
  });

  it("默认左上角与点击点对齐", () => {
    clickAt(300, 200);
    expect(box()).toEqual({ left: 300, top: 200 });
  });

  it("靠右边缘:往左翻,让右缘贴住点击点,不越出视口", () => {
    clickAt(950, 200);
    const { left } = box();
    expect(left).toBe(950 - W);
    expect(left + W).toBeLessThanOrEqual(window.innerWidth);
  });

  it("靠下边缘:往上翻,让下缘贴住点击点,不越出视口", () => {
    clickAt(300, 780);
    const { top } = box();
    expect(top).toBe(780 - H);
    expect(top + H).toBeLessThanOrEqual(window.innerHeight);
  });

  it("右下角:两个方向同时翻", () => {
    clickAt(950, 780);
    expect(box()).toEqual({ left: 950 - W, top: 780 - H });
  });

  it("左上角原点:不产生负坐标(否则弹窗有一半在屏外)", () => {
    clickAt(0, 0);
    const { left, top } = box();
    expect(left).toBeGreaterThanOrEqual(GAP);
    expect(top).toBeGreaterThanOrEqual(GAP);
  });

  it("视口比弹窗还小时夹进视口,宁可盖住点击点也要让用户看得见", () => {
    window.innerWidth = 200;
    window.innerHeight = 120;
    clickAt(150, 100);
    const { left, top } = box();
    expect(left).toBeGreaterThanOrEqual(GAP);
    expect(top).toBeGreaterThanOrEqual(GAP);
  });

  it("页面滚动后弹窗跟着元素走(锚点存的是页面坐标,不是视口坐标)", () => {
    window.scrollY = 100;
    clickAt(300, 200);          // 页面坐标 y = 300
    expect(box().top).toBe(200);
    // 再往下滚 50:同一个页面位置在视口里上移 50。
    window.scrollY = 150;
    window.dispatchEvent(new window.Event("scroll"));
    expect(box().top).toBe(150);
  });

  it("合成事件没带坐标时退回元素左上角,而不是甩到视口原点", () => {
    const el = document.getElementById("go");
    el.getBoundingClientRect = () => ({ left: 42, top: 84, width: 10, height: 10, right: 52, bottom: 94 });
    document.elementFromPoint = () => el;
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(box()).toEqual({ left: 42, top: 84 });
  });
});
