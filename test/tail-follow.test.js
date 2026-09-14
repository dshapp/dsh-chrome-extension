import { describe, expect, it } from "vitest";
import { createTailFollow, SCROLL_AWAY_TOLERANCE } from "../src/features/chat/tail-follow.js";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("tail-follow 发送即锁尾", () => {
  it("发送后持续跟随;running 抖动 true→false→true 不释放", () => {
    const f = createTailFollow();
    f.didSubmit();
    f.runningChanged(true);
    f.runningChanged(false); // 抖动
    expect(f.isFollowing).toBe(true);
    f.transcriptChanged(); // 仍在产出内容 → 证伪
    expect(f.isStopPending).toBe(false);
    f.runningChanged(true);
    expect(f.isFollowing).toBe(true);
  });

  it("内容增长只动 floor,不释放跟随", () => {
    const f = createTailFollow();
    f.didSubmit();
    f.runningChanged(true);
    f.beginPin();
    f.viewportChanged(1000);
    f.viewportChanged(1000); // floor 增长,offset 不变
    expect(f.isFollowing).toBe(true);
  });

  it("读者向上滚超过阈值才释放", () => {
    const clock = fakeClock();
    const f = createTailFollow({ now: clock.now });
    f.didSubmit();
    f.runningChanged(true);
    f.beginPin();
    f.viewportChanged(1000);
    clock.advance(200);
    f.viewportChanged(1000 - SCROLL_AWAY_TOLERANCE - 1);
    expect(f.isFollowing).toBe(false);
  });

  it("pin settle 窗口内的向上移动被折扣(滚动回弹)", () => {
    const clock = fakeClock();
    const f = createTailFollow({ now: clock.now });
    f.didSubmit();
    f.beginPin();
    f.viewportChanged(1000);
    clock.advance(50);
    f.viewportChanged(980); // 回弹,仍在窗口内
    expect(f.isFollowing).toBe(true);
    clock.advance(200);
    f.viewportChanged(700); // 窗口过期后的真实上滚
    expect(f.isFollowing).toBe(false);
  });

  it("stop 熬过静默窗口后 confirmStop 释放", () => {
    const f = createTailFollow();
    f.didSubmit();
    f.runningChanged(true);
    f.runningChanged(false);
    expect(f.isStopPending).toBe(true);
    expect(f.confirmStop()).toBe(true);
    expect(f.isFollowing).toBe(false);
  });

  it("release 清空一切;未提交时 running 变化不产生跟随", () => {
    const f = createTailFollow();
    f.runningChanged(true);
    expect(f.isFollowing).toBe(false);
    f.didSubmit();
    f.release();
    expect(f.isFollowing).toBe(false);
    expect(f.isStopPending).toBe(false);
  });
});
