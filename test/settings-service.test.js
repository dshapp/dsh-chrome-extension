// 设置域纯逻辑:路径读写、密钥校验、容量拼写、模型目录 op 与校验、
// 提供方联结。这些是设置页写回宿主前的最后一道判断,错了会静默写坏 settings.yaml。
import { describe, it, expect, vi } from "vitest";
import {
  jsonValueAt, jsonPathExists, deriveKeyRef, apiKeyFailure,
  parseCapacitySpelling, formatCapacitySpelling, validateCatalogRows,
  modelCatalogOp, modelCatalogMatchesSaved, hydrateCatalogRows,
  canDiscoverModels, providerKeyState, addableProviders, createSettingsService,
  autoFetchEndpointKey, shouldAutoFetchModels
} from "../src/features/settings/settings-service.js";

describe("JSON 路径读写", () => {
  const root = { providers: { acme: { baseURL: "u", models: [{ id: "m" }] } } };

  it("按路径逐段取值", () => {
    expect(jsonValueAt(["providers", "acme", "baseURL"], root)).toBe("u");
  });

  it("任一段缺失返回 undefined 而不抛错", () => {
    expect(jsonValueAt(["providers", "nope", "baseURL"], root)).toBeUndefined();
    expect(jsonValueAt(["a", "b"], null)).toBeUndefined();
  });

  it("路径穿过标量时也不抛错", () => {
    expect(jsonValueAt(["providers", "acme", "baseURL", "deeper"], root)).toBeUndefined();
  });

  it("pathExists 区分「存在但为 falsy」与「不存在」", () => {
    expect(jsonPathExists({ a: 0 }, ["a"])).toBe(true);
    expect(jsonPathExists({ a: null }, ["a"])).toBe(true);
    expect(jsonPathExists({}, ["a"])).toBe(false);
  });
});

describe("凭证引用推导", () => {
  it("路由 id 折算成大写下划线的引用名", () => {
    expect(deriveKeyRef("acme-gateway")).toBe("ACME_GATEWAY_API_KEY");
    expect(deriveKeyRef("deepseek.official")).toBe("DEEPSEEK_OFFICIAL_API_KEY");
  });
});

describe("API 密钥校验", () => {
  it("空串表示「不改动」,不是错误", () => {
    expect(apiKeyFailure("")).toBeNull();
    expect(apiKeyFailure(undefined)).toBeNull();
  });

  it("只有空白是错误", () => {
    expect(apiKeyFailure("   ")).toBe("blank");
  });

  it("误把 KEY=value 整行粘进来被拦下", () => {
    expect(apiKeyFailure("OPENAI_API_KEY=sk-abc")).toBe("illegalCharacters");
  });

  it("被引号包住的整串被拦下", () => {
    expect(apiKeyFailure('"sk-abc"')).toBe("illegalCharacters");
    expect(apiKeyFailure("'sk-abc'")).toBe("illegalCharacters");
  });

  it("首尾空白先被剪掉(粘贴时常带尾随换行),不算错误", () => {
    // 与 Mac apiKeyFailure 一致:先 trim 再逐字符检查,所以尾随换行是可救的。
    expect(apiKeyFailure("sk-abc\n")).toBeNull();
    expect(apiKeyFailure("  sk-abc  ")).toBeNull();
  });

  it("串内部的空格与中文引号等非可打印 ASCII 被拦下", () => {
    expect(apiKeyFailure("sk abc")).toBe("illegalCharacters");
    expect(apiKeyFailure("sk-“abc”")).toBe("illegalCharacters");
    expect(apiKeyFailure("sk-a\nb")).toBe("illegalCharacters");
  });

  it("正常密钥通过", () => {
    expect(apiKeyFailure("sk-1a2b3c_-=+/")).toBeNull();
  });
});

