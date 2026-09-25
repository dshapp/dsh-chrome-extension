// 自定义提供方弹窗。对齐 web 的 CustomProviderCard:
//
// - 路由 id 在被"选择",所以地址还不存在:一个 mutate 把整份 profile 写在
//   providers.<route> 下,密钥随后单独经 credentials/set 落在 profile 记录的引用上;
// - 路由 id 必须匹配小写标识、且不与已有路由重名;地址必须是 http(s) URL;
//   至少一个模型 —— 这些闸门在提交前就报错,而不是写下去让宿主拒绝;
// - profile 落盘后字段冻结,重试只补密钥(那条 mutate 的 revision 已被自己顶掉,
//   再发一次只会得到 settings/conflict);
// - 密钥留空是合法的:该路由走提供方原生认证(getenv / ADC)。
import { t } from "../../../shared/i18n.js";
import {
  section, stackedRow, select, textInput, button, notice, escapeHtml
} from "./settings-ui.js";
import {
  deriveKeyRef, apiKeyFailure, jsonValueAt
} from "../../../features/settings/settings-service.js";
import { createModelCatalogEditor } from "./model-list-editor.js";

const ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NS = "llm-pi-ai";

const KEY_FAILURE_TEXT = { blank: "prov.keyBlank", illegalCharacters: "prov.keyFormatInvalid" };

/// 从 schema 里取自定义提供方支持的 api 协议列表。宿主序列化的是 schemastery
/// 的 ref 图({ uid, refs }),必须沿 providers.<任意路由>.api 走到那个 union 节点,
/// 而不是把所有 const 字面量捞出来按前缀筛 —— 提供方路由 id(如
/// `azure-openai-responses`)也是 const,会被错当成协议发给宿主,写入被拒。
export function protocolChoices(schema) {
  if (!schema || typeof schema !== "object") return [];
  const refs = schema.refs && typeof schema.refs === "object" ? schema.refs : {};
  const resolve = (node) => (typeof node === "number" ? refs[String(node)] : node);
  let node = resolve(schema.uid);
  for (const key of ["providers", "__probe__", "api"]) {
    if (!node || typeof node !== "object") return [];
    if (node.type === "object") node = resolve(node.dict?.[key]);
    else if (node.type === "dict" || node.type === "array") node = resolve(node.inner);
    else return [];
  }
  if (!node || node.type !== "union" || !Array.isArray(node.list)) return [];
  return node.list
    .map((entry) => resolve(entry))
    .map((entry) => entry?.value)
    .filter((value) => typeof value === "string" && value.length > 0);
}

function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/// 已在 llm-pi-ai 下声明的路由 id:目录行 + 用户/基线层的 providers 键。
export function declaredRoutes(state) {
  const taken = new Set();
  for (const row of state?.rows ?? []) {
    if (row.entry.settingsNs === NS) taken.add(row.entry.provider);
  }
  const namespace = state?.namespaces?.get(NS);
  for (const source of [namespace?.user, namespace?.base]) {
    const providers = jsonValueAt(["providers"], source);
    if (providers && typeof providers === "object") for (const key of Object.keys(providers)) taken.add(key);
  }
  return [...taken];
}

