// 宿主设置域服务:settings.describe/update/mutate、credentials.*、agentPreset 管理、
// 插件清单、模型发现。对齐 macos/Sources/DSHMacKit/State/ModelProviderSettingsController.swift
// 与 Networking/RPCMethods.swift 的同名调用。
//
// 这一层只做协议搬运与纯计算(路径读写、脏值折算、校验),不碰 DOM —— 设置页的
// 渲染在 src/app/sidepanel/settings/ 下,两边通过这些返回值对接。
import { RPC } from "../../platform/dsh/rpc-methods.js";
import { createPluginManagerService } from "./plugin-manager-service.js";
import { createPresetService } from "./preset-service.js";

/// 取嵌套值;任一段缺失即 undefined。对齐 Swift jsonValue(at:in:)。
export function jsonValueAt(path, root) {
  let cursor = root;
  for (const segment of path ?? []) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/// 某一设置层是否在该精确路径上拥有值。对齐 Swift jsonPathExists。
export function jsonPathExists(root, path) {
  return jsonValueAt(path, root) !== undefined;
}

/// 两个草稿对象之间的最小 set/unset 路径操作(对齐 web ProviderEditor.pathOps):
/// 只命名 after 里出现过的键,值相同的键不发 op,消失的键发 unset。
/// basePath 是这段子树在命名空间里的设置路径。
export function profilePathOps(basePath, before, after) {
  const isPlainObject = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const previous = isPlainObject(before) ? before : {};
  const next = isPlainObject(after) ? after : {};
  const ops = [];
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue;
    ops.push({ op: "set", path: [...basePath, key], value });
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) ops.push({ op: "unset", path: [...basePath, key] });
  }
  return ops;
}

/// 由 provider 路由 id 推导凭证引用名。对齐 Mac deriveKeyRef。
export function deriveKeyRef(provider) {
  return `${String(provider ?? "").replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

/// API 密钥格式校验。返回 null 表示可用,否则返回失败原因。
/// 对齐 Mac apiKeyFailure:空串视为"不改动"而非错误。
export function apiKeyFailure(draft) {
  if (!draft) return null;
  const value = String(draft).trim();
  if (!value) return "blank";
  // 用户误把 "KEY=value" 整行粘进来。
  if (/^[A-Z][A-Z0-9_]*=[^=]/.test(value)) return "illegalCharacters";
  const first = value[0];
  if ((first === '"' || first === "'" || first === "`") && value.length > 1 && value.at(-1) === first) {
    return "illegalCharacters";
  }
  // 密钥必须是可打印 ASCII:中文引号、零宽字符、换行都是粘贴事故。
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x21 || code > 0x7e) return "illegalCharacters";
  }
  return null;
}

/// "128K" / "1M" / "8192" → token 数;无法识别返回 null。
/// DSH 0.1.2 的模型设置契约使用十进制后缀：1K=1000、1M=1000000。
export function parseCapacitySpelling(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(trimmed);
  if (!match) return null;
  const scale = match[2].toLowerCase() === "k" ? 1_000 : match[2].toLowerCase() === "m" ? 1_000_000 : 1;
  const value = Number(match[1]) * scale;
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-6 ? rounded : value;
}