describe("容量拼写", () => {
  it("K / M 后缀折算成 token 数", () => {
    expect(parseCapacitySpelling("128K")).toBe(131072);
    expect(parseCapacitySpelling("1M")).toBe(1048576);
    expect(parseCapacitySpelling("8192")).toBe(8192);
    expect(parseCapacitySpelling(" 64k ")).toBe(65536);
  });

  it("无法识别的拼写返回 null", () => {
    expect(parseCapacitySpelling("128KB")).toBeNull();
    expect(parseCapacitySpelling("abc")).toBeNull();
    expect(parseCapacitySpelling("")).toBeNull();
  });

  it("整除才折算回后缀写法", () => {
    expect(formatCapacitySpelling(131072)).toBe("128K");
    expect(formatCapacitySpelling(1048576)).toBe("1M");
    expect(formatCapacitySpelling(1000)).toBe("1000");
    expect(formatCapacitySpelling(null)).toBe("");
  });

  it("拼写往返后语义不变", () => {
    for (const text of ["128K", "1M", "8192"]) {
      expect(parseCapacitySpelling(formatCapacitySpelling(parseCapacitySpelling(text))))
        .toBe(parseCapacitySpelling(text));
    }
  });
});

describe("模型目录校验", () => {
  const row = (over = {}) => ({ modelId: "m", name: "", contextWindow: "", maxTokens: "", ...over });

  it("空目录合法", () => {
    expect(validateCatalogRows([])).toBeNull();
  });

  it("缺模型 ID 报出行号", () => {
    expect(validateCatalogRows([row(), row({ modelId: "" })]))
      .toEqual({ kind: "idRequired", index: 1 });
  });

  it("重复模型 ID 报出后一行", () => {
    expect(validateCatalogRows([row({ modelId: "a" }), row({ modelId: "a" })]))
      .toEqual({ kind: "duplicate", index: 1 });
  });

  it("名称首尾空格被拦下", () => {
    expect(validateCatalogRows([row({ name: " x " })]))
      .toEqual({ kind: "nameInvalid", index: 0 });
  });

  it("容量拼写无法识别被拦下", () => {
    expect(validateCatalogRows([row({ contextWindow: "128KB" })]))
      .toEqual({ kind: "contextInvalid", index: 0 });
    expect(validateCatalogRows([row({ maxTokens: "??" })]))
      .toEqual({ kind: "maxTokensInvalid", index: 0 });
  });
});

describe("模型目录写回 op", () => {
  it("非空目录写成 set,并折算容量与图像输入", () => {
    const op = modelCatalogOp(
      [{ modelId: "m", name: "M", contextWindow: "128K", maxTokens: "8K", supportsImage: true }],
      ["providers", "acme"], false
    );
    expect(op).toEqual({
      op: "set",
      path: ["providers", "acme", "models"],
      value: [{ id: "m", name: "M", contextWindow: 131072, maxTokens: 8192, input: ["text", "image"] }]
    });
  });

  it("空 id 的行被丢弃", () => {
    const op = modelCatalogOp([{ modelId: "  " }, { modelId: "m" }], [], false);
    expect(op.value).toEqual([{ id: "m" }]);
  });

  it("清空目录且原本存过 → unset(回到适配器默认)", () => {
    expect(modelCatalogOp([], ["p"], true)).toEqual({ op: "unset", path: ["p", "models"] });
  });

  it("清空目录且原本没存过 → 不产生 op", () => {
    expect(modelCatalogOp([], ["p"], false)).toBeNull();
  });
});

describe("目录是否与已存一致", () => {
  const saved = [{ modelId: "m", name: "M", contextWindow: "128K", maxTokens: "", supportsImage: false }];

  it("行数不同即不同", () => {
    expect(modelCatalogMatchesSaved([], saved)).toBe(false);
  });

  it("首尾空白与等价容量拼写不算改动", () => {
    expect(modelCatalogMatchesSaved(
      [{ modelId: " m ", name: " M ", contextWindow: "131072", maxTokens: "", supportsImage: false }],
      saved
    )).toBe(true);
  });

  it("图像开关变化算改动", () => {
    expect(modelCatalogMatchesSaved(
      [{ ...saved[0], supportsImage: true }], saved
    )).toBe(false);
  });
});

