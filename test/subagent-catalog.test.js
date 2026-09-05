import { describe, it, expect, vi } from "vitest";
import {
  createSubagentCatalogState, healthyCount, catalogVisible, catalogTriggerLabel,
  childSecondaryText, diagnosticReasonText, subagentTokenTotal, subagentDurationMs,
  formatSubagentTokens, formatSubagentDuration, formatSubagentExactDuration
} from "../src/features/subagents/subagent-catalog.js";

const T = (key) => key; // 忽略 params 的假 t,断言只关心 key 选择

describe("createSubagentCatalogState", () => {
  it("初始 idle,load 到 ready", async () => {
    const c = createSubagentCatalogState();
    expect(c.stateFor("p").phase).toBe("idle");
    await c.load("p", async () => ({ entries: [], parentAvailable: true }));
    expect(c.stateFor("p").phase).toBe("ready");
  });

  it("loading/ready 默认去重,force 重拉", async () => {
    const c = createSubagentCatalogState();
    const loader = vi.fn().mockResolvedValue({ entries: [], parentAvailable: true });
    await c.load("p", loader);
    await c.load("p", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    await c.load("p", loader, { force: true });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("失败落到 failed,force 重试可恢复", async () => {
    const c = createSubagentCatalogState();
    let fail = true;
    const loader = () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve({ entries: [], parentAvailable: true }));
    await c.load("p", loader);
    expect(c.stateFor("p").phase).toBe("failed");
    expect(c.stateFor("p").error).toBe("boom");
    fail = false;
    await c.load("p", loader, { force: true });
    expect(c.stateFor("p").phase).toBe("ready");
  });

  it("toggle 展开/收起并级联折叠", async () => {
    const c = createSubagentCatalogState();
    await c.load("p", async () => ({ entries: [{ kind: "child", id: "a", mode: "one-shot", activity: "inactive", hasChildren: true, label: "A" }], parentAvailable: true }));
    c.toggle("a", () => {});
    expect(c.expanded.has("a")).toBe(true);
    c.toggle("a", () => {});
    expect(c.expanded.has("a")).toBe(false);
    c.close();
    expect(c.expanded.size).toBe(0);
  });

  it("较早的强制刷新晚返回时不覆盖较新的成功结果", async () => {
    const c = createSubagentCatalogState();
    const pending = [];
    const loader = vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));

    const oldLoad = c.load("p", loader, { force: true });
    const newLoad = c.load("p", loader, { force: true });
    pending[1].resolve({ entries: [{ kind: "child", id: "new" }] });
    await newLoad;
    pending[0].resolve({ entries: [{ kind: "child", id: "old" }] });
    await oldLoad;

    expect(c.stateFor("p").value.entries[0].id).toBe("new");
  });

  it("较早请求的迟到失败不覆盖较新的成功结果", async () => {
    const c = createSubagentCatalogState();
    const pending = [];
    const loader = vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));

    const oldLoad = c.load("p", loader, { force: true });
    const newLoad = c.load("p", loader, { force: true });
    pending[1].resolve({ entries: [] });
    await newLoad;
    pending[0].reject(new Error("stale"));
    await oldLoad;

    expect(c.stateFor("p")).toMatchObject({ phase: "ready", value: { entries: [] }, error: null });
  });
});