/// token 数 → 最短十进制后缀拼写（"128000" → "128K"）。整除才折算。
export function formatCapacitySpelling(tokens) {
  if (tokens == null) return "";
  if (!Number.isInteger(tokens) || tokens <= 0) return String(tokens);
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

/// 把一条已存模型对象摊成编辑器行。原始对象存在 raw 里,编辑器只拥有
/// id / 名称 / 两个容量字段,其余(description、compat、inputModalities、
/// reasoning 等)原样带着走 —— 整表重写时不能把它们丢掉。对齐 web 的
/// DeepSeekModelDraft 与 ModelListEditor。
export function catalogRowFromModel(model) {
  const raw = typeof model === "object" && model !== null && !Array.isArray(model) ? model : {};
  return {
    raw: { ...raw },
    modelId: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    contextWindow: formatCapacitySpelling(typeof raw.contextWindow === "number" ? raw.contextWindow : null),
    maxTokens: formatCapacitySpelling(typeof raw.maxTokens === "number" ? raw.maxTokens : null)
  };
}

/// 一组已存模型 → 编辑器行。
export function catalogRowsFromModels(models) {
  return (Array.isArray(models) ? models : []).map(catalogRowFromModel);
}

/// 从 profile 的 models 数组还原编辑器行。
export function hydrateCatalogRows(settingsPath, namespaceValue) {
  const profile = jsonValueAt(settingsPath, namespaceValue);
  return catalogRowsFromModels(profile?.models);
}

/// 一行草稿折回模型对象:清空的字段要真正离开对象(交回适配器默认),
/// 其余未知字段从 raw 原样保留。
export function catalogRowToModel(row) {
  const entry = { ...(row.raw ?? {}) };
  // 就地赋值而不是先删后加:已有的键保持原来的位置,键序不变 —— 否则
  // 一行没动过的目录在 JSON.stringify 比较里也会显得"脏了"。
  const apply = (key, value) => {
    if (value === undefined || value === null || value === "") delete entry[key];
    else entry[key] = value;
  };
  apply("id", String(row.modelId ?? "").trim());
  apply("name", String(row.name ?? "").trim());
  const context = parseCapacitySpelling(row.contextWindow);
  apply("contextWindow", context != null ? context : undefined);
  const maxTokens = parseCapacitySpelling(row.maxTokens);
  apply("maxTokens", maxTokens != null ? maxTokens : undefined);
  return entry;
}

/// 模型目录逐行校验,返回首个错误 {kind, index}(index 为 0 基)。
export function validateCatalogRows(rows) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const id = String(row.modelId ?? "").trim();
    if (!id) return { kind: "idRequired", index };
    if (seen.has(id)) return { kind: "duplicate", index };
    seen.add(id);
    const contextWindow = parseCapacitySpelling(row.contextWindow);
    if (String(row.contextWindow ?? "").trim()
      && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
      return { kind: "contextInvalid", index };
    }
    const maxTokens = parseCapacitySpelling(row.maxTokens);
    if (String(row.maxTokens ?? "").trim()
      && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      return { kind: "maxTokensInvalid", index };
    }
  }
  return null;
}

/// 模型目录写回 op;rows 全空且已存目录时是 unset(回到适配器自带列表),
/// 全空且本来就没存过则不产生 op。
export function modelCatalogOp(rows, settingsPath, savedCatalogPresent) {
  const path = [...settingsPath, "models"];
  const entries = [];
  for (const row of rows) {
    if (!String(row.modelId ?? "").trim()) continue;
    entries.push(catalogRowToModel(row));
  }
  if (!entries.length) {
    return savedCatalogPresent ? { op: "unset", path } : null;
  }
  return { op: "set", path, value: entries };
}

/// 容量文本的等价归一(空值 / 无法识别都算空),用于脏值比较。
function normalizedCapacityText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  return formatCapacitySpelling(parseCapacitySpelling(trimmed));
}

/// 编辑器里的行是否与已存目录完全一致 —— 一致则 Save 不该可点。
/// 只比编辑器真正拥有的字段;raw 里的未知字段不参与比较。
export function modelCatalogMatchesSaved(rows, saved) {
  if (rows.length !== saved.length) return false;
  return rows.every((row, index) => {
    const stored = saved[index];
    return String(row.modelId ?? "").trim() === String(stored.modelId ?? "").trim()
      && String(row.name ?? "").trim() === String(stored.name ?? "").trim()
      && normalizedCapacityText(row.contextWindow) === normalizedCapacityText(stored.contextWindow)
      && normalizedCapacityText(row.maxTokens) === normalizedCapacityText(stored.maxTokens);
  });
}

/// 「获取可用模型」是否有钥匙可用:编辑器里刚填的、该提供方压根不需要、
/// 或宿主已存过一个。只看输入框会把每个"已存密钥"的提供方都锁死。
export function canDiscoverModels(apiKeyDraft, apiKeyEnv, credentialConfigured) {
  if (apiKeyDraft) return true;
  if (apiKeyEnv == null) return true;
  return Boolean(credentialConfigured);
}

