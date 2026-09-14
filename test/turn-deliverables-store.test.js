import { describe, it, expect } from "vitest";
import { createSessionStore } from "../src/features/sessions/session-store.js";

let seq = 0;
function ev(type, data) { return { type, seq: seq++, time: 1000 + seq, data }; }
function fresh() { seq = 0; const s = createSessionStore(); s.reset("s1"); return s; }

// 对齐 dsh-macapp e52c8ca / 5af61e6:产出词表按工具调用参数解析,present 声明独立耐久。
describe("本轮产出词表与 present 交付", () => {
  it("write 工具的 settled 结果按参数解析进 producedPathsByTurn", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("tool/call", { callId: "c1", name: "write", arguments: JSON.stringify({ content: "x", file_path: "out/a.txt" }), turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { callId: "c1", isError: false, content: [] }));
    const snap = s.getSnapshot();
    expect(snap.producedPathsByTurn.get(1)).toEqual(["out/a.txt"]);
    expect(s.producedPaths(1)).toEqual(["out/a.txt"]);
  });

  it("失败的 result 与 parentCallId!=nil 的子调用不贡献", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("tool/call", { callId: "c1", name: "edit", arguments: JSON.stringify({ old_string: "a", new_string: "b", file_path: "a.txt" }), turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { callId: "c1", isError: true, content: [] }));
    const snap = s.getSnapshot();
    expect(snap.producedPathsByTurn.get(1)).toBeUndefined();
  });

  it("同一路径去重,首见顺序稳定", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("tool/call", { callId: "c1", name: "write", arguments: JSON.stringify({ content: "1", file_path: "a.txt" }), turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { callId: "c1", isError: false, content: [] }));
    s.applyEvent(ev("tool/call", { callId: "c2", name: "write", arguments: JSON.stringify({ content: "2", file_path: "b.txt" }), turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { callId: "c2", isError: false, content: [] }));
    s.applyEvent(ev("tool/call", { callId: "c3", name: "write", arguments: JSON.stringify({ content: "3", file_path: "a.txt" }), turn: 1, step: 0 }));
    s.applyEvent(ev("tool/result", { callId: "c3", isError: false, content: [] }));
    expect(s.getSnapshot().producedPathsByTurn.get(1)).toEqual(["a.txt", "b.txt"]);
  });

  it("deliverables/presented 折叠进 presentedByTurn 并递增 revision", () => {
    const s = fresh();
    s.applyEvent(ev("turn/start", { turn: 1 }));
    s.applyEvent(ev("deliverables/presented", { turn: 1, files: [{ path: "a.txt", description: "d" }] }));
    const snap = s.getSnapshot();
    expect(snap.presentedByTurn.get(1)[0]).toMatchObject({ path: "a.txt", description: "d" });
    expect(s.producedPaths(1)).toEqual([]);
    const rev = snap.deliverablesRevision;
    expect(rev).toBeGreaterThan(0);
    s.applyEvent(ev("deliverables/presented", { turn: 1, files: [{ path: "b.md" }] }));
    expect(s.getSnapshot().deliverablesRevision).toBeGreaterThan(rev);
    expect(s.presentedFiles(1).map((f) => f.path)).toEqual(["a.txt", "b.md"]);
  });
});