describe("healthyCount / catalogVisible / catalogTriggerLabel", () => {
  it("healthyCount 只数 child", () => {
    expect(healthyCount({ entries: [{ kind: "child", id: "a" }, { kind: "diagnostic", id: "d" }] })).toBe(1);
    expect(healthyCount(null)).toBe(0);
  });

  it("catalogVisible:failed 恒可见;ready 靠 entries 或后裔;idle/loading 只看后裔", () => {
    const d0 = { count: 0, runningCount: 0 };
    const d2 = { count: 2, runningCount: 0 };
    expect(catalogVisible({ phase: "failed" }, d0)).toBe(true);
    expect(catalogVisible({ phase: "ready", value: { entries: [] } }, d0)).toBe(false);
    expect(catalogVisible({ phase: "ready", value: { entries: [{ kind: "child" }] } }, d0)).toBe(true);
    expect(catalogVisible({ phase: "idle" }, d0)).toBe(false);
    expect(catalogVisible({ phase: "idle" }, d2)).toBe(true);
  });

  it("触发文案:运行中优先,否则取 healthy 与后裔较大者", () => {
    expect(catalogTriggerLabel({ phase: "idle" }, { count: 3, runningCount: 2 }, T)).toBe("statusSubagentsRunningOther");
    expect(catalogTriggerLabel({ phase: "idle" }, { count: 1, runningCount: 1 }, T)).toBe("statusSubagentsRunningOne");
    expect(catalogTriggerLabel({ phase: "idle" }, { count: 2, runningCount: 0 }, T)).toBe("subagentCatalogCountOther");
    expect(catalogTriggerLabel({ phase: "idle" }, { count: 1, runningCount: 0 }, T)).toBe("subagentCatalogCountOne");
    // ready 目录里 healthy 多于名册后裔时,取 healthy。
    const st = { phase: "ready", value: { entries: [{ kind: "child" }, { kind: "child" }, { kind: "child" }] } };
    expect(catalogTriggerLabel(st, { count: 1, runningCount: 0 }, T)).toBe("subagentCatalogCountOther");
  });
});

describe("行文案与指标", () => {
  it("childSecondaryText 组合 title · mode · activity", () => {
    expect(childSecondaryText("one-shot", "running", "T", T)).toBe("T · subagentModeOneShot · subagentActivityRunning");
    expect(childSecondaryText("continuable", "inactive", null, T)).toBe("subagentModeContinuable · subagentActivityNotRunning");
  });

  it("diagnosticReasonText 映射本地化 key", () => {
    expect(diagnosticReasonText("corrupt", T)).toBe("subagentDiagnosticCorrupt");
    expect(diagnosticReasonText("whatever", T)).toBe("subagentDiagnosticUnavailable");
  });

  it("subagentTokenTotal 四桶相加,缺省 null", () => {
    const summary = { projections: { values: { tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 30 } } } };
    expect(subagentTokenTotal(summary)).toBe(200);
    expect(subagentTokenTotal({})).toBe(null);
  });

  it("subagentDurationMs 结算 settled + active 区间", () => {
    expect(subagentDurationMs({ projections: { values: { subagentTiming: { settledMs: 1000, active: { since: 1000, through: 5000 } } } } })).toBe(5000);
    expect(subagentDurationMs({ projections: { values: { subagentTiming: { settledMs: 2000 } } } })).toBe(2000);
    expect(subagentDurationMs({})).toBe(null);
  });
});

describe("formatSubagentTokens / formatSubagentDuration", () => {
  it("token 分档", () => {
    expect(formatSubagentTokens(0)).toBe("0");
    expect(formatSubagentTokens(123)).toBe("123");
    expect(formatSubagentTokens(13000)).toBe("13K");
    expect(formatSubagentTokens(154000)).toBe("154K");
    expect(formatSubagentTokens(1500000)).toBe("1.5M");
  });

  it("duration 分档", () => {
    expect(formatSubagentDuration(0)).toBe("0s");
    expect(formatSubagentDuration(90000)).toBe("1m 30s");
    expect(formatSubagentDuration(3600000)).toBe("1h 00m 00s");
    expect(formatSubagentDuration(86400000)).toBe("1d");
    expect(formatSubagentDuration(90000000)).toBe("1d 1h");
  });

  it("formatSubagentExactDuration 天级精确到秒", () => {
    expect(formatSubagentExactDuration(90000000)).toBe("1d 01h 00m 00s");
    expect(formatSubagentExactDuration(90000)).toBe("1m 30s");
  });
});
