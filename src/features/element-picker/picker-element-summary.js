// 元素摘要构建器,作为**独立注入体**执行:把 buildSummary 挂到页面 window 上,
// 供 overlay 脚本调用。拆开是为了让两个注入体各自保持在体积约束内,
// 同时都满足"自包含、不引用模块作用域、不 eval"的序列化要求。

/** @param {{ maxTextLength?: number }} options */
export function elementPickerSummaryScript(options) {
  const maxTextLength = (options && options.maxTextLength) || 120;
  const win = window;
  const doc = document;

  const isSensitive = el => {
    if (el.tagName !== "INPUT") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const hint = ((el.getAttribute("name") || "") + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
    return /pass|secret|token|cvv|otp/.test(hint);
  };

  const visibleText = el => {
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    return raw.slice(0, maxTextLength);
  };

  const describe = el => {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, maxTextLength);
    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim().slice(0, maxTextLength);
    if (el.tagName === "INPUT" && !isSensitive(el) && el.value) {
      return String(el.value).slice(0, maxTextLength);
    }
    const text = visibleText(el);
    if (text) return text;
    let fallback = el.tagName.toLowerCase();
    if (el.id) fallback += "#" + el.id;
    else if (typeof el.className === "string" && el.className.trim()) {
      fallback += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    return fallback;
  };

  // CSS.escape 在部分环境(如 jsdom)缺失,退化为保守的手工转义。
  const escapeIdent = value => {
    const raw = String(value);
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(raw);
    return raw.replace(/[^a-zA-Z0-9_-]/g, ch => "\\" + ch);
  };

  // 只有能被 querySelector 反查、且在文档内唯一时才敢用 id 短路。
  const idIsUsable = node => {
    if (!node.id) return false;
    try {
      return doc.querySelectorAll("#" + escapeIdent(node.id)).length === 1;
    } catch {
      return false;
    }
  };

  // id 优先,否则逐级 tag:nth-of-type(n) 上溯到 body,保证 read_page 重置 ref 表后仍可定位。
  const cssSelector = el => {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.body && parts.length < 12) {
      if (idIsUsable(node)) {
        parts.unshift("#" + escapeIdent(node.id));
        return parts.join(" > ");
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      let index = 1;
      for (const sibling of parent.children) {
        if (sibling === node) break;
        if (sibling.tagName === node.tagName) index += 1;
      }
      const sameTag = Array.prototype.filter.call(parent.children, s => s.tagName === node.tagName);
      parts.unshift(sameTag.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
      node = parent;
    }
    return (node === doc.body ? ["body"].concat(parts) : parts).join(" > ");
  };

  // 绝对 XPath:逐级 tag[n],同名兄弟才带下标。id 唯一时用 //*[@id="..."] 起头缩短路径。
  const xPath = el => {
    if (!el || el.nodeType !== 1) return "";
    const steps = [];
    let node = el;
    while (node && node.nodeType === 1 && steps.length < 40) {
      const tag = node.tagName.toLowerCase();
      if (node.id && idIsUsable(node)) {
        // XPath 字符串字面量无法转义引号,含引号的 id 退回纯路径。
        if (!node.id.includes('"')) {
          steps.unshift('//*[@id="' + node.id + '"]');
          return steps.join("/").replace(/^\/\/\/+/, "//");
        }
      }
      const parent = node.parentElement;
      if (!parent) {
        steps.unshift("/" + tag);
        break;
      }
      let index = 1;
      let siblings = 0;
      for (const sibling of parent.children) {
        if (sibling.tagName === node.tagName) {
          siblings += 1;
          if (sibling === node) index = siblings;
        }
      }
      steps.unshift(siblings > 1 ? tag + "[" + index + "]" : tag);
      node = parent;
    }
    const path = steps.join("/");
    return path.startsWith("/") ? path : "/" + path;
  };

  // picker 自己的引用表,不会被 read_page(generateA11yTree)整表重置;
  // 同时把元素追加登记进 __claudeElementMap,让 computer 工具能直接按 ref 操作。
  const registerRef = el => {
    win.__cmPickerMap = win.__cmPickerMap || {};
    win.__claudeElementMap = win.__claudeElementMap || {};
    win.__claudeRefCounter = win.__claudeRefCounter || 0;
    const ref = "ref_" + ++win.__claudeRefCounter;
    const handle = typeof win.WeakRef === "function" ? new win.WeakRef(el) : el;
    win.__cmPickerMap[ref] = handle;
    win.__claudeElementMap[ref] = handle;
    return ref;
  };

  const summarize = el => {
    const rect = el.getBoundingClientRect();
    return {
      ref: registerRef(el),
      selector: cssSelector(el),
      xpath: xPath(el),
      tag: el.tagName.toLowerCase(),
      role: (el.getAttribute && el.getAttribute("role")) || "",
      name: describe(el),
      text: visibleText(el),
      attrs: {
        id: el.id || "",
        class: typeof el.className === "string" ? el.className.trim().slice(0, 120) : "",
        ariaLabel: (el.getAttribute && el.getAttribute("aria-label")) || "",
        placeholder: (el.getAttribute && el.getAttribute("placeholder")) || "",
        href: (el.getAttribute && el.getAttribute("href")) || "",
      },
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      url: location.href,
      title: doc.title,
    };
  };


  win.__cmPickerSummary = { build: summarize };
  return { ok: true };
}
