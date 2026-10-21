// 侧栏侧:把 service worker 记的任务未读(storage.local 的 TASK_UNREAD_KEY)镜像到会话列表,
// 行上的绿 / 红点与工具栏圆点读的是同一份数据。只读,写入只有 SW 一家(见 task-unread.js)。
import { TASK_UNREAD_KEY } from "./task-unread.js";
import { unreadBySession } from "./unread-policy.js";

export function createTaskUnreadMirror({
  storage = globalThis.chrome?.storage?.local,
  onChanged = globalThis.chrome?.storage?.onChanged,
  apply
} = {}) {
  function push(value) {
    apply?.(unreadBySession(value?.unread ?? {}));
  }
  return Object.freeze({
    start() {
      if (!storage?.get) return () => {};
      const listener = (changes, areaName) => {
        if (areaName !== "local" || !changes?.[TASK_UNREAD_KEY]) return;
        push(changes[TASK_UNREAD_KEY].newValue);
      };
      onChanged?.addListener?.(listener);
      Promise.resolve(storage.get([TASK_UNREAD_KEY]))
        .then((got) => push(got?.[TASK_UNREAD_KEY]))
        .catch(() => {});
      return () => onChanged?.removeListener?.(listener);
    }
  });
}