describe("从已存 profile 还原目录行", () => {
  it("读出 id/名称/容量/图像,并标记为既有行", () => {
    const rows = hydrateCatalogRows(["p"], {
      p: { models: [{ id: "m", name: "M", contextWindow: 131072, input: ["text", "image"] }] }
    });
    expect(rows).toEqual([{
      modelId: "m", name: "M", contextWindow: "128K", maxTokens: "",
      supportsImage: true, existing: true
    }]);
  });

  it("没有 models 时是空表", () => {
    expect(hydrateCatalogRows(["p"], {})).toEqual([]);
  });
});

describe("能否发起模型发现", () => {
  it("刚填了密钥就可以", () => {
    expect(canDiscoverModels("sk-x", null, false)).toBe(true);
  });

  it("该提供方压根不需要密钥也可以", () => {
    expect(canDiscoverModels("", null, false)).toBe(true);
  });

  it("宿主已存密钥可以,没存则不行", () => {
    expect(canDiscoverModels("", "REF", true)).toBe(true);
    expect(canDiscoverModels("", "REF", false)).toBe(false);
  });
});

describe("提供方密钥状态", () => {
  it("已配置 / 无需 / 缺失", () => {
    expect(providerKeyState({ credential: { configured: true }, apiKeyEnv: "R" })).toBe("configured");
    expect(providerKeyState({ credential: null, apiKeyEnv: null })).toBe("notRequired");
    expect(providerKeyState({ credential: null, apiKeyEnv: "R" })).toBe("missing");
    expect(providerKeyState(null)).toBe("missing");
  });
});

describe("可添加的提供方", () => {
  it("排除已配置的,也排除没有设置地址的", () => {
    const rows = [
      { entry: { provider: "a", settingsNs: "ns" }, configured: true },
      { entry: { provider: "b", settingsNs: "ns" }, configured: false },
      { entry: { provider: "c", settingsNs: "" }, configured: false }
    ];
    expect(addableProviders(rows).map((entry) => entry.provider)).toEqual(["b"]);
  });
});

describe("提供方联结(loadProviderRows)", () => {
  function connectionWith({ providers, namespaces, writable = true, credentials }) {
    return {
      call: vi.fn(async (method) => {
        if (method === "llm.providers") return { providers };
        if (method === "settings.describe") return { namespaces, writable, hasDocument: true };
        if (method === "credentials.describe") {
          if (credentials instanceof Error) throw credentials;
          return { credentials };
        }
        throw new Error(`unexpected ${method}`);
      })
    };
  }

  it("用户层自有、基线层没有的 profile 才可删", async () => {
    const service = createSettingsService(connectionWith({
      providers: [
        { provider: "own", settingsNs: "ns", settingsPath: ["providers", "own"] },
        { provider: "shipped", settingsNs: "ns", settingsPath: ["providers", "shipped"] }
      ],
      namespaces: [{
        ns: "ns", revision: 3,
        value: { providers: { own: {}, shipped: {} } },
        user: { providers: { own: {}, shipped: {} } },
        base: { providers: { shipped: {} } }
      }],
      credentials: {}
    }));
    const { rows, writable } = await service.loadProviderRows();
    expect(writable).toBe(true);
    expect(rows.find((row) => row.entry.provider === "own").removable).toBe(true);
    expect(rows.find((row) => row.entry.provider === "shipped").removable).toBe(false);
  });

  it("挂上 apiKeyEnv 对应的凭证", async () => {
    const service = createSettingsService(connectionWith({
      providers: [{ provider: "a", settingsNs: "ns", settingsPath: [] }],
      namespaces: [{ ns: "ns", revision: 1, value: { apiKeyEnv: "REF" } }],
      credentials: { REF: { configured: true, writable: true } }
    }));
    const { rows, credentialError } = await service.loadProviderRows();
    expect(rows[0].apiKeyEnv).toBe("REF");
    expect(rows[0].credential).toEqual({ configured: true, writable: true });
    expect(credentialError).toBeNull();
  });

  it("凭证读失败只记错误,不让整页变成错误页", async () => {
    const service = createSettingsService(connectionWith({
      providers: [{ provider: "a", settingsNs: "ns", settingsPath: [] }],
      namespaces: [{ ns: "ns", revision: 1, value: { apiKeyEnv: "REF" } }],
      credentials: new Error("凭证库不可用")
    }));
    const { rows, credentialError } = await service.loadProviderRows();
    expect(rows).toHaveLength(1);
    expect(credentialError).toBe("凭证库不可用");
  });

  it("命名空间缺席时该提供方算未配置", async () => {
    const service = createSettingsService(connectionWith({
      providers: [{ provider: "a", settingsNs: "missing", settingsPath: [] }],
      namespaces: [],
      credentials: {}
    }));
    const { rows } = await service.loadProviderRows();
    expect(rows[0].configured).toBe(false);
  });
});

