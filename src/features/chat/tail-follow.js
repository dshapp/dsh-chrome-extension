// 尾部跟随,对齐 DSH Web 的 ScrollFollow / ChatReading(dsh-client-ui-chat use-scroll-follow.ts):
//
// - 跟随意图只由**阅读位置**决定:停在底部(距底 ≤ 阈值)就跟随,内容增长时钉住最新;
//   读者自己把视口往上带离底部就不再跟随,之后的流式内容不会把他拽回去。
// - 读者自己滚回底部(或点「回到底部」按钮)即恢复跟随,不必等下一次发送。
// - 轮次结束不释放:停在底部的读者照样看到收尾的内容(对齐 web,不再沿用 Mac 的"轮次结束即放手")。
//
// 程序自己的 pin 不算读者移动:pin 后记下落点,滚动事件的 offset 与之相同就是我们自己的回声。
// 内容在下方增长只动 floor、不动 offset,不会产生滚动事件,所以也不会被误判成"上滚"。
// 触控板/滚轮一次只挪几个像素,单看位置会被下一帧的 pin 拽回去;因此向上的滚轮意图直接释放。

/// 距底不超过该值就算在底部(web ChatReading 用 25px)。
export const FOLLOW_THRESHOLD_PX = 24;
/// 读者点了消息区里的东西(展开卡片等)之后这段时间内的尺寸变化归读者,不钉底。
export const INTERACTION_GRACE_MS = 500;

/// 读一个滚动容器的位置与可滚范围,不测量子元素。
export function scrollMetrics(element) {
  const height = element.clientHeight;
  return { top: element.scrollTop, floor: Math.max(0, element.scrollHeight - height) };
}

export function isNearBottom(metrics, threshold = FOLLOW_THRESHOLD_PX) {
  return metrics.floor - metrics.top <= threshold;
}

/// 纯状态:跟随意图 + 上次程序落点。DOM 接线见 mountTailFollow。
export function createTailFollow({ threshold = FOLLOW_THRESHOLD_PX } = {}) {
  let following = true;
  let sampledTop = null;

  /// 程序把视口钉到了底部(top 为实际落点):进入/保持跟随。
  function pinned(top) {
    following = true;
    sampledTop = top;
  }

  /// 一次滚动事件。返回之后的跟随意图。
  function scrolled(metrics) {
    // 自己 pin 的回声(或位置没变):不是读者移动。
    if (sampledTop != null && Math.abs(metrics.top - sampledTop) <= 1) return following;
    const movedUp = sampledTop != null && metrics.top < sampledTop;
    sampledTop = metrics.top;
    if (isNearBottom(metrics, threshold)) {
      // 往下滚进底部阈值、或正好停在底(含内容变短被钳到底)即恢复跟随;
      // 在阈值内往上挪(刚被上滚滚轮释放的那几个像素)不算回到底部。
      if (!movedUp || metrics.floor - metrics.top < 1) following = true;
    } else if (movedUp) {
      // 向上离开底部才放手;向下但还没到底(内容在下面长得比读者滚得快)保持原意图。
      following = false;
    }
    return following;
  }

  /// 读者明确离开当前阅读位置(滚轮上滚、点轮次刻度、分页跳转)。
  function release() {
    following = false;
  }

  /// 换了一份转录(切会话):新内容默认落底并跟随,旧落点作废。
  function reset() {
    following = true;
    sampledTop = null;
  }

  return {
    get isFollowing() { return following; },
    get threshold() { return threshold; },
    pinned, scrolled, release, reset
  };
}

/// 滚轮事件会不会先被消息区里的某个内层滚动块(代码块、长输出)吃掉。
function innerScrollerConsumes(target, root, deltaY) {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  return false;
}

/// 把跟随策略接到消息区:滚动/滚轮/滚动条拖拽、内容与视口尺寸变化、「回到底部」按钮。
/// @param scroller - 消息区滚动容器(#messages)
/// @param options.content - 尺寸变化需要重钉的内容节点(#msg-list 等)
/// @param options.button - 「回到底部」按钮;未跟随且不在底部时显示
/// @param options.onReturn - 读者点了按钮(已落底)之后的回调
export function mountTailFollow(scroller, { content = [], button = null, onReturn, now = () => Date.now() } = {}) {
  const follow = createTailFollow();
  let holding = false;
  let interactedAt = -Infinity;

  function sync() {
    const following = follow.isFollowing;
    // 跟随中关掉浏览器的滚动锚定(web 同款):锚定会在内容变化时自己挪 offset,
    // 那次挪动看起来就像读者上滚。
    scroller.classList.toggle("tail-following", following);
    if (button) button.hidden = following || isNearBottom(scrollMetrics(scroller), follow.threshold);
  }

  /// 钉到底部并跟随。
  function pin() {
    scroller.scrollTop = scroller.scrollHeight;
    follow.pinned(scroller.scrollTop);
    sync();
  }

  /// 跟随中重钉;读者在自由阅读(或正拖着滚动条)时只刷新按钮。
  function autoScroll() {
    if (holding || !follow.isFollowing) {
      sync();
      return;
    }
    pin();
  }

  scroller.addEventListener("scroll", () => {
    follow.scrolled(scrollMetrics(scroller));
    sync();
  }, { passive: true });

  // 向上的滚轮/触控板即读者意图:立刻放手,不等位置越过阈值(否则每一小步都会被下一帧 pin 拽回)。
  scroller.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.deltaY >= 0 || !follow.isFollowing) return;
    if (scroller.scrollTop <= 0) return;
    if (innerScrollerConsumes(event.target, scroller, event.deltaY)) return;
    follow.release();
    sync();
  }, { passive: true });

  // 拖滚动条(指针落在容器自身而非内容上)期间不重钉,松手后按位置裁决。
  scroller.addEventListener("pointerdown", (event) => {
    if (event.target === scroller) holding = true;
    else interactedAt = now();
  });
  scroller.addEventListener("keydown", () => { interactedAt = now(); });
  const endHold = () => {
    if (!holding) return;
    holding = false;
    follow.scrolled(scrollMetrics(scroller));
    autoScroll();
  };
  window.addEventListener("pointerup", endHold);
  window.addEventListener("pointercancel", endHold);

  // 快照之外的尺寸变化(图片/公式异步落地、输入框长高挤小视口):跟随中照样钉底。
  // 刚点过消息区里的东西(展开卡片)造成的增长归读者:不钉,让他看刚展开的内容。
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (follow.isFollowing && !holding && now() - interactedAt < INTERACTION_GRACE_MS
          && !isNearBottom(scrollMetrics(scroller), follow.threshold)) {
        follow.release();
      }
      autoScroll();
    });
    observer.observe(scroller);
    for (const node of content) if (node) observer.observe(node);
  }

  button?.addEventListener("click", () => {
    pin();
    onReturn?.();
  });

  sync();

  return {
    get isFollowing() { return follow.isFollowing; },
    pin,
    autoScroll,
    release() {
      follow.release();
      sync();
    },
    reset() {
      follow.reset();
      sync();
    },
    refresh: sync
  };
}
