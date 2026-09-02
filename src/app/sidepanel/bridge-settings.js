// Bridge(CDP 桥)连接状态的数据源。
//
// 桥的真实状态只在 service worker 里(WebSocket 连接),侧栏通过 runtime 消息
// **只读** —— 与 background.js 的 get_state 协议对接。
//
// 这里没有开关:桥常驻、不可关闭。Agent 控制就是本扩展的存在理由,一个能把它
// 关掉的开关只会制造"装了却不工作"的故障态 —— 用户忘了自己关过,然后来报
// "Agent 连不上"。所以它退化成一盏纯粹的状态灯:连上了,或者还没连上。
//
// 本模块**不碰 DOM**。它以前直接持有 #set-bridge-* 几个节点并往里写文字,那要求
// 那些节点必须活在服务端 pane 的渲染区之外(否则一次 refresh 就把它们换掉,
// paint 从此写进一个已 detach 的元素),代价是桥只能单独占一张卡。
// 现在它只负责"轮询 + 通知",由 pane 自己渲染那一行,于是桥能作为一行并进
// 服务信息卡里。
const POLL_INTERVAL_MS = 1000;

// 桥半部可能整体缺席(例如把侧栏单独跑在普通页面里做调试)。
function canReachWorker() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

async function requestState() {
  try {
    return await chrome.runtime.sendMessage({ type: "get_state" });
  } catch {
    return null;
  }
}

/**
 * 轮询桥状态,每次拿到新结果就回调 onChange(state)。
 *
 * state 形状:{ available, connected, url }。available 为 false 表示这个部署里
 * 根本没有桥半部 —— 调用方据此整行不画,而不是画一盏永远不亮的灯。
 *
 * @param onChange 状态变化时调用(首次 refresh 也会调一次)。
 */
export function createBridgeStatus({ onChange } = {}) {
  let timer = null;
  let last = null;

  function publish(next) {
    // 同值不重复通知:pane 收到就会重画那一行,每秒白重画一次没有意义。
    const same = last
      && last.available === next.available
      && last.connected === next.connected
      && last.url === next.url;
    last = next;
    if (!same) onChange?.(next);
  }

  async function refresh() {
    if (!canReachWorker()) {
      publish({ available: false, connected: false, url: null });
      return;
    }
    const state = await requestState();
    publish({
      available: true,
      connected: Boolean(state?.connected),
      url: state?.url ?? null
    });
  }

  return {
    /// 当前已知状态(pane 首次渲染时同步读,避免第一帧空着)。
    get: () => last,
    /// 只在设置页可见时轮询,避免侧栏常驻时每秒唤醒 service worker。
    start() {
      void refresh();
      if (!timer) timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