describe("保存提供方", () => {
  function service(overrides = {}) {
    const calls = [];
    const connection = {
      call: vi.fn(async (method, payload) => {
        calls.push([method, payload]);
        if (overrides.failOn === method) throw new Error("boom");
        return { ns: payload?.ns, revision: 9 };
      })
    };
    return { instance: createSettingsService(connection), calls };
  }

  it("密钥晚于命名它的 profile 落地,并自动补出 apiKeyEnv", async () => {
    const { instance, calls } = service();
    await instance.saveProvider(
      { entry: { provider: "acme", settingsNs: "ns", settingsPath: ["p"] }, apiKeyEnv: null, credential: null },
      [{ op: "set", path: ["p", "baseURL"], value: "u" }],
      "sk-key"
    );
    expect(calls[0][0]).toBe("settings.mutate");
    expect(calls[0][1].ops).toEqual([
      { op: "set", path: ["p", "baseURL"], value: "u" },
      { op: "set", path: ["p", "apiKeyEnv"], value: "ACME_API_KEY" }
    ]);
    expect(calls[1]).toEqual(["credentials.set", { ref: "ACME_API_KEY", value: "sk-key" }]);
  });

  it("已有 apiKeyEnv 时不重复写引用", async () => {
    const { instance, calls } = service();
    await instance.saveProvider(
      { entry: { provider: "a", settingsNs: "ns", settingsPath: [] }, apiKeyEnv: "REF", credential: null },
      [], "sk-key"
    );
    expect(calls[0]).toEqual(["credentials.set", { ref: "REF", value: "sk-key" }]);
  });

  it("没有 op 也没有密钥时不发任何请求", async () => {
    const { instance, calls } = service();
    await instance.saveProvider(
      { entry: { provider: "a", settingsNs: "ns", settingsPath: [] }, apiKeyEnv: "REF", credential: null },
      [], ""
    );
    expect(calls).toEqual([]);
  });

  it("非法密钥在发请求前就被拒绝", async () => {
    const { instance, calls } = service();
    await expect(instance.saveProvider(
      { entry: { provider: "a", settingsNs: "ns", settingsPath: [] }, apiKeyEnv: null, credential: null },
      [], "   "
    )).rejects.toThrow("keyBlank");
    expect(calls).toEqual([]);
  });

  it("外部托管的凭证拒绝覆写", async () => {
    const { instance } = service();
    await expect(instance.saveProvider(
      {
        entry: { provider: "a", settingsNs: "ns", settingsPath: [] },
        apiKeyEnv: "REF",
        credential: { configured: true, writable: false }
      },
      [], "sk-new"
    )).rejects.toThrow("keyLocked");
  });
});

