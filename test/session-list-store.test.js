// 会话列表 store 的行首状态派生:未读完成绿点、失败红点、子代理运行祖先集合。
import { describe, it, expect } from "vitest";
import {
  createSessionListStore, computeRunningSubagentRoots, SessionOrderBy
} from "../src/features/sessions/session-list-store.js";

const s = (sessionId, extra = {}) => ({ sessionId, updatedAt: 1000, running: false, ...extra });

describe("workspace 手动顺序", () => {
  it("选中 workspace 时采用宿主 sessionIds，不读浏览器本地账本", () => {
    const store = createSessionListStore();
    store.attachOrderStore({ sort: () => { throw new Error("不应读取本地账本"); } });
    const rows = [s("a", { updatedAt: 30 }), s("b", { updatedAt: 20 }), s("c", { updatedAt: 10 })];
    expect(store.sortBy(rows, SessionOrderBy.manual, ["c", "a", "b"])
      .map((row) => row.sessionId)).toEqual(["c", "a", "b"]);
  });

  it("权威数组未提到的 cwd 兜底行按最近更新追加", () => {
    const store = createSessionListStore();
    const rows = [s("extra-old", { updatedAt: 1 }), s("b", { updatedAt: 2 }),
      s("extra-new", { updatedAt: 4 }), s("a", { updatedAt: 3 })];
    expect(store.sortBy(rows, SessionOrderBy.manual, ["a", "b"])
      .map((row) => row.sessionId)).toEqual(["a", "b", "extra-new", "extra-old"]);
  });
});

describe("未读完成提醒(绿点)", () => {
  it("首次观察到 idle 的会话不产生未读 —— 冷启动不该一屏全绿", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a"), s("b")]);
    expect(store.isCompleted("a")).toBe(false);
    expect(store.isCompleted("b")).toBe(false);
  });

  it("首次观察到 running 的会话也不产生未读", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    expect(store.isCompleted("a")).toBe(false);
  });

  it("running→idle 的边沿点亮未读", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.setStatus("a", false);
    expect(store.isCompleted("a")).toBe(true);
  });

  it("当前打开的会话跑完不产生未读 —— 用户自己就看见了", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.setSelected("a");
    store.setStatus("a", false);
    expect(store.isCompleted("a")).toBe(false);
  });

  it("重新开跑清除未读", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.setStatus("a", false);
    expect(store.isCompleted("a")).toBe(true);
    store.setStatus("a", true);
    expect(store.isCompleted("a")).toBe(false);
  });

  it("打开会话(setSelected)清除它的未读与失败", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.setStatus("a", false);
    store.setErrored("a", true);
    expect(store.isCompleted("a")).toBe(true);
    expect(store.isErrored("a")).toBe(true);
    store.setSelected("a");
    expect(store.isCompleted("a")).toBe(false);
    expect(store.isErrored("a")).toBe(false);
  });

  it("replaceAll 也能发现离线期间跑完的会话", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.replaceAll([s("a", { running: false })]);
    expect(store.isCompleted("a")).toBe(true);
  });

  it("replaceAll 剪掉已不在名单里的标记,集合不随进程无限增长", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.setStatus("a", false);
    expect(store.isCompleted("a")).toBe(true);
    store.replaceAll([s("b")]);
    expect(store.isCompleted("a")).toBe(false);
  });

  it("局部 upsert 不带 running 时不伪造完成 —— 仍在跑的会话不该亮绿点", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    // host/session-added 与标题投影都是这种只带几个字段的形状。
    store.upsertAndNotify({ sessionId: "a", cwd: "/w" });
    expect(store.isCompleted("a")).toBe(false);
    // 行本身仍然是 running,upsert 不该把它抹成 false。
    expect(store.get()[0].running).toBe(true);
  });

  it("局部 upsert 明确带 running: false 时正常点亮未读", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.upsertAndNotify({ sessionId: "a", running: false });
    expect(store.isCompleted("a")).toBe(true);
  });

  it("remove 清掉该会话的全部行状态", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { running: true })]);
    store.setStatus("a", false);
    store.setErrored("a", true);
    store.remove("a");
    expect(store.isCompleted("a")).toBe(false);
    expect(store.isErrored("a")).toBe(false);
    // previousRunning 也清了:同 id 的会话再出现时按"首次观察"处理,不会凭
    // 一条陈旧的 running 位凭空造出一个未读绿点。
    store.replaceAll([s("a", { running: false })]);
    expect(store.isCompleted("a")).toBe(false);
  });
});

describe("失败未读(红点)", () => {
  it("setErrored 置位与清位", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a")]);
    expect(store.isErrored("a")).toBe(false);
    store.setErrored("a", true);
    expect(store.isErrored("a")).toBe(true);
    store.setErrored("a", false);
    expect(store.isErrored("a")).toBe(false);
  });

  it("当前打开的会话不记失败 —— 错误就摆在他眼前的对话里", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a")]);
    store.setSelected("a");
    store.setErrored("a", true);
    expect(store.isErrored("a")).toBe(false);
  });

  it("订阅者只在集合真的变了时被通知", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a")]);
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.setErrored("a", true);
    expect(calls).toBe(1);
    store.setErrored("a", true);   // 重复置位:不该再通知
    expect(calls).toBe(1);
  });
});

