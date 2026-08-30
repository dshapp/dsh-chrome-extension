// 插件卡片的暂存编辑态。三层设置(base/user/value)决定显示什么、是否标记
// "已覆盖"、以及"恢复默认"还原到哪 —— 这里锁死那套折算。
import { describe, it, expect } from "vitest";
import {
  createPluginSettingsState, formatFieldValue, parseFieldValue
} from "../src/features/settings/plugin-settings-state.js";

const FIELDS = { timeoutMs: "number", label: "text" };

function state({ value = {}, base = {}, user = {}, writable = true, revision = 1 } = {}) {
  return createPluginSettingsState({
    namespace: { ns: "shell", revision, value, base, user },
    writable,
    fields: FIELDS
  });
}

describe("字段格式化与解析", () => {
  it("数字与文本各自格式化,类型不符给空串", () => {
    expect(formatFieldValue("number", 60000)).toBe("60000");
    expect(formatFieldValue("text", "x")).toBe("x");
    expect(formatFieldValue("number", "60000")).toBe("");
    expect(formatFieldValue("text", 1)).toBe("");
    expect(formatFieldValue("number", undefined)).toBe("");
  });

  it("空串解析为「清除该键」", () => {
    expect(parseFieldValue("number", "  ")).toEqual({ ok: true, value: null });
  });

  it("非数字文本在 number 字段上非法", () => {
    expect(parseFieldValue("number", "abc")).toEqual({ ok: false, value: null });
    expect(parseFieldValue("number", "12")).toEqual({ ok: true, value: 12 });
  });

  it("文本字段保存时剪掉首尾空白", () => {
    expect(parseFieldValue("text", " x ")).toEqual({ ok: true, value: "x" });
  });
});

describe("初始渲染态", () => {
  it("显示折算值,用户层拥有该键才标记已覆盖", () => {
    const form = state({ value: { timeoutMs: 5000 }, base: { timeoutMs: 1000 }, user: { timeoutMs: 5000 } });
    expect(form.field("timeoutMs")).toEqual({ text: "5000", overridden: true, invalid: false });
  });

  it("只由基线层提供时不算已覆盖", () => {
    const form = state({ value: { timeoutMs: 1000 }, base: { timeoutMs: 1000 }, user: {} });
    expect(form.field("timeoutMs").overridden).toBe(false);
  });

  it("刚打开的卡片不是脏的", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    expect(form.dirty).toBe(false);
    expect(form.mutations).toEqual([]);
  });

  it("未知字段直接抛错,而不是静默返回空", () => {
    expect(() => state().field("nope")).toThrow();
    expect(() => state().edit("nope", "x")).toThrow();
  });
});

describe("暂存编辑", () => {
  it("改成与折算值相同的文本不算改动", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "1000");
    expect(form.dirty).toBe(false);
  });

  it("改成新值产生一条 set op", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "2000");
    expect(form.dirty).toBe(true);
    expect(form.mutations).toEqual([{ op: "set", path: ["timeoutMs"], value: 2000 }]);
  });

  it("清空输入 → unset op", () => {
    const form = state({ value: { timeoutMs: 1000 }, user: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "");
    expect(form.mutations).toEqual([{ op: "unset", path: ["timeoutMs"] }]);
  });

  it("非法值让整张卡片不可保存", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "abc");
    expect(form.invalid).toBe(true);
    expect(form.mutations).toBeNull();
    expect(form.field("timeoutMs").invalid).toBe(true);
  });

  it("多字段编辑按编辑顺序产出 op", () => {
    const form = state({ value: { timeoutMs: 1, label: "a" } });
    form.edit("label", "b");
    form.edit("timeoutMs", "2");
    expect(form.mutations.map((op) => op.path[0])).toEqual(["label", "timeoutMs"]);
  });
});

describe("恢复默认", () => {
  it("显示基线值,并暂存删除用户层该键", () => {
    const form = state({ value: { timeoutMs: 5000 }, base: { timeoutMs: 1000 }, user: { timeoutMs: 5000 } });
    form.reset("timeoutMs");
    expect(form.field("timeoutMs").text).toBe("1000");
    expect(form.mutations).toEqual([{ op: "unset", path: ["timeoutMs"] }]);
  });

  it("用户层本来就没有该键时,重置不产生 op", () => {
    const form = state({ value: { timeoutMs: 1000 }, base: { timeoutMs: 1000 }, user: {} });
    form.reset("timeoutMs");
    expect(form.dirty).toBe(false);
  });
});

describe("放弃更改", () => {
  it("丢掉全部草稿,回到折算值", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "9999");
    form.discard();
    expect(form.dirty).toBe(false);
    expect(form.field("timeoutMs").text).toBe("1000");
  });
});

describe("采纳写回结果(settle)", () => {
  it("落地的字段清掉草稿", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "2000");
    form.settle({ ns: "shell", revision: 2, value: { timeoutMs: 2000 }, base: {}, user: { timeoutMs: 2000 } });
    expect(form.dirty).toBe(false);
    expect(form.namespace.revision).toBe(2);
  });

  it("宿主没接受的改动保留为脏,让用户看到没存上", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "2000");
    // 宿主回了个没变的快照(例如被 schema 夹回原值)。
    form.settle({ ns: "shell", revision: 2, value: { timeoutMs: 1000 }, base: {}, user: {} });
    expect(form.dirty).toBe(true);
  });

  it("unset 落地(用户层已无该键)也清掉草稿", () => {
    const form = state({ value: { timeoutMs: 5000 }, base: { timeoutMs: 1000 }, user: { timeoutMs: 5000 } });
    form.reset("timeoutMs");
    form.settle({ ns: "shell", revision: 2, value: { timeoutMs: 1000 }, base: { timeoutMs: 1000 }, user: {} });
    expect(form.dirty).toBe(false);
  });

  it("非法状态下 settle 不动任何东西", () => {
    const form = state({ value: { timeoutMs: 1000 } });
    form.edit("timeoutMs", "abc");
    form.settle({ ns: "shell", revision: 7, value: {}, base: {}, user: {} });
    expect(form.namespace.revision).toBe(1);
  });
});

describe("只读部署", () => {
  it("writable 透传给渲染层", () => {
    expect(state({ writable: false }).writable).toBe(false);
  });
});
