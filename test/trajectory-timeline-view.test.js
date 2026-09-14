// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mountTrajectoryTimeline } from "../src/features/trajectory/trajectory-timeline-view.js";

const HTML = `<section id="trajectory-timeline" class="trajectory-timeline">
  <div class="trajectory-timeline-plot">
    <div class="trajectory-timeline-labels" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="trajectory-timeline-track">
      <button class="trajectory-timeline-earlier" type="button" hidden>…</button>
      <div class="trajectory-timeline-lanes"></div>
      <div class="trajectory-timeline-boundaries" aria-hidden="true"></div>
      <div class="trajectory-timeline-selection" hidden aria-hidden="true"></div>
      <div class="trajectory-timeline-tooltip" role="tooltip" hidden></div>
    </div>
  </div>
</section>`;

function record(id, kind, extra = {}) {
  return { id, kind, text: id, ...extra };
}

function turns() {
  return [{
    id: "turn:1", turn: 1,
    groups: [{ id: "g", kind: { type: "step", step: 1 }, records: [
      record("u", "user", { startedAt: 1000, durationSeconds: 1 }),
      record("a", "assistant", { startedAt: 1500, durationSeconds: 2 }),
      record("t", "tool", { startedAt: 2000, durationSeconds: 0.5 })
    ] }]
  }];
}

function mount() {
  document.body.innerHTML = HTML;
  const section = document.querySelector("#trajectory-timeline");
  let more = false;
  let loads = 0;
  const onSelect = vi.fn();
  const view = mountTrajectoryTimeline({
    section,
    hasMore: () => more,
    onLoadEarlier: async () => { loads += 1; more = false; },
    onSelect
  });
  view.render({ turns: turns(), searchMatches: null, selectedId: null });
  return {
    section, view, onSelect,
    setMore: (value) => { more = value; },
    loads: () => loads
  };
}

describe("mountTrajectoryTimeline", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("渲染车道标签与三车道色块", () => {
    const h = mount();
    const labels = [...h.section.querySelectorAll(".trajectory-timeline-labels span")].map((s) => s.textContent);
    expect(labels).toEqual(["输入", "模型", "工具"]);
    const spans = [...h.section.querySelectorAll(".trajectory-timeline-span")];
    expect(spans.map((s) => s.dataset.id)).toEqual(["u", "a", "t"]);
    expect(spans[0].classList.contains("kind-user")).toBe(true);
    expect(spans[0].classList.contains("lane-0")).toBe(true);
    expect(spans[1].classList.contains("lane-1")).toBe(true);
    expect(spans[2].classList.contains("lane-2")).toBe(true);
  });

  it("点击色块回调记录 id", () => {
    const h = mount();
    h.section.querySelector(".trajectory-timeline-span.kind-tool").click();
    expect(h.onSelect).toHaveBeenCalledWith("t");
  });

  it("有更早历史时显示 … 并触发加载", async () => {
    const h = mount();
    const earlier = h.section.querySelector(".trajectory-timeline-earlier");
    expect(earlier.hidden).toBe(true);
    h.setMore(true);
    h.view.render({ turns: turns(), searchMatches: null, selectedId: null });
    expect(earlier.hidden).toBe(false);
    earlier.click();
    await Promise.resolve();
    expect(h.loads()).toBe(1);
  });

  it("搜索不匹配的色块变暗", () => {
    const h = mount();
    h.view.render({ turns: turns(), searchMatches: new Set(["u"]), selectedId: null });
    const tool = h.section.querySelector(".trajectory-timeline-span.kind-tool");
    expect(tool.classList.contains("dimmed")).toBe(true);
  });

  it("切换模式后重新投影(等宽 → 实际时长)", () => {
    const h = mount();
    expect(h.view.getMode()).toBe("sequence");
    expect(h.view.toggleMode()).toBe("duration");
    h.view.render({ turns: turns(), searchMatches: null, selectedId: null });
    const span = h.section.querySelector(".trajectory-timeline-span.kind-user");
    // 序列模式等宽 = 1/3;时长模式按 1000/2500 = 40%。
    expect(span.style.width).toContain("40");
    expect(h.view.modeLabel()).toBe("时长");
  });

  it("选中记录高亮,Esc 清除框选", () => {
    const h = mount();
    h.view.render({ turns: turns(), searchMatches: null, selectedId: "a" });
    expect(h.section.querySelector(".trajectory-timeline-span.kind-assistant").classList.contains("selected")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(h.view.focusedIds()).toBeNull();
  });

  it("没有容器时安全降级", () => {
    const view = mountTrajectoryTimeline({ section: null });
    expect(view.isAvailable()).toBe(false);
    expect(() => view.render()).not.toThrow();
  });
});