describe("删除提供方", () => {
  it("本页托管的凭证先删,再 unset profile", async () => {
    const calls = [];
    const instance = createSettingsService({
      call: vi.fn(async (method, payload) => { calls.push([method, payload]); return {}; })
    });
    await instance.removeProvider({
      entry: { provider: "acme", settingsNs: "ns", settingsPath: ["providers", "acme"] },
      removable: true,
      apiKeyEnv: "ACME_API_KEY",
      credential: { configured: true, writable: true }
    });
    expect(calls.map(([method]) => method)).toEqual(["credentials.unset", "settings.mutate"]);
    expect(calls[1][1].ops).toEqual([{ op: "unset", path: ["providers", "acme"] }]);
  });

  it("凭证由别处托管时保留凭证", async () => {
    const calls = [];
    const instance = createSettingsService({
      call: vi.fn(async (method) => { calls.push(method); return {}; })
    });
    await instance.removeProvider({
      entry: { provider: "acme", settingsNs: "ns", settingsPath: ["p"] },
      removable: true,
      apiKeyEnv: "SHARED_KEY",
      credential: { configured: true, writable: true }
    });
    expect(calls).toEqual(["settings.mutate"]);
  });

  it("不可删的行直接跳过", async () => {
    const call = vi.fn();
    await createSettingsService({ call }).removeProvider({
      entry: { provider: "a", settingsNs: "ns", settingsPath: ["p"] }, removable: false
    });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("自动拉取模型列表的判定", () => {
  const base = { baseURL: "https://gw/v1", apiKey: "sk-1", fetchedFrom: null, locked: false };

  it("地址或密钥缺一就不拉 —— 半填状态不该打网关", () => {
    expect(shouldAutoFetchModels({ ...base, baseURL: "" })).toBe(false);
    expect(shouldAutoFetchModels({ ...base, apiKey: "" })).toBe(false);
    expect(shouldAutoFetchModels({ ...base, baseURL: "   " })).toBe(false);
  });

  it("两者齐了就拉", () => {
    expect(shouldAutoFetchModels(base)).toBe(true);
  });

  it("同一 endpoint 已试过就不再自动重试(密钥打错也不循环打网关)", () => {
    const fetchedFrom = autoFetchEndpointKey(base.baseURL, base.apiKey);
    expect(shouldAutoFetchModels({ ...base, fetchedFrom })).toBe(false);
  });

  it("改地址或改密钥都重新触发", () => {
    const fetchedFrom = autoFetchEndpointKey(base.baseURL, base.apiKey);
    expect(shouldAutoFetchModels({ ...base, fetchedFrom, baseURL: "https://other/v1" })).toBe(true);
    expect(shouldAutoFetchModels({ ...base, fetchedFrom, apiKey: "sk-2" })).toBe(true);
  });

  it("profile 已落盘后不再自动拉", () => {
    expect(shouldAutoFetchModels({ ...base, locked: true })).toBe(false);
  });

  it("地址 trim 而密钥不 trim —— 尾随空格不是另一个网关,token 里的空白可能有意义", () => {
    expect(autoFetchEndpointKey(" https://gw/v1 ", "sk-1")).toBe(autoFetchEndpointKey("https://gw/v1", "sk-1"));
    expect(autoFetchEndpointKey("https://gw/v1", "sk-1 ")).not.toBe(autoFetchEndpointKey("https://gw/v1", "sk-1"));
  });

  it("地址与密钥的边界不会互相吞并", () => {
    // "https://a/b"+"c" 与 "https://a"+"/bc" 拼起来一样,必须用分隔符区分。
    expect(autoFetchEndpointKey("https://a/b", "c")).not.toBe(autoFetchEndpointKey("https://a", "/bc"));
  });
});

describe("插件清单调用约定", () => {
  it("空参也要包一层 args", async () => {
    const call = vi.fn().mockResolvedValue({ entries: [] });
    await createSettingsService({ call }).pluginInventory();
    expect(call).toHaveBeenCalledWith("pluginInventory/list", { args: {} });
  });
});