describe("computeRunningSubagentRoots", () => {
  it("正在跑的子代理点亮它的整条祖先链", () => {
    const roots = computeRunningSubagentRoots([
      s("root"),
      s("mid", { origin: "subagent", parentSessionId: "root" }),
      s("leaf", { origin: "subagent", parentSessionId: "mid", running: true })
    ]);
    expect(roots.has("root")).toBe(true);
    expect(roots.has("mid")).toBe(true);
    // 自己在跑不等于自己是"有后裔在跑"的祖先。
    expect(roots.has("leaf")).toBe(false);
  });

  it("idle 的子代理不点亮祖先", () => {
    const roots = computeRunningSubagentRoots([
      s("root"),
      s("child", { origin: "subagent", parentSessionId: "root", running: false })
    ]);
    expect(roots.size).toBe(0);
  });

  it("普通 fork 边不算子代理关系,链条在那里断开", () => {
    const roots = computeRunningSubagentRoots([
      s("root"),
      s("forked", { parentSessionId: "root" }),
      s("child", { origin: "subagent", parentSessionId: "forked", running: true })
    ]);
    expect(roots.has("forked")).toBe(true);
    expect(roots.has("root")).toBe(false);
  });

  it("父子成环时不死循环", () => {
    const roots = computeRunningSubagentRoots([
      s("x", { origin: "subagent", parentSessionId: "y", running: true }),
      s("y", { origin: "subagent", parentSessionId: "x" })
    ]);
    expect(roots.has("y")).toBe(true);
  });

  it("store 上的 isRunningSubagentRoot 与纯函数一致,且缓存随名册失效", () => {
    const store = createSessionListStore();
    store.replaceAll([
      s("root"),
      s("child", { origin: "subagent", parentSessionId: "root", running: true })
    ]);
    expect(store.isRunningSubagentRoot("root")).toBe(true);
    store.setStatus("child", false);
    expect(store.isRunningSubagentRoot("root")).toBe(false);
  });
});

describe("名单剪枝", () => {
  // pruneToRoster 只剪了 previousRunning / completed / errored 三样,漏了
  // awaitingKinds 与 draftSessionIds —— 而 remove() 是把这五样一起清的。
  // 两条移除路径不一致,残留标记会在会话重新出现时升起幽灵徽章。
  it("会话离开名单后,待审批标记要一起剪掉", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a")]);
    store.setAwaitingUser("a", "approval");
    store.replaceAll([s("b")]);
    expect(store.awaitingUser("a")).toBe(null);
  });

  it("会话离开名单后,草稿标记要一起剪掉", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a")]);
    store.setDraft("a", true);
    store.replaceAll([s("b")]);
    expect(store.hasDraft("a")).toBe(false);
  });

  it("会话重新出现时不带着上一次的幽灵徽章", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a")]);
    store.setAwaitingUser("a", "approval");
    store.setDraft("a", true);
    store.replaceAll([s("b")]);
    store.replaceAll([s("a", { updatedAt: 2000 }), s("b")]);
    expect(store.awaitingUser("a")).toBe(null);
    expect(store.hasDraft("a")).toBe(false);
  });

  it("仍在名单里的会话,标记不会被 replaceAll 冲掉", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a")]);
    store.setAwaitingUser("a", "approval");
    store.setDraft("a", true);
    store.replaceAll([s("a", { updatedAt: 2000 }), s("b")]);
    expect(store.awaitingUser("a")).toBe("approval");
    expect(store.hasDraft("a")).toBe(true);
  });
});

describe("列表投影版本", () => {
  it("不同 projection key 独立比较 seq", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { projections: {
      asOfSeq: 10, values: { title: "旧标题", tokenUsage: { outputTokens: 1 } }
    } })]);

    store.setProjection("a", "tokenUsage", { outputTokens: 2 }, 20);
    store.setProjection("a", "title", "新标题", 15);
    store.setProjection("a", "title", "同序重复", 15);
    store.setProjection("a", "title", "迟到旧值", 14);

    expect(store.get()[0].projections).toMatchObject({
      asOfSeq: 20,
      values: { title: "新标题", tokenUsage: { outputTokens: 2 } }
    });
  });

  it("replaceAll 与 remove 会重建或清理逐 key 版本", () => {
    const store = createSessionListStore();
    store.replaceAll([s("a", { projections: { asOfSeq: 8, values: { title: "基线" } } })]);
    store.setProjection("a", "title", "太旧", 7);
    expect(store.get()[0].projections.values.title).toBe("基线");

    store.remove("a");
    store.replaceAll([s("a", { projections: { asOfSeq: 2, values: { title: "重建" } } })]);
    store.setProjection("a", "title", "更新", 3);
    expect(store.get()[0].projections.values.title).toBe("更新");
  });
});
