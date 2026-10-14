// 会话抽屉里行尾那排按钮的动作:置顶 / 分叉 / 重命名 / 归档,以及归档行的取消归档。
//
// 从 sidepanel-overlays.js 拆出来:那个文件负责抽屉的编排(开关、搜索、键盘、
// 分组),行动作是一套独立的"宿主往返 + 在途态"逻辑,和它们没有共享状态。

import { t } from "../../shared/i18n.js";

/**
 * @param {object} options
 * @param {Element} options.list 会话列表 <ul>(重画后按 id 重新找行)。
 * @param {object} options.sessions 会话服务(fork / rename / archive / unarchive)。
 * @param {object|null} options.pinnedStore 置顶账本。
 * @param {() => string|null} options.activeSessionId 当前会话。
 * @param {object} options.hooks hide / openSession / newSession / refresh / paint / showToast / formatErrorDetails。
 */
export function createHistoryRowActions({ list, sessions, pinnedStore, activeSessionId, hooks }) {
  const { hide, openSession, newSession, refresh, paint, showToast, formatErrorDetails } = hooks;
  // 正在跑 fork/rename/archive 的会话 id:同一行的操作按钮在往返期间禁用。
  const rowBusy = new Set();

  async function run(action, row) {
    const sessionId = row?.dataset.sessionId;
    if (!sessionId) return;
    // 置顶是乐观更新:账本立即变,0.1.7 宿主模式下的 RPC 在后台结算(失败回滚 + toast),
    // 所以这里不需要在途标记。
    if (action === "pin") {
      pinnedStore?.setPinned?.(sessionId, !pinnedStore.isPinned(sessionId));
      paint();
      return;
    }
    // fork / archive 都会改变会话集合,且宿主往返期间抽屉保持打开、按钮仍可点。
    // 没有在途标记的话,连点两下会 fork 出两个子会话,或在归档当前会话时多建
    // 一个空白会话。整行按钮一起禁用并给出进行中样式。
    if (rowBusy.has(sessionId)) return;
    rowBusy.add(sessionId);
    setRowBusy(row, true);
    try {
      if (action === "fork") {
        const forkedId = await sessions.fork(sessionId);
        hide();
        openSession(forkedId);
      } else if (action === "rename") {
        const name = prompt(t("session.renamePrompt"));
        if (name) { await sessions.rename(sessionId, name); refresh(); }
      } else if (action === "unarchive") {
        // 回包即完整归档集合;服务随后重拉列表,这一行以普通会话的样子回到原组。
        try { await sessions.unarchive(sessionId); } catch {
          // 老宿主(0.1.6 之前)没有这个 RPC,也会走到这里 —— 给提示而不是悄悄不动。
          showToast?.(t("sessions.unarchiveFailed"));
          return;
        }
        paint();
      } else if (action === "archive") {
        // 归档不是删除:宿主保留日志,只是从活动列表移出。
        const archived = await sessions.archive(sessionId, { confirmStop: confirmArchiveActive });
        if (archived === null) return;
        if (sessionId === activeSessionId()) {
          // 当前转录已经不属于活动列表；继续停在这里会留下一个标题仍选中、
          // 但列表里找不到的幽灵会话。与 Mac 一致，归档当前项后进入新会话。
          hide();
          await newSession();
        } else {
          refresh();
        }
      }
    } catch (error) {
      // 与全局一致用 toast:alert 会阻塞 UI 线程,且和应用其余部分的报错风格不符。
      showToast?.(formatErrorDetails(error));
    } finally {
      rowBusy.delete(sessionId);
      // 行可能已被 refresh() 重建或随归档消失,重新查一次当前 DOM 里的它。
      setRowBusy(list.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`), false);
    }
  }

  /// 归档一个还在跑的会话前的确认(0.1.7 workspace/session-active)。
  function confirmArchiveActive() {
    return Promise.resolve(window.confirm(t("session.archiveActiveConfirm")));
  }

  /// 整行的操作按钮统一进入/退出在途态。
  function setRowBusy(row, busy) {
    if (!row) return;
    row.classList.toggle("is-busy", busy);
    for (const button of row.querySelectorAll("button[data-action]")) button.disabled = busy;
  }

  return { run };
}
