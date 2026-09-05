// 审批卡:权限确认，经 `$events/result` 应答。
// 对齐 macos/.../ComposerOverlays.swift 的 ApprovalPanel:
// 琥珀条 + 原因 + 工具名 + (bash 时)命令代码块 + [拒绝][允许一次]。
import { t } from "../../shared/i18n.js";
import { resolveApprovalPresentation } from "./interaction-flow.js";
import { APPROVAL_OUTCOME } from "../../platform/dsh/rpc-methods.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createApprovalCard(approval, { onRespond, store } = {}) {
  const presentation = resolveApprovalPresentation(approval, store, t);
  const card = el("article", "approval-card");
  let busy = false;

  // ---- 琥珀状态条 ----
  const strip = el("header", "interaction-strip");
  strip.append(el("span", "interaction-dot"), el("span", "interaction-strip-label", t("approval.waiting")));

  // ---- 主体 ----
  const body = el("div", "interaction-body");
  body.append(el("div", "approval-reason", presentation.reason));
  body.append(el("code", "approval-tool", presentation.toolName));
  if (presentation.command) {
    const pre = el("pre", "approval-command");
    pre.append(el("code", null, presentation.command));
    body.append(pre);
  }

  // ---- 操作行 ----
  const actions = el("div", "interaction-actions");
  const errorLine = el("div", "interaction-error");
  errorLine.hidden = true;
  const refuse = el("button", "btn", t("approval.refuse"));
  refuse.type = "button";
  const allow = el("button", "btn primary", t("approval.allowOnce"));
  allow.type = "button";
  actions.append(errorLine, el("span", "interaction-spacer"), refuse, allow);

  function setBusy(next) {
    busy = next;
    refuse.disabled = next;
    allow.disabled = next;
  }

  async function answer(outcome) {
    if (busy) return;
    setBusy(true);
    errorLine.hidden = true;
    try {
      const receipt = await onRespond(approval.rpcId, {
        ok: true,
        value: { sessionId: approval.sessionId, approvalId: approval.approvalId, outcome }
      });
      // 两种结局都解锁。这个闩只为阻止一次在途请求期间的二次发送,回执即终结;
      // 卡片本身会在宿主下发 approval/resolved 帧清空挂起交互时消失。
      // 保持锁定会让一个"已被接受但帧没到"的答案把整张卡按死:无错误、无转圈、
      // 也无从推进这一轮。
      setBusy(false);
      if (receipt && receipt.accepted === false) {
        errorLine.textContent = t("interaction.notAccepted");
        errorLine.hidden = false;
      }
    } catch (error) {
      setBusy(false);
      errorLine.textContent = error?.message || String(error);
      errorLine.hidden = false;
    }
  }

  refuse.addEventListener("click", () => answer(APPROVAL_OUTCOME.rejected));
  allow.addEventListener("click", () => answer(APPROVAL_OUTCOME.allowedOnce));

  // Enter = 允许(与其他对话框一致),⌘/Ctrl+D = 拒绝。
  function onKeyDown(event) {
    if (busy) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      answer(APPROVAL_OUTCOME.allowedOnce);
    } else if (event.key.toLowerCase() === "d" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      answer(APPROVAL_OUTCOME.rejected);
    }
  }
  document.addEventListener("keydown", onKeyDown, true);
  card.dispose = () => document.removeEventListener("keydown", onKeyDown, true);

  card.append(strip, body, actions);
  queueMicrotask(() => allow.focus());
  return card;
}