/// 自动拉取模型列表的判定。对齐 Mac CustomProviderAutoFetch。
///
/// 地址做 trim(尾随空格不是另一个网关),密钥不做(token 里的空白可能有意义)。
/// 两者用 NUL 拼接,否则 "https://a/b"+"c" 与 "https://a"+"/bc" 会撞成同一个 key。
export function autoFetchEndpointKey(baseURL, apiKey) {
  return `${String(baseURL ?? "").trim()}\u0000${String(apiKey ?? "")}`;
}

/// 是否该为这组「地址+密钥」发起一次自动拉取。
/// fetchedFrom 记录上一次已尝试覆盖的 endpoint —— 无论成功失败都不重试同一组,
/// 避免密钥打错时变成循环重试;显式的手动拉取按钮才是重试入口。
export function shouldAutoFetchModels({ baseURL, apiKey, fetchedFrom, locked }) {
  if (locked) return false;
  if (!String(baseURL ?? "").trim()) return false;
  if (!String(apiKey ?? "")) return false;
  return autoFetchEndpointKey(baseURL, apiKey) !== fetchedFrom;
}

/// 一条 provider 行的密钥状态,用于行副标题。
export function providerKeyState(row) {
  if (!row) return "missing";
  if (row.credential?.configured === true) return "configured";
  return row.apiKeyEnv == null ? "notRequired" : "missing";
}

/// 添加提供方候选:未配置且适配器仍知道它的设置地址。对齐 Mac addableProviders。
export function addableProviders(rows) {
  const configured = new Set(rows.filter((row) => row.configured).map((row) => row.entry.provider));
  return rows
    .filter((row) => !configured.has(row.entry.provider) && row.entry.settingsNs)
    .map((row) => row.entry);
}

