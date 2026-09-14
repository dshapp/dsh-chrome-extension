// 排队消息面板:对齐 Mac 端 QueueDock(Components/Conversation/Docks.swift)。
//
// 视觉契约:面板贴在输入卡上方,12px 圆角 + 1px 边框,内部每条 36px 行,行间
// 细分隔线;没有计数头、不折叠 —— 排队内容一眼可读,不用点开。每行结构为
// 列表字形 + 预览文本(或编辑输入框)+ 右侧图标动作(编辑/删除/插队,
// 编辑态换成保存/取消)。
//
// 只渲染 placement === "queued" 的条目:steering/context 由宿主直接并入当前轮,
// 不属于"待发送队列",混在一起会让用户以为它们还能被删。
import { escapeHtml } from "../../shared/md-to-html.js";
import { t } from "../../shared/i18n.js";
import { blocksToText } from "../sessions/chat-nodes.js";
import { lucideIconSvg } from "../chat/file-icons.js";

/// 仅当每个内容块都是纯文本时才可编辑 —— 图片/附件无法用单行输入框无损表达,
/// 保存会静默丢掉它们(对齐 Mac QueueInteractionState.editableText)。
export function editableText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") return null;
    if (block.type !== "text" || typeof block.text !== "string") return null;
    parts.push(block.text);
  }
  const text = parts.join("\n");
  return text ? text : null;
}

// 图标统一取自共享 lucide 图标表(见 features/chat/file-icons.js),
// 不再在这里自建 svg 字符串;stroke 也随之统一到 lucide 默认的 2。
const GLYPH = lucideIconSvg("list", { size: 14, className: "queue-glyph" });

const ICONS = {
  edit: lucideIconSvg("pencil", { size: 14 }),
  remove: lucideIconSvg("trash-2", { size: 14 }),
  steer: lucideIconSvg("send-horizontal", { size: 14 }),
  save: lucideIconSvg("check", { size: 14 }),
  cancel: lucideIconSvg("x", { size: 14 })
};

/// 渲染排队面板。
///
/// @param items   session/queue 快照
/// @param onAction (itemId, action) => void;action 为 "steer" | "remove",
///                 或 { kind: "edit", text }
/// @param running  仅 agent 运行中才可插队 —— 不在运行就没有"当前轮"可插。
/// @param mutable  子代理会话的队列不归本端管,只读展示。
/// @param onError  (error, itemId, action) => void;onAction 失败时的上报口。
///                 不传也不会漏成未处理拒绝,只是失败对用户不可见。
export function createQueuePanel(items, { onAction, onError, running = false, mutable = true } = {}) {
  const element = document.createElement("div");
  element.className = "queue-dock";

  // 面板自身的编辑态:哪一行在编辑、哪一行有请求在飞。请求在飞时禁掉全部动作,
  // 避免同一条目上叠加两次互相打架的变更。
  let editingId = null;
  let busyId = null;

  const queued = (items ?? []).filter((item) => (item.placement ?? "queued") === "queued");

  function render() {
    if (!queued.length) {
      element.hidden = true;
      element.replaceChildren();
      return;
    }
    element.hidden = false;
    element.innerHTML = queued.map((item) => renderRow(item)).join("");
    const input = element.querySelector(".queue-edit-input");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function renderRow(item) {
    const editing = editingId === item.id;
    const busy = busyId === item.id;
    const draft = editing ? editableText(item.message) ?? "" : "";
    const body = editing
      ? `<input class="queue-edit-input" type="text" value="${escapeHtml(draft)}"
           placeholder="${escapeHtml(t("queue.itemPlaceholder"))}" aria-label="${escapeHtml(t("queue.editItem"))}">`
      : `<span class="queue-text" title="${escapeHtml(blocksToText(item.message?.content))}">${escapeHtml(blocksToText(item.message?.content))}</span>`;
    return [
      `<div class="queue-row${busy ? " is-busy" : ""}" data-item-id="${escapeHtml(item.id)}">`,
      GLYPH,
      body,
      mutable ? `<div class="queue-actions">${renderActions(item, editing, busy)}</div>` : "",
      "</div>"
    ].join("");
  }

  function renderActions(item, editing, busy) {
    if (editing) {
      return [
        action("save", ICONS.save, t("queue.save"), busy),
        action("cancel", ICONS.cancel, t("queue.cancel"), busy)
      ].join("");
    }
    return [
      action("edit", ICONS.edit, t("queue.editItem"), busy || editableText(item.message) === null),
      action("remove", ICONS.remove, t("queue.remove"), busy),
      // 插队只在运行中可用;不可用时 title 说明原因,而不是把按钮藏掉 ——
      // 藏掉会让"这条能不能插队"随 agent 状态忽隐忽现。
      action("steer", ICONS.steer, running ? t("queue.steer") : t("queue.steerUnavailable"), busy || !running)
    ].join("");
  }

  function action(kind, icon, label, disabled) {
    return `<button class="queue-btn" type="button" data-action="${kind}" title="${escapeHtml(label)}"
      aria-label="${escapeHtml(label)}"${disabled ? " disabled" : ""}>${icon}</button>`;
  }

  element.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const row = button.closest("[data-item-id]");
    if (!row) return;
    const itemId = row.dataset.itemId;
    const kind = button.dataset.action;
    if (kind === "edit") { editingId = itemId; render(); return; }
    if (kind === "cancel") { editingId = null; render(); return; }
    if (kind === "save") { commitEdit(itemId, row.querySelector(".queue-edit-input")); return; }
    dispatch(itemId, kind);
  });

  // Enter 保存、Escape 取消:与 Mac 端编辑框键位一致。
  element.addEventListener("keydown", (event) => {
    const input = event.target.closest(".queue-edit-input");
    if (!input) return;
    const row = input.closest("[data-item-id]");
    if (event.isComposing) return; // 组字确认候选的 Enter 不提交编辑
    // 输入框可能已经脱离所属行(重渲染竞态下事件仍会冒泡上来),此时没有可提交的
    // 目标 —— 与上面 click 分支的 !row 处理保持一致,直接放过。
    if (!row) return;
    if (event.key === "Enter") { event.preventDefault(); commitEdit(row.dataset.itemId, input); }
    else if (event.key === "Escape") { event.preventDefault(); editingId = null; render(); }
  });

  function commitEdit(itemId, input) {
    const text = (input?.value ?? "").trim();
    if (!text) return;
    dispatch(itemId, { kind: "edit", text });
  }

  /// 发一次变更并在返回前锁住该行。成功后由宿主推送的 session/queue 帧决定
  /// 最终列表,这里只负责解锁与退出编辑态。
  function dispatch(itemId, action) {
    if (busyId) return;
    busyId = itemId;
    render();
    // .finally 不消费拒绝:少了这个 catch,onAction 失败就会变成未处理拒绝,
    // 而 UI 照常解锁,用户以为改动生效了。失败交给调用方的 onError 上报。
    Promise.resolve(onAction?.(itemId, action)).catch((error) => {
      onError?.(error, itemId, action);
    }).finally(() => {
      busyId = null;
      if (typeof action === "object" && action.kind === "edit") editingId = null;
      render();
    });
  }

  render();
  return element;
}
