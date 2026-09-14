// 尾部跟随语义,逐条对齐 macos/Sources/DSHMacKit/Models/TranscriptTailFollow.swift。
//
// 发送是"我要看这个回答"的承诺:从提交那刻起把转录钉在最新内容上,直到**轮次真正结束**
// 或**读者自己向上滚**。不能只看"距底 < N px":新行插入会让 floor 先跳、offset 后到,
// 那段窗口里视口看起来"被滚上去了",而读者其实没碰任何东西;固定的 slack 必然误判。
//
// 因此释放判据看 offset 自身:只有视口**向上**移动(读者滚动)才算离开。内容在下方
// 增长只动 floor、不动 offset,天然不可见。

/// 已停稳后,视口向上漂移超过该值才算读者滚离。
export const SCROLL_AWAY_TOLERANCE = 24;
/// 一次 pin 之后,这段时间内的 offset 移动是视图自己的工作(滚动 + 回弹),不计入释放判定。
export const PIN_SETTLE_WINDOW_MS = 150;

export function createTailFollow({ now = () => Date.now() } = {}) {
  let isFollowing = false;
  let lastOffset = null;
  let sawRunning = false;
  let stopPending = false;
  let pinSettlesAt = null;

  /// 本地发送开始跟随。offset 基准取发送后的下一帧(echo 行落地),不是发送前的旧位置。
  function didSubmit() {
    isFollowing = true;
    lastOffset = null;
    // 发送先于 running 变 true,所以不能被此刻仍是 false 的 running 释放。
    sawRunning = false;
    stopPending = false;
    pinSettlesAt = null;
  }

  /// running 变化本身不释放:会话列表刷新会整体写 summary.running,一轮中可能
  /// true→false→true 抖动。stop 只在这里"上膛",由 transcriptChanged 用仍在
  /// 产出的内容证伪。
  function runningChanged(running) {
    if (!isFollowing) return;
    if (running) {
      sawRunning = true;
      stopPending = false;
    } else if (sawRunning) {
      stopPending = true;
    }
  }

  /// 转录有修订。仍在流动的内容证伪一次 pending stop。
  function transcriptChanged() {
    if (!isFollowing) return;
    stopPending = false;
  }

  /// 确认一次熬过静默窗口的 stop:回答确实结束了。返回是否因此释放。
  function confirmStop() {
    if (!isFollowing || !stopPending) return false;
    release();
    return true;
  }

  /// 视口移动。只有 offset 向上超过阈值才释放;比较基准是本轮跟随到过的最深位置,
  /// 连续的小回弹不会像逐次两两比较那样累积成误判。
  function viewportChanged(offsetY) {
    if (!isFollowing) return;
    if (pinSettlesAt != null) {
      if (now() < pinSettlesAt) {
        lastOffset = lastOffset == null ? offsetY : Math.max(lastOffset, offsetY);
        return;
      }
      pinSettlesAt = null;
    }
    if (lastOffset == null) {
      lastOffset = offsetY;
      return;
    }
    if (offsetY < lastOffset - SCROLL_AWAY_TOLERANCE) {
      release();
      return;
    }
    lastOffset = Math.max(lastOffset, offsetY);
  }

  /// 视图将要执行一次 pin:在 settle 窗口内折扣它自己造成的 offset 移动。
  function beginPin() {
    if (!isFollowing) return;
    pinSettlesAt = now() + PIN_SETTLE_WINDOW_MS;
  }

  /// 离开本转录(切会话、跳转、卸载):丢掉属于旧内容的跟随。
  function release() {
    isFollowing = false;
    lastOffset = null;
    sawRunning = false;
    stopPending = false;
    pinSettlesAt = null;
  }

  return {
    get isFollowing() { return isFollowing; },
    get isStopPending() { return stopPending; },
    didSubmit, runningChanged, transcriptChanged, confirmStop, viewportChanged, beginPin, release
  };
}
