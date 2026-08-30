// 自定义提供方弹窗。对齐 macos/.../Settings/SettingsRoot.swift CustomProviderSheet。
//
// 字段分组照 Mac 侧调整后的顺序:标识(路由/显示名)→ 连接(地址 → 密钥 → 协议)
// → 模型(模型 ID / 拉取列表)。密钥挨着地址,是因为这两个字段就是自动拉取等的
// 那一对;协议有可用默认值,放最后作为可选调整。
import { t } from "../../../shared/i18n.js";
import {
  section, stackedRow, select, textInput, button, notice, escapeHtml
} from "./settings-ui.js";
import { deriveKeyRef, autoFetchEndpointKey, shouldAutoFetchModels } from "../../../features/settings/settings-service.js";

const ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/// 地址或密钥改动后,等这么久没有新输入才真正发请求。两个字段都是逐字符
/// 输入/粘贴的,不防抖就是每敲一个字符打一次网关。
const AUTO_FETCH_DELAY_MS = 600;

/// 从 schema 里取自定义提供方支持的 api 协议列表。宿主用 ref 图表达联合类型,
/// 所以走一遍 refs 找 const 字面量。
export function protocolChoices(schema) {
  const refs = schema?.refs;
  if (!refs || typeof refs !== "object") return [];
  const values = new Set();
  for (const node of Object.values(refs)) {
    if (node?.type === "const" && typeof node.value === "string") values.add(node.value);
  }
  // const 池里混着 provider 名等其它字面量,挑出常见协议名。
  return [...values].filter((value) => /^(openai|anthropic|google|bedrock|azure)/i.test(value));
}

