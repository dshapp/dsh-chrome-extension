// 对齐 dsh-macapp 3a7ee93(Normalize session rename input)。
//
// 重命名的标题两端空白不属于内容:prompt() 返回的 "  新标题  " 会被原样发给宿主,
// 于是侧栏与标题栏显示带空白的标题;而纯空白 "   " 是 truthy,会通过
// `if (name)` 这道唯一的门,把一个视觉上为空的标题写进会话。
//
// 归一化放在 service 的 rename() 入口(而非某个 UI 调用点):它是所有入口的收敛处,
// 将来新增重命名入口也自动受保护。
import { describe, expect, it, vi } from "vitest";
import { createSessionService } from "../src/features/sessions/session-service.js";

function service(renamed = "回包标题") {
  const call = vi.fn().mockResolvedValue({ title: renamed });
  const svc = createSessionService({ call, subscribe: vi.fn(), unsubscribe: vi.fn() });
  return { svc, call };
}

/// rename 之后还会跟一次 session/list(refreshList),所以取的是 session/rename 那一次。
const titleOf = (call) =>
  call.mock.calls.find(([method]) => method === "session/rename")?.[1]?.request?.title;

describe("会话重命名的输入归一化", () => {
  it("裁掉标题两端空白后再发给宿主", async () => {
    const { svc, call } = service();
    await svc.rename("s1", "  新标题  ");
    expect(titleOf(call)).toBe("新标题");
  });

  it("保留标题内部的空格,只裁两端", async () => {
    const { svc, call } = service();
    await svc.rename("s1", "  改 好 的 标题\t");
    expect(titleOf(call)).toBe("改 好 的 标题");
  });

  it("纯空白标题不发请求(裁完为空等于没给标题)", async () => {
    const { svc, call } = service();
    const result = await svc.rename("s1", "   ");
    expect(call).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("全角空格与换行同样算空白", async () => {
    const { svc, call } = service();
    expect(await svc.rename("s1", "\u3000\n ")).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("null/undefined 不炸,也不发请求", async () => {
    const { svc, call } = service();
    expect(await svc.rename("s1", null)).toBeNull();
    expect(await svc.rename("s1", undefined)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("正常标题照常走通,仍以宿主回包为准写回", async () => {
    const { svc, call } = service("宿主定的标题");
    const result = await svc.rename("s1", "我的标题");
    expect(titleOf(call)).toBe("我的标题");
    expect(result).toBe("宿主定的标题");
  });
});
