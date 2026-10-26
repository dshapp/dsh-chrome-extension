// 切会话时的历史加载态。
//
// 打开一个历史会话分两步:session.open 只做 attach + 订阅 follow 流,很快就返回;
// 真正的记录要等 follow 流的 snapshot 帧到了才灌进 store。中间这段时间 store 刚被
// reset、nodes 为空 —— 只看 nodes 分不出"还在加载"和"真的是空会话",于是用户先看到
// 一片空白(或「开始对话」空态),以为点错了会话。
//
// 这里用 store 的 historyLoaded 判定,在历史落地之前占住消息区:顶部一行转圈 + 文案,
// 下面是对话形状的骨架屏。淡入有一个很短的延迟(见 conversation.css),
// 历史瞬间就到的情况下不会闪一下。
import { t } from "../../shared/i18n.js";

/**
 * 这个快照是否还处在"历史没到"的阶段。
 *
 * @param {object|null} snapshot store 快照。
 * @param {object} [options]
 * @param {string|null} [options.freshSessionId] 刚新建的会话:它没有历史可等,直接给空态。
 */
export function isAwaitingHistory(snapshot, { freshSessionId = null } = {}) {
  if (!snapshot?.sessionId) return false;
  if (snapshot.historyLoaded || snapshot.historyError) return false;
  if (snapshot.sessionId === freshSessionId) return false;
  // 已经有东西可看(比如提交后乐观贴出的插队消息)就不再用骨架挡住它。
  if ((snapshot.nodes?.length ?? 0) > 0 || (snapshot.pendingSteering?.length ?? 0) > 0) return false;
  return true;
}

/// 骨架行:右侧一个用户气泡,左侧几行长短不一的正文,重复两轮。
const SKELETON_ROWS = [
  ["user", 46], ["line", 92], ["line", 84], ["line", 58],
  ["user", 34], ["line", 88], ["line", 70]
];

/**
 * 挂载加载层。host 是 #messages 里的 #session-loading 占位元素。
 * @returns {{ set(active: boolean): void, show(): void, hide(): void, readonly visible: boolean }}
 */
export function mountSessionLoading(host) {
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  host.innerHTML = [
    '<div class="session-loading-head">',
    '<span class="session-loading-spinner" aria-hidden="true"></span>',
    '<span class="session-loading-label"></span>',
    "</div>",
    '<div class="session-loading-skeleton" aria-hidden="true">',
    ...SKELETON_ROWS.map(([kind, width]) =>
      `<span class="sk sk-${kind}" style="inline-size:${width}%"></span>`),
    "</div>"
  ].join("");
  const label = host.querySelector(".session-loading-label");

  function set(active) {
    // 文案每次都重写:语言切换(relabel)会重走 applySnapshot,顺带就换了语言。
    if (active) label.textContent = t("sessions.loadingConversation");
    host.hidden = !active;
  }

  return {
    set,
    show: () => set(true),
    hide: () => set(false),
    get visible() { return !host.hidden; }
  };
}
