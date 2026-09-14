// 卡片详情弹窗:聊天记录里所有卡片的唯一"展开"出口。
// 对齐 Mac 的 CardDetailSheet —— 记录流里只留一行入口(标题 + 摘要),
// 点击才把重内容(终端块 / JSON / 计划文档 / 思考全文 / workflow 成员)建出来。
//
// 这样长会话不会在滚动区里堆出成百上千个隐藏的 <pre>:弹窗一次只活一个,
// 关闭即销毁。内容用 builder 惰性构建,入口行本身不持有任何重 DOM。
import { t } from "../../shared/i18n.js";
import { lucideIcon, lucideIconSvg } from "./file-icons.js";

let singleton = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/// 懒建单例 <dialog>。整个侧栏共用一个,避免每张卡片各自挂一个模态。
function ensureDialog() {
  if (singleton?.isConnected) return singleton;
  const dialog = el("dialog", "card-detail");
  dialog.innerHTML =
    '<div class="card-detail-head">' +
      '<span class="card-detail-title"></span>' +
      '<button class="card-detail-copy act-btn" type="button"></button>' +
      '<button class="card-detail-close act-btn" type="button">' + lucideIconSvg("x", { size: 14 }) + '</button>' +
    '</div>' +
    '<div class="card-detail-body"></div>';
  document.body.append(dialog);
  const close = dialog.querySelector(".card-detail-close");
  close.title = t("card.close");
  close.setAttribute("aria-label", t("card.close"));
  close.addEventListener("click", () => hide(dialog));
  // 关闭后清空正文:弹窗一次只留一份内容,避免旧卡片的 DOM 常驻。
  dialog.addEventListener("close", () => {
    dialog.querySelector(".card-detail-body").replaceChildren();
  });
  // 点击 backdrop 关闭(点在 dialog 自身矩形之外即视为 backdrop)。
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right
      && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) hide(dialog);
  });
  singleton = dialog;
  return dialog;
}

/// 关闭一个弹窗。<dialog> 未实现时(jsdom)退回 open 属性,
/// 并手动补发 close 事件——正文清空挂在那个事件上。
function hide(dialog) {
  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }
  if (!dialog.open) return;
  dialog.open = false;
  dialog.dispatchEvent(new Event("close"));
}

/// 打开详情弹窗。
/// - title:标题行文案
/// - build:惰性构建正文的函数,返回要塞进 body 的节点(点击时才调用)
/// - copyText:有纯文本形态时给出,复制键才出现(对齐 Mac:结构化 UI 不给复制)
export function openCardDetail({ title, build, copyText }) {
  const dialog = ensureDialog();
  dialog.querySelector(".card-detail-title").textContent = title ?? "";
  const body = dialog.querySelector(".card-detail-body");
  body.replaceChildren();
  const built = build?.();
  if (built) body.append(built);

  const copy = dialog.querySelector(".card-detail-copy");
  // copyText 是函数时**不在这里求值**:工具输出/参数可能有几 MB,打开弹窗只为
  // 决定复制键是否出现而先拼一份全文,等于把省下的开销又付一遍。函数形态一律
  // 认为"有文本可复制",真正的字符串留到点复制时再构建。
  const lazyCopy = typeof copyText === "function" ? copyText : null;
  const text = lazyCopy ? null : copyText;
  copy.hidden = !(lazyCopy || text);
  if (lazyCopy || text) {
    const paint = (done) => copy.replaceChildren(lucideIcon(done ? "check" : "copy", { size: 14 }));
    paint(false);
    copy.title = t("copy");
    copy.setAttribute("aria-label", t("copy"));
    copy.onclick = () => {
      const value = lazyCopy ? lazyCopy() : text;
      if (!value) return;
      navigator.clipboard?.writeText(value).catch(() => {});
      paint(true);
      setTimeout(() => paint(false), 1200);
    };
  }

  // jsdom 没实现 showModal,测试里退化成普通打开。
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.open = true;
  return dialog;
}

/// 关闭当前弹窗(会话切换 / 重置时调用,避免详情停留在上一个会话)。
export function closeCardDetail() {
  if (singleton?.open) hide(singleton);
}

/// 造一个"入口行":点击打开详情。所有卡片共用同一套可点击语义。
/// 返回的按钮由调用方决定塞什么内容(图标 / 标签 / 后缀)。
export function makeDetailTrigger({ className, title, build, copyText, ariaLabel }) {
  const trigger = el("button", className);
  trigger.type = "button";
  if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);
  trigger.addEventListener("click", () => openCardDetail({ title: title(), build, copyText }));
  return trigger;
}

/// 只在测试里用:丢弃单例,让下一次 open 重新建。
export function _resetCardDetail() {
  singleton?.remove();
  singleton = null;
}
