// 聊天记录顶端的「加载更早」(对齐 Mac ConversationRoot 的 LoadMoreButton)。
//
// 已加载窗口之前还有历史(session/page hasMore)时出现在 #msg-list 上方。
// 它不只是翻页入口:窗口还能向前增长时 turn process 不折叠(早期过程行可能尚未加载),
// 读者要靠它把整轮加载进来,折叠才会生效。
import { t } from "../../shared/i18n.js";

export function mountHistoryLoadOlder(msgList, { onLoad }) {
  const row = document.createElement("div");
  row.id = "history-load-older";
  row.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("history.loadOlder");
  row.append(button);
  msgList.before(row);

  let loading = false;
  button.addEventListener("click", async () => {
    if (loading) return;
    loading = true;
    button.disabled = true;
    button.textContent = t("history.loadingOlder");
    try {
      await onLoad?.();
    } catch {
      // 失败时按钮恢复可点,读者可以重试;错误由会话层自己的通道上报。
    } finally {
      loading = false;
      button.disabled = false;
      button.textContent = t("history.loadOlder");
    }
  });

  return {
    update(visible) {
      row.hidden = !visible;
    }
  };
}
