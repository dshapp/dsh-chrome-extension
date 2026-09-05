// 宿主设置域服务:settings.describe/update/mutate、credentials.*、agentPreset 管理、
// 插件清单、模型发现。对齐 macos/Sources/DSHMacKit/State/ModelProviderSettingsController.swift
// 与 Networking/RPCMethods.swift 的同名调用。
//
// 这一层只做协议搬运与纯计算(路径读写、脏值折算、校验),不碰 DOM —— 设置页的
// 渲染在 src/app/sidepanel/settings/ 下,两边通过这些返回值对接。
import { RPC } from "../../platform/dsh/rpc-methods.js";

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

/// 模型目录逐行校验,返回首个错误 {kind, index}(index 为 0 基)。
export function validateCatalogRows(rows) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const id = String(row.modelId ?? "").trim();
    if (!id) return { kind: "idRequired", index };
    if (seen.has(id)) return { kind: "duplicate", index };
    seen.add(id);
    const name = String(row.name ?? "");
    if (name !== name.trim()) return { kind: "nameInvalid", index };
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
/// 全空且本来就没存过则不产生 op。对齐 Mac modelCatalogOp。
export function modelCatalogOp(rows, settingsPath, savedCatalogPresent) {
  const path = [...settingsPath, "models"];
  const entries = [];
  for (const row of rows) {
    const id = String(row.modelId ?? "").trim();
    if (!id) continue;
    const entry = { id };
    const name = String(row.name ?? "").trim();
    if (name) entry.name = name;
    const context = parseCapacitySpelling(row.contextWindow);
    if (context != null) entry.contextWindow = context;
    const maxTokens = parseCapacitySpelling(row.maxTokens);
    if (maxTokens != null) entry.maxTokens = maxTokens;
    if (row.supportsImage) entry.input = ["text", "image"];
    entries.push(entry);
  }
  if (!entries.length) {
    return savedCatalogPresent ? { op: "unset", path } : null;
  }
  return { op: "set", path, value: entries };
}

/// 编辑器里的行是否与已存目录完全一致 —— 一致则 Save 不该可点。
/// 归一化用户可以随手改而语义不变的部分:首尾空白、容量拼写。
export function modelCatalogMatchesSaved(rows, saved) {
  if (rows.length !== saved.length) return false;
  return rows.every((row, index) => {
    const stored = saved[index];
    return String(row.modelId ?? "").trim() === (stored.modelId ?? "")
      && String(row.name ?? "").trim() === (stored.name ?? "")
      && formatCapacitySpelling(parseCapacitySpelling(row.contextWindow)) === (stored.contextWindow ?? "")
      && formatCapacitySpelling(parseCapacitySpelling(row.maxTokens)) === (stored.maxTokens ?? "")
      && Boolean(row.supportsImage) === Boolean(stored.supportsImage);
  });
}

/// 从已存 profile 还原编辑器行。
export function hydrateCatalogRows(settingsPath, namespaceValue) {
  const profile = jsonValueAt(settingsPath, namespaceValue);
  const models = Array.isArray(profile?.models) ? profile.models : [];
  return models.map((model) => ({
    modelId: String(model?.id ?? ""),
    name: String(model?.name ?? ""),
    contextWindow: formatCapacitySpelling(model?.contextWindow ?? null),
    maxTokens: formatCapacitySpelling(model?.maxTokens ?? null),
    supportsImage: Array.isArray(model?.input) && model.input.includes("image"),
    existing: true
  }));
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
    async discoverModels({ settingsNs, provider, baseURL, api, apiKey }) {
      return connection.call(RPC.llmDiscoverModels, {
        settingsNs,
        request: {
          ...(provider ? { provider } : {}),
          ...(baseURL ? { baseURL } : {}),
          ...(api ? { api } : {}),
          ...(apiKey ? { apiKey } : {})
        }
      });
    },
    /// 只读插件清单。远端端点固定收一个 args 对象。
    async pluginInventory() {
      return connection.call(RPC.pluginInventoryList, {});
    },
    async presetList() {
      return connection.call(RPC.agentPresetList, {});
    },
    async presetRead(agentPreset) {
      return connection.call(RPC.agentPresetRead, { agentPreset });
    },
    async presetCopy(from, agentPreset, name) {
      return connection.call(RPC.agentPresetCopy, { from, id: agentPreset });
    },
    async presetRemove(agentPreset) {
      return connection.call(RPC.agentPresetRemove, { id: agentPreset });
    },
    async presetOpenDocument(agentPreset) {
      return connection.call(RPC.agentPresetOpenDocument, { agentPreset });
    },

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

    /// 保存一次编辑:profile 路径 op 先落,再落至多一次凭证写入 —— 密钥必须
    /// 晚于命名它的 profile,否则一个还没有 apiKeyEnv 的提供方会静默丢钥匙。
    async saveProvider(row, ops, apiKey) {
      const key = String(apiKey ?? "").trim();
      const failure = apiKeyFailure(apiKey);
      if (failure) throw new Error(failure === "blank" ? "keyBlank" : "keyFormat");
      const keyLocked = row.credential?.configured === true && row.credential?.writable === false;
      if (key && keyLocked) throw new Error("keyLocked");
      const settingsOps = [...ops];
      const ref = row.apiKeyEnv ?? deriveKeyRef(row.entry.provider);
      if (key && row.apiKeyEnv == null) {
        settingsOps.push({ op: "set", path: [...row.entry.settingsPath, "apiKeyEnv"], value: ref });
      }
      let view = null;
      if (settingsOps.length) {
        view = await this.mutate(row.entry.settingsNs, settingsOps, row.expectedRevision);
      }
      if (key) await this.setCredential(ref, key);
      return view;
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
