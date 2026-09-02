// 通知点击交接:通知 id 携带会话 id;worker 与侧栏经 storage.local 交接待打开会话。
import { describe, it, expect, vi } from "vitest";
import {
  notificationIdForSession,
  sessionIdFromNotificationId,
  createPendingSessionOpen
} from "../src/features/notifications/notification-click.js";

const KEY = "dsh_pending_open_session";

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(entries) { Object.assign(data, entries); },
    async remove(keys) { for (const k of keys) delete data[k]; }
  };
}

function fakeOnChanged() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    emit: (changes, areaName = "local") => { for (const fn of [...listeners]) fn(changes, areaName); },
    size: () => listeners.size
  };
}

describe("通知 id ↔ 会话 id", () => {
  it("往返一致,会话 id 可含连字符与数字", () => {
    const id = notificationIdForSession("sess-01-abc", 1736000000000);
    expect(id).toBe("dsh-sess-01-abc-1736000000000");
    expect(sessionIdFromNotificationId(id)).toBe("sess-01-abc");
  });

  it("非本扩展格式的 id 解析为 null", () => {
    expect(sessionIdFromNotificationId("something-else")).toBe(null);
    expect(sessionIdFromNotificationId("dsh--123")).toBe(null);
    expect(sessionIdFromNotificationId(undefined)).toBe(null);
  });
});

describe("pending 会话交接", () => {
  it("set 后 take 领取并清除;二次 take 为空", async () => {
    const storage = fakeStorage();
    const pending = createPendingSessionOpen({ storage, now: () => 1000 });
    await pending.set("s1");
    expect(await pending.take()).toBe("s1");
    expect(storage.data[KEY]).toBeUndefined();
    expect(await pending.take()).toBe(null);
  });

  it("过期条目被丢弃 —— 没人领的残留不该在几小时后跳会话", async () => {
    const storage = fakeStorage();
    let clock = 0;
    const pending = createPendingSessionOpen({ storage, ttlMs: 60_000, now: () => clock });
    await pending.set("s1");
    clock = 60_001;
    expect(await pending.take()).toBe(null);
    // 过期条目同样被清掉,不残留。
    expect(storage.data[KEY]).toBeUndefined();
  });

  it("无 storage(非扩展环境)时静默退化", async () => {
    const pending = createPendingSessionOpen({ storage: null, onChanged: null });
    await pending.set("s1");
    expect(await pending.take()).toBe(null);
    expect(pending.subscribe(() => {})).toBeTypeOf("function");
  });

  it("subscribe:写入触发回调并清除;清除引发的第二次变更不再触发", async () => {
    const storage = fakeStorage();
    const onChanged = fakeOnChanged();
    const pending = createPendingSessionOpen({ storage, onChanged });
    const onOpen = vi.fn();
    pending.subscribe(onOpen);
    onChanged.emit({ [KEY]: { newValue: { sessionId: "s2", at: 1 } } });
    expect(onOpen).toHaveBeenCalledWith("s2");
    // 领取后清除。
    await Promise.resolve();
    expect(storage.data[KEY]).toBeUndefined();
    // remove 引发的变更没有 newValue —— 忽略,不会二次触发。
    onChanged.emit({ [KEY]: { oldValue: { sessionId: "s2", at: 1 } } });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("subscribe 忽略其他 storage 区域与畸形值,退订生效", () => {
    const storage = fakeStorage();
    const onChanged = fakeOnChanged();
    const pending = createPendingSessionOpen({ storage, onChanged });
    const onOpen = vi.fn();
    const unsubscribe = pending.subscribe(onOpen);
    onChanged.emit({ [KEY]: { newValue: { sessionId: "s3", at: 1 } } }, "sync");
    onChanged.emit({ [KEY]: { newValue: { sessionId: 42, at: 1 } } });
    expect(onOpen).not.toHaveBeenCalled();
    unsubscribe();
    expect(onChanged.size()).toBe(0);
    onChanged.emit({ [KEY]: { newValue: { sessionId: "s4", at: 1 } } });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
