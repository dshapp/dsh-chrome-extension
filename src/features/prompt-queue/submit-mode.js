// 发送手势 → 投递模式的判定(对齐宿主 dsh-client-ui-conversation 的
// ComposerSubmissionPolicy.resolve)。
//
// 宿主接受两种投递模式:
//   queue —— 追加到待发送队列,等当前轮跑完再依次发出
//   steer —— 插队:直接并入 agent 当前轮(next-step inbox),立即被消费
//
// 关键语义(用户反馈的那个 bug 就出在这):插队要发的是**输入框里这一条**,
// 队列必须保持原样。所以插队走的是 session.prompt(mode:"steer"),
// 而不是 session/queue 的 steer 动作 —— 后者是"把队列里某条提前",
// 会把队列条目立刻发出去而把输入框留在原地,正好是反的。

/// 普通 Enter 在 agent 忙时的默认行为,与宿主默认值一致。
export const DEFAULT_BUSY_ENTER = "queue";

/// 判定一次发送手势该用哪种模式。
///
/// @param running          agent 是否正在跑。没在跑就没有"当前轮"可插。
/// @param gesture          "enter" 普通回车 | "modifier" 插队快捷键
/// @param steeringAvailable 该会话是否支持插队(子代理会话不归本端管)
/// @param busyEnter        用户偏好:忙时普通回车是 queue 还是 steer
///
/// 不在运行 / 不支持插队时一律 queue —— 此时 prompt 会正常开启新一轮。
/// 运行中:普通回车用偏好值,插队快捷键取偏好的**反面**(与宿主一致,
/// 这样偏好被改成 steer 后快捷键仍然是"另一种"投递,不会两个手势同义)。
export function resolveSubmitMode(running, gesture, steeringAvailable = true, busyEnter = DEFAULT_BUSY_ENTER) {
  if (!running || !steeringAvailable) return "queue";
  const preferred = busyEnter === "steer" ? "steer" : "queue";
  if (gesture !== "modifier") return preferred;
  return preferred === "queue" ? "steer" : "queue";
}

/// 是不是插队快捷键。用户要求 Option(Alt)+Command+Enter;
/// 非 mac 上对应 Alt+Ctrl+Enter。
///
/// 必须同时按住两个修饰键才算,避免和"Cmd+Enter"等既有手势抢键。
export function isSteerChord(event, { mac = true } = {}) {
  if (!event || event.key !== "Enter") return false;
  if (!event.altKey) return false;
  return mac ? event.metaKey === true : event.ctrlKey === true;
}

/// 快捷键的展示文案,给 tooltip / 设置页用。
export function steerChordLabel(mac = true) {
  return mac ? "⌥⌘↩" : "Alt+Ctrl+Enter";
}