export function openCustomProvider({ state, sheet, deps, settingsService, translateSaveError, onDone }) {
  const protocols = protocolChoices(state?.namespaces.get("llm-pi-ai")?.schema);
  const draft = {
    routeId: "", displayName: "", baseURL: "", modelId: "", apiKey: "",
    api: protocols[0] ?? ""
  };
  let saving = false;
  let profileCommitted = false;
  let message = null;
  // 拉取到的模型列表。非空时模型 ID 只以下拉框出现 —— 文本框是「网关不支持列
  // 目录」时的手动兜底,两者同时在场会变成两个绑定同一个值的「模型 ID」字段。
  let discoveredModels = [];
  let discovery = null;
  let fetching = false;
  /// 已尝试过的 endpoint(地址+密钥)。在 await 之前就写入,所以失败也不会
  /// 自动重试同一组,避免密钥打错时循环打网关。
  let fetchedFrom = null;
  let autoFetchTimer = null;

  const routeValid = () => ROUTE_ID_PATTERN.test(draft.routeId);
  const canSave = () => (profileCommitted
    ? Boolean(draft.apiKey) && !saving
    : routeValid() && Boolean(draft.baseURL) && Boolean(draft.modelId) && Boolean(draft.api) && !saving);
  const canFetch = () => Boolean(String(draft.baseURL).trim()) && Boolean(draft.apiKey) && !fetching;

  function modelsBody() {
    // 拉到列表后只留下拉框;拉取按钮也一并收起 —— 已经有列表了,重拉的入口
    // 是改地址或密钥。
    if (discoveredModels.length) {
      return stackedRow({
        label: escapeHtml(t("custom.modelPick")),
        control: select({
          id: "cst-model-pick",
          options: discoveredModels.map((id) => ({ value: id, label: id, selected: id === draft.modelId })),
          disabled: profileCommitted
        })
      }) + (discovery ? `<div class="set-row-hint">${escapeHtml(discovery)}</div>` : "");
    }
    return stackedRow({
      label: escapeHtml(t("custom.modelId")),
      control: textInput({ id: "cst-model", value: draft.modelId, placeholder: "gpt-4o-mini", mono: true, disabled: profileCommitted })
    })
    + `<div class="cat-actions">`
    + button({
      id: "cst-fetch",
      label: fetching ? t("custom.fetching") : t("custom.fetchModels"),
      title: canFetch() ? t("cat.fetchHelp") : t("custom.fetchNeedsInput"),
      disabled: !canFetch() || profileCommitted
    })
    + `</div>`
    + (discovery ? `<div class="set-row-hint">${escapeHtml(discovery)}</div>` : "");
  }

  function body() {
    return `<p class="set-sheet-text">${escapeHtml(t("custom.intro"))}</p>`
      + section({
        header: t("custom.identitySection"),
        body: stackedRow({
          label: escapeHtml(t("custom.route")),
          control: textInput({ id: "cst-route", value: draft.routeId, placeholder: "acme-gateway", mono: true, disabled: profileCommitted })
        })
        + (draft.routeId && !routeValid() ? notice(t("custom.idInvalid")) : "")
        + stackedRow({
          label: escapeHtml(t("prov.displayName")),
          control: textInput({
            id: "cst-name", value: draft.displayName,
            placeholder: draft.routeId || t("custom.nameDefaultPrompt"), disabled: profileCommitted
          })
        })
      })
      + section({
        header: t("prov.connectionSection"),
        body: stackedRow({
          label: escapeHtml(t("custom.baseUrl")),
          control: textInput({ id: "cst-baseurl", value: draft.baseURL, placeholder: "https://gateway.example/v1", disabled: profileCommitted })
        })
        + stackedRow({
          label: escapeHtml(t("prov.apiKey")),
          control: textInput({ id: "cst-key", value: draft.apiKey, type: "password", placeholder: t("custom.keyOptional") })
        })
        + stackedRow({
          label: escapeHtml(t("custom.apiProtocol")),
          control: select({
            id: "cst-api",
            options: protocols.map((value) => ({ value, label: value, selected: value === draft.api })),
            disabled: profileCommitted
          })
        }),
        // 密钥的「路由已建、密钥未写」提示跟着密钥字段留在这一组,否则会孤零零
        // 挂在一个不再存在的「凭证」组上。
        footer: profileCommitted ? escapeHtml(t("custom.keyPending")) : ""
      })
      + section({
        header: t("custom.modelsSection"),
        body: modelsBody(),
        footer: escapeHtml(t("custom.modelsFooter"))
      })
      + (message ? notice(message) : "");
  }

  function repaint() {
    sheet.setBody(body());
    sheet.setActions(
      button({ id: "cst-cancel", label: t("set.cancel") })
      + button({ id: "cst-save", label: saving ? t("set.saving") : t("custom.create"), kind: "primary", disabled: !canSave() })
    );
    bindSheet();
  }

  /// 只更新按钮可用态,不重画输入框 —— 重画会让正在输入的字段失焦。
  function repaintSoft() {
    const root = sheet.root;
    const save = root.querySelector("#cst-save");
    if (save) save.disabled = !canSave();
    const fetchButton = root.querySelector("#cst-fetch");
    if (fetchButton) {
      fetchButton.disabled = !canFetch() || profileCommitted;
      fetchButton.title = canFetch() ? t("cat.fetchHelp") : t("custom.fetchNeedsInput");
    }
  }

  function bindSheet() {
    const root = sheet.root;
    const wire = (id, key, { hard = false, auto = false } = {}) => {
      root.querySelector(id)?.addEventListener("input", (event) => {
        draft[key] = event.target.value;
        if (hard) repaint(); else repaintSoft();
        if (auto) scheduleAutoFetch();
      });
    };
    wire("#cst-route", "routeId", { hard: true });
    wire("#cst-name", "displayName");
    wire("#cst-baseurl", "baseURL", { auto: true });
    wire("#cst-model", "modelId");
    wire("#cst-key", "apiKey", { auto: true });
    root.querySelector("#cst-model-pick")?.addEventListener("change", (event) => {
      draft.modelId = event.target.value; repaintSoft();
    });
    root.querySelector("#cst-api")?.addEventListener("change", (event) => { draft.api = event.target.value; });
    root.querySelector("#cst-fetch")?.addEventListener("click", () => fetchModels());
    root.querySelector("#cst-cancel")?.addEventListener("click", () => close());
    root.querySelector("#cst-save")?.addEventListener("click", () => create());
  }

  /// 地址与密钥齐了就自动拉一次。每次编辑取消上一个定时器重新计时,只有最后
  /// 一次输入活下来;同一个 endpoint 只自动拉一次,重试走手动按钮。
  function scheduleAutoFetch() {
    if (autoFetchTimer != null) clearTimeout(autoFetchTimer);
    autoFetchTimer = null;
    if (!shouldAutoFetchModels({
      baseURL: draft.baseURL, apiKey: draft.apiKey, fetchedFrom, locked: profileCommitted
    })) return;
    autoFetchTimer = setTimeout(() => {
      autoFetchTimer = null;
      if (!shouldAutoFetchModels({
        baseURL: draft.baseURL, apiKey: draft.apiKey, fetchedFrom, locked: profileCommitted
      })) return;
      void fetchModels();
    }, AUTO_FETCH_DELAY_MS);
  }

  async function fetchModels() {
    if (fetching) return;
    fetching = true;
    discovery = null;
    // 成功与否都算「这组 endpoint 试过了」,自动路径不再重复打。
    fetchedFrom = autoFetchEndpointKey(draft.baseURL, draft.apiKey);
    repaint();
    try {
      const value = await settingsService.discoverModels({
        settingsNs: "llm-pi-ai",
        provider: draft.routeId || undefined,
        baseURL: draft.baseURL || undefined,
        api: draft.api || undefined,
        apiKey: draft.apiKey || undefined
      });
      const ids = (value?.models ?? []).map((model) => model?.id).filter(Boolean);
      discoveredModels = ids;
      // 下拉框的选中值必须始终有效,否则会渲染出一个空白选择框。
      if (ids.length && !ids.includes(draft.modelId)) draft.modelId = ids[0];
      discovery = ids.length ? t("cat.discoveryAdded", { found: ids.length, added: ids.length }) : t("cat.discoveryNone");
    } catch (error) {
      discoveredModels = [];
      discovery = deps.formatErrorDetails(error);
    } finally {
      fetching = false;
      repaint();
    }
  }

  /// profile 先落、密钥后落。密钥写失败时不再重复声明路由 —— 重试只补密钥。
  async function create() {
    if (!canSave()) return;
    saving = true; message = null; repaint();
    const ns = "llm-pi-ai";
    const keyRef = deriveKeyRef(draft.routeId);
    try {
      if (!profileCommitted) {
        const profile = {
          baseURL: draft.baseURL.trim(),
          api: draft.api,
          models: [{ id: draft.modelId.trim() }]
        };
        if (draft.apiKey) profile.apiKeyEnv = keyRef;
        if (draft.displayName) profile.displayName = draft.displayName.trim();
        // 必须走 mutate 的 path 数组。settings.update 的 patch 键是字面量键名,
        // 不是路径:传 "providers/xxx" 会在命名空间根上建一个名字里带斜杠的
        // 兄弟键,而不是嵌进 providers 下面,宿主因此完全看不到这个提供方。
        await settingsService.mutate(
          ns,
          [{ op: "set", path: ["providers", draft.routeId], value: profile }],
          state?.namespaces.get(ns)?.revision
        );
        profileCommitted = true;
      }
      if (draft.apiKey) await settingsService.setCredential(keyRef, draft.apiKey);
      close();
      await onDone?.();
    } catch (error) {
      message = translateSaveError(error);
      saving = false;
      repaint();
    }
  }

  function close() {
    if (autoFetchTimer != null) clearTimeout(autoFetchTimer);
    autoFetchTimer = null;
    sheet.close();
  }

  sheet.open({ title: t("custom.title"), body: body(), actions: "", bind: () => repaint() });
}
