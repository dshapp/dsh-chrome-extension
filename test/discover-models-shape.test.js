// 对齐 dsh-macapp 9e3f921(获取可用模型不再报格式错误)。
//
// 宿主契约是**裸数组**:
//   @deepseek-ai/dsh-llm/lib/typert.remote-client.d.ts:10,15
//   'llm/discoverModels': (...) => Promise<RemoteResult<LlmDiscoveredModel[]>>
//
// 而两个调用点都按 `value?.models` 取对象:
//   provider-editor-sheet.js:210  const found = value?.models ?? [];
//   custom-provider-sheet.js:218  const ids = (value?.models ?? []).map(...)
//
// 于是 value.models 恒为 undefined → 静默降级成"未发现任何模型"。这比 Mac 更隐蔽:
// Swift 抛 DecodingError 至少会报错,JS 的 ?? [] 让用户完全看不出是解析错了。
//
// 归一化放在 service 出口,两个 UI 调用点因此不必各自判形状;同时兼容对象形状,
// 以防某些部署或将来版本回 { models: [...] }。
import { describe, expect, it, vi } from "vitest";
import { createSettingsService } from "../src/features/settings/settings-service.js";

const model = (id) => ({ id, displayName: id });

function service(response) {
  const call = vi.fn().mockResolvedValue(response);
  return { svc: createSettingsService({ call }), call };
}

describe("llm/discoverModels 回包形状归一化", () => {
  it("裸数组(宿主真实契约)被正确读出", async () => {
    const { svc } = service([model("a"), model("b")]);
    const value = await svc.discoverModels({ settingsNs: "llm", provider: "p" });
    expect(value.models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("兼容 { models: [...] } 对象形状", async () => {
    const { svc } = service({ models: [model("c")] });
    const value = await svc.discoverModels({ settingsNs: "llm", provider: "p" });
    expect(value.models.map((m) => m.id)).toEqual(["c"]);
  });

  it("空数组就是没发现模型,不炸", async () => {
    const { svc } = service([]);
    expect((await svc.discoverModels({ settingsNs: "llm" })).models).toEqual([]);
  });

  it("null/undefined 回包退化为空列表", async () => {
    for (const response of [null, undefined]) {
      const { svc } = service(response);
      expect((await svc.discoverModels({ settingsNs: "llm" })).models).toEqual([]);
    }
  });

  it("既非数组也无 models 字段时退化为空列表,不抛", async () => {
    const { svc } = service({ unexpected: true });
    expect((await svc.discoverModels({ settingsNs: "llm" })).models).toEqual([]);
  });
});