export function createSettingsService(connection) {
  // 同一 settings service 被多个 pane 共享；并发 describe/mutate 的回包可能乱序。
  // 按宿主 revision 留住每个 namespace 的最新视图，旧回包只能返回较新缓存。
  const newestNamespaces = new Map();
  function rememberNamespace(view) {
    if (!view?.ns) return view;
    const current = newestNamespaces.get(view.ns);
    if (!current || (view.revision ?? -1) >= (current.revision ?? -1)) {
      newestNamespaces.set(view.ns, view);
      return view;
    }
    return current;
  }

  async function providers() {
    const [configurable, routed] = await Promise.all([
      connection.call(RPC.llmConfigurableProviders, {}),
      connection.call(RPC.llmProviders, {})
    ]);
    const active = new Set((Array.isArray(routed) ? routed : routed?.providers ?? []).map((item) => item.id ?? item.provider));
    const rows = (Array.isArray(configurable) ? configurable : configurable?.providers ?? [])
      .map((entry) => ({ ...entry, active: active.has(entry.provider), routable: active.has(entry.provider) }));
    return { providers: rows };
  }
  return {
    /// {namespaces:[{ns, revision, schema, value, base, user}], writable, hasDocument}
    async describe() {
      const value = await connection.call(RPC.settingsDescribe, {});
      return { ...value, namespaces: (value?.namespaces ?? []).map(rememberNamespace) };
    },
    /// 整段 patch 写入(键是相对 ns 的路径,用 "/" 分隔)。
    async update(ns, patch, expectedRevision) {
      const value = await connection.call(RPC.settingsUpdate, {
        ns, patch, ...(expectedRevision == null ? {} : { expectedRevision })
      });
      return rememberNamespace(value);
    },
    /// 有序路径 op 写入。
    async mutate(ns, ops, expectedRevision) {
      const value = await connection.call(RPC.settingsMutate, {
        ns, ops, ...(expectedRevision == null ? {} : { expectedRevision })
      });
      return rememberNamespace(value);
    },
    async openDocument() {
      return connection.call(RPC.settingsOpenDocument, {});
    },
    async describeCredentials(refs) {
      if (!refs?.length) return {};
      const value = await connection.call(RPC.credentialsDescribe, { refs });
      return value ?? {};
    },
    async setCredential(ref, value) {
      return connection.call(RPC.credentialsSet, { ref, value });
    },
    async unsetCredential(ref) {
      return connection.call(RPC.credentialsUnset, { ref });
    },
    async providers() {
      return providers();
    },
    /// 发现某个 provider 可用的模型。
    ///
    /// 宿主契约是**裸数组**(dsh-llm 的 typert.remote-client.d.ts:
    /// 'llm/discoverModels' => Promise<RemoteResult<LlmDiscoveredModel[]>>),
    /// 但调用方按 { models: [...] } 读更自然。在出口归一化一次:两个 UI 调用点
    /// 因此不必各自判形状,也不会因为读错字段而静默降级成"未发现任何模型" ——
    /// 那种失败不抛错、不提示,是最难排查的一类(Mac 侧至少会抛解码错误)。
    /// 同时兼容对象形状,以防某些部署或将来版本改为包一层。
    async discoverModels({ settingsNs, provider, baseURL, api, apiKey }) {
      const value = await connection.call(RPC.llmDiscoverModels, {
        settingsNs,
        request: {
          ...(provider ? { provider } : {}),
          ...(baseURL ? { baseURL } : {}),
          ...(api ? { api } : {}),
          ...(apiKey ? { apiKey } : {})
        }
      });
      const models = Array.isArray(value) ? value
        : Array.isArray(value?.models) ? value.models
        : [];
      return { models };
    },
    /// 只读插件清单。远端端点固定收一个 args 对象。
    async pluginInventory() {
      return connection.call(RPC.pluginInventoryList, {});
    },

    // ---- 插件市场(pluginManager/*)。实现在 plugin-manager-service.js。 ----
    ...createPluginManagerService(connection),
    // ---- Agent preset(agentPreset/*)。实现在 preset-service.js。 ----
    ...createPresetService(connection),

    /// provider × settings 命名空间的联结,等价于 Mac ModelProviderSettingsController.load。
    /// 凭证是"增强信息":读失败不该让整页变成错误页,只记 credentialError。
    async loadProviderRows() {
      const [providerResult, settingsResult] = await Promise.all([
        providers(),
        connection.call(RPC.settingsDescribe, {})
      ]);
      const namespaces = new Map(
        (settingsResult?.namespaces ?? []).map((namespace) => [namespace.ns, namespace])
      );
      const rows = (providerResult?.providers ?? []).map((entry) => {
        const namespace = namespaces.get(entry.settingsNs);
        const path = entry.settingsPath ?? [];
        const profile = jsonValueAt(path, namespace?.value);
        return {
          entry,
          configured: Boolean(namespace) && (!path.length || jsonPathExists(namespace?.value, path)),
          // 只有用户层自己写下、且适配器基线层没有的 profile 才可删。
          removable: Boolean(path.length)
            && jsonPathExists(namespace?.user, path)
            && !jsonPathExists(namespace?.base, path),
          apiKeyEnv: typeof profile?.apiKeyEnv === "string" ? profile.apiKeyEnv : null,
          credential: null
        };
      });
      let credentialError = null;
      const refs = [...new Set(rows.map((row) => row.apiKeyEnv).filter(Boolean))].sort();
      if (refs.length) {
        try {
          const value = await connection.call(RPC.credentialsDescribe, { refs });
          const credentials = value ?? {};
          for (const row of rows) {
            if (row.apiKeyEnv) row.credential = credentials[row.apiKeyEnv] ?? null;
          }
        } catch (error) {
          credentialError = error?.message ?? String(error);
        }
      }
      return {
        rows,
        namespaces,
        writable: settingsResult?.writable === true,
        hasDocument: settingsResult?.hasDocument === true,
        credentialError
      };
    },

    /// 删除用户自有 profile:凭证先走,两步都幂等。
    async removeProvider(row) {
      if (!row.removable) return;
      const derived = deriveKeyRef(row.entry.provider);
      const managed = row.apiKeyEnv === derived
        && row.credential?.configured === true
        && row.credential?.writable === true;
      if (managed) await this.unsetCredential(derived);
      await this.mutate(
        row.entry.settingsNs,
        [{ op: "unset", path: row.entry.settingsPath }],
        row.expectedRevision
      );
    }
  };
}