export function openCustomProvider({ state, sheet, deps, settingsService, translateSaveError, onDone }) {
  const namespace = state?.namespaces.get(NS);
  const protocols = protocolChoices(namespace?.schema);
  const taken = declaredRoutes(state);
  const openedAt = namespace?.revision;


  const draft = { routeId: "", displayName: "", baseURL: "", api: protocols[0] ?? "", apiKey: "" };
  let saving = false;
  let profileCommitted = false;
  let message = null;

  const editor = createModelCatalogEditor({
    allowFetch: true,
    inputField: "input", // 自定义路由走 pi-ai,输入类型声明在条目的 input 上。
    discover: (request) => settingsService.discoverModels(request),
    formatErrorDetails: (error) => deps.formatErrorDetails(error),
    requestRender: (mode) => { if (mode === "hard") repaint(); else repaintSoft(); },
    context: () => {
      const failure = apiKeyFailure(draft.apiKey);
      const normalized = draft.baseURL.trim();
      return {
        disabled: saving || profileCommitted,
        probeEnabled: Boolean(normalized) || Boolean(draft.routeId),
        probeBlocked: normalized && !isHttpUrl(normalized) ? "custom.baseUrlInvalid"
          : failure ? KEY_FAILURE_TEXT[failure] : undefined,
        probe: {
          settingsNs: NS,
          ...(draft.routeId ? { provider: draft.routeId } : {}),
          ...(normalized ? { baseURL: normalized } : {}),
          ...(draft.api ? { api: draft.api } : {}),
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
        },
        capacityPlaceholders: {}
      };
    }
  });
  editor.setRows([], false);

  const routeInvalid = () => draft.routeId.length > 0 && !ROUTE_ID_PATTERN.test(draft.routeId);
  const routeTaken = () => taken.includes(draft.routeId);
  const baseUrlInvalid = () => draft.baseURL.length > 0 && !isHttpUrl(draft.baseURL.trim());
  const keyFailure = () => apiKeyFailure(draft.apiKey);

  function ready() {
    return draft.routeId.length > 0 && !routeInvalid() && !routeTaken()
      && draft.baseURL.trim().length > 0 && !baseUrlInvalid()
      && editor.rows.length > 0 && !editor.validation() && !keyFailure();
  }

  function canSave() {
    if (saving) return false;
    if (profileCommitted) return Boolean(draft.apiKey.trim());
    return ready();
  }

  function catalogFailureText() {
    const failure = editor.validation();
    if (!failure) return null;
    const text = {
      idRequired: "cat.rowIdRequired", duplicate: "cat.rowDuplicateId",
      contextInvalid: "cat.rowContextUnreadable", maxTokensInvalid: "cat.rowMaxTokensUnreadable"
    };
    return t(text[failure.kind], { row: failure.index + 1 });
  }

  function routeErrorHtml() {
    if (routeInvalid()) return notice(t("custom.idInvalid"));
    if (routeTaken()) return notice(t("custom.routeTaken"));
    return "";
  }

  function baseUrlErrorHtml() {
    return baseUrlInvalid() ? notice(t("custom.baseUrlInvalid")) : "";
  }

  function keyErrorHtml() {
    const failure = keyFailure();
    if (!failure) return "";
    return notice(t(profileCommitted ? "prov.keyBlank" : KEY_FAILURE_TEXT[failure]));
  }

  function hint() {
    if (message || ready() || keyFailure() || routeInvalid() || routeTaken() || baseUrlInvalid()) return null;
    if (draft.routeId.length === 0) return null;
    if (!draft.baseURL.trim()) return t("custom.needsBaseUrl");
    if (editor.rows.length === 0) return t("custom.needsModels");
    return null;
  }

  function body() {
    const disabled = saving || profileCommitted;
    return '<p class="set-sheet-text">' + escapeHtml(t("custom.intro")) + "</p>"
      + section({
        header: t("custom.identitySection"),
        body: stackedRow({
          label: escapeHtml(t("custom.route")),
          control: textInput({
            id: "cst-route", value: draft.routeId, placeholder: "acme-gateway", mono: true, disabled
          }),
          hint: escapeHtml(t("custom.routeHint"))
        })
        + '<div id="cst-route-error">' + routeErrorHtml() + "</div>"
        + stackedRow({
          label: escapeHtml(t("prov.displayName")),
          control: textInput({
            id: "cst-name", value: draft.displayName,
            placeholder: draft.routeId || t("custom.nameDefaultPrompt"), disabled
          })
        })
      })
      + section({
        header: t("prov.connectionSection"),
        body: stackedRow({
          label: escapeHtml(t("custom.baseUrl")),
          control: textInput({
            id: "cst-baseurl", value: draft.baseURL, placeholder: "https://gateway.example/v1", disabled
          })
        })
        + '<div id="cst-baseurl-error">' + baseUrlErrorHtml() + "</div>"
        + stackedRow({
          label: escapeHtml(t("custom.apiProtocol")),
          control: select({
            id: "cst-api",
            options: protocols.map((value) => ({ value, label: value, selected: value === draft.api })),
            disabled
          })
        })
        + stackedRow({
          label: escapeHtml(t("prov.apiKey")),
          control: textInput({
            id: "cst-key", value: draft.apiKey, type: "password",
            placeholder: t("custom.keyOptional"), disabled: saving
          })
        })
        + '<div id="cst-key-error">' + keyErrorHtml() + "</div>"
        + (profileCommitted ? '<div class="set-row-hint">' + escapeHtml(t("custom.keyPending")) + "</div>" : "")
      })
      + editor.html()
      + (catalogFailureText() ? notice(catalogFailureText()) : "")
      + (message ? notice(message) : "")
      + '<div id="cst-hint">' + (hint() ? notice(hint(), "muted") : "") + "</div>";
  }

  let sheetToken = 0;

  function repaint() {
    if (!sheet.owns(sheetToken)) return;
    sheet.setBody(body(), sheetToken);
    sheet.setActions(
      button({ id: "cst-cancel", label: t("set.cancel") })
      + button({ id: "cst-save", label: saving ? t("set.saving") : t("custom.create"), kind: "primary", disabled: !canSave() }),
      sheetToken
    );
    bindSheet();
  }

  /// 软刷新:只改能被当前输入影响的状态提示与按钮,不重建输入框(否则
  /// 路由字段每敲一个字符都会失焦)。
  function repaintSoft() {
    if (!sheet.owns(sheetToken)) return;
    const root = sheet.root;
    const save = root.querySelector("#cst-save");
    if (save) save.disabled = !canSave();
    const routeErr = root.querySelector("#cst-route-error");
    if (routeErr) routeErr.innerHTML = routeErrorHtml();
    const baseErr = root.querySelector("#cst-baseurl-error");
    if (baseErr) baseErr.innerHTML = baseUrlErrorHtml();
    const keyErr = root.querySelector("#cst-key-error");
    if (keyErr) keyErr.innerHTML = keyErrorHtml();
    const hintEl = root.querySelector("#cst-hint");
    if (hintEl) hintEl.innerHTML = hint() ? notice(hint(), "muted") : "";
    editor.syncChrome(root);
  }

  function bindSheet() {
    const root = sheet.root;
    const wire = (id, key, hard) => {
      root.querySelector(id)?.addEventListener("input", (event) => {
        draft[key] = event.target.value;
        if (hard) repaint(); else repaintSoft();
      });
    };
    wire("#cst-route", "routeId", false);
    wire("#cst-name", "displayName", false);
    wire("#cst-baseurl", "baseURL", false);
    wire("#cst-key", "apiKey", false);
    root.querySelector("#cst-api")?.addEventListener("change", (event) => {
      draft.api = event.target.value;
      repaintSoft();
    });
    root.querySelector("#cst-cancel")?.addEventListener("click", () => sheet.close(sheetToken));
    root.querySelector("#cst-save")?.addEventListener("click", () => { void create(); });
    editor.bind(root);
  }

  async function create() {
    if (!canSave()) return;
    saving = true; message = null; repaint();
    const keyRef = deriveKeyRef(draft.routeId);
    const storesKey = draft.apiKey.trim().length > 0;
    try {
      if (!profileCommitted) {
        const profile = {
          ...(draft.displayName ? { displayName: draft.displayName } : {}),
          ...(storesKey ? { apiKeyEnv: keyRef } : {}),
          api: draft.api,
          baseURL: draft.baseURL.trim(),
          models: editor.models()
        };
        await settingsService.mutate(
          NS,
          [{ op: "set", path: ["providers", draft.routeId], value: profile }],
          openedAt
        );
        profileCommitted = true;
      }
      if (storesKey) await settingsService.setCredential(keyRef, draft.apiKey.trim());
      sheet.close(sheetToken);
      await onDone?.();
    } catch (error) {
      if (!sheet.owns(sheetToken)) return;
      message = translateSaveError(error);
      saving = false;
      repaint();
    }
  }

  sheetToken = sheet.open({
    title: t("custom.title"), body: body(), actions: "",
    bind: (_root, generation) => { sheetToken = generation; repaint(); }
  });
}
