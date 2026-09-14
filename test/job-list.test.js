// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { t } from "../src/shared/i18n.js";
import {
  isLiveJob, jobDotState, jobStatusLabel, formatJobDuration, orderedJobs, jobCountLabel, mountJobList
} from "../src/features/docks/job-list.js";

function job(overrides) {
  return { id: "j", kind: "bash", label: "cmd", status: "running", startedAt: 1000, ...overrides };
}

describe("job-list 纯函数(对齐 web ui-jobs)", () => {
  it("isLive 只看 running/stopping", () => {
    expect(isLiveJob(job({ status: "running" }))).toBe(true);
    expect(isLiveJob(job({ status: "stopping" }))).toBe(true);
    expect(isLiveJob(job({ status: "completed" }))).toBe(false);
    expect(isLiveJob(null)).toBe(false);
  });

  it("状态点语义:stopping/killed 同色", () => {
    expect(jobDotState("running")).toBe("ongoing");
    expect(jobDotState("stopping")).toBe("warning");
    expect(jobDotState("killed")).toBe("warning");
    expect(jobDotState("completed")).toBe("done");
    expect(jobDotState("failed")).toBe("error");
  });

  it("计数:有活动任务只报活动数,否则报总数", () => {
    expect(jobCountLabel([])).toBe(t("jobs.countIdleOther", { n: "0" }));
    expect(jobCountLabel([job({ status: "completed" })])).toBe(t("jobs.countIdleOne", { n: "1" }));
    expect(jobCountLabel([job(), job({ id: "b", status: "completed" })])).toBe(t("jobs.countLiveOne", { n: "1" }));
    expect(jobCountLabel([job(), job({ id: "b", status: "stopping" })])).toBe(t("jobs.countLiveOther", { n: "2" }));
  });

  it("排序:活动在前按开始升序,已结束按结束降序", () => {
    const live2 = job({ id: "live2", startedAt: 200 });
    const live1 = job({ id: "live1", startedAt: 100 });
    const done1 = job({ id: "done1", status: "completed", startedAt: 10, finishedAt: 50 });
    const done2 = job({ id: "done2", status: "completed", startedAt: 20, finishedAt: 90 });
    expect(orderedJobs([done1, live2, done2, live1]).map((item) => item.id))
      .toEqual(["live1", "live2", "done2", "done1"]);
  });

  it("计时至多两级单位", () => {
    expect(formatJobDuration(9_000)).toBe(t("jobs.durationSeconds", { s: "9" }));
    expect(formatJobDuration(62_000)).toBe(t("jobs.durationMinutes", { m: "1", s: "2" }));
    expect(formatJobDuration(3_600_000 + 120_000)).toBe(t("jobs.durationHours", { h: "1", m: "2" }));
    expect(formatJobDuration(-5)).toBe(t("jobs.durationSeconds", { s: "0" }));
  });

  it("状态词对齐 web statusLabel", () => {
    expect(jobStatusLabel("killed")).toBe(t("jobs.killed"));
    expect(jobStatusLabel("failed")).toBe(t("jobs.failed"));
  });
});

describe("mountJobList(header chip + popover)", () => {
  let trigger, menu;

  beforeEach(() => {
    document.body.innerHTML =
      '<button id="jobs-btn" hidden><span class="jobs-dot" hidden></span><span class="jobs-label"></span></button>' +
      '<div id="jobs-menu" popover></div>';
    trigger = document.getElementById("jobs-btn");
    menu = document.getElementById("jobs-menu");
  });

  afterEach(() => {
    document.querySelectorAll("dialog.card-detail").forEach((node) => node.remove());
  });

  it("没有任务时整颗 chip 隐藏、浮层清空", () => {
    const view = mountJobList(trigger, menu);
    view.set([]);
    expect(trigger.hidden).toBe(true);
    expect(menu.children.length).toBe(0);
  });

  it("有任务时报计数;活动任务的点才亮", () => {
    const view = mountJobList(trigger, menu);
    view.set([job({ status: "completed" }), job({ id: "b", status: "running" })]);
    expect(trigger.hidden).toBe(false);
    expect(trigger.querySelector(".jobs-label").textContent).toBe(t("jobs.countLiveOne", { n: "1" }));
    expect(trigger.querySelector(".jobs-dot").hidden).toBe(false);
    expect(menu.querySelectorAll(".jobs-row").length).toBe(2);
    view.set([job({ status: "completed" })]);
    expect(trigger.querySelector(".jobs-dot").hidden).toBe(true);
  });

  it("点击行打开详情弹窗", () => {
    const view = mountJobList(trigger, menu);
    view.set([job({ status: "completed", finishedAt: 5000, detail: "exit code: 0" })]);
    menu.querySelector(".jobs-row").click();
    const dialog = document.querySelector("dialog.card-detail");
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector(".card-detail-title").textContent).toBe("cmd");
    expect(dialog.querySelector(".jobs-detail").textContent).toContain("exit code: 0");
  });
});
