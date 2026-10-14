// 已配置提供方的编辑器弹窗。对齐 web 的 ProviderEditor:
//
// - 密钥字段是只写的;输入框为空表示保持已存密钥,只有真的敲了值才写凭证;
// - 自定义设置(显示名称 / 协议 / 地址 / 模型目录)折叠在一个 disclosure 里,
//   其中显示名称与协议只对适配器未内置的手写路由(declared)开放 —— 内置路由
//   的每个模型自带协议,路由级覆盖只会盖掉它们;
// - 编辑落在**用户层草稿**上:打开时深拷 user 子树,保存时与它做最小 set/unset
//   路径操作。以前拿生效值(value,含 base 层)当草稿,清空一个继承下来的字段
//   会在 user 层发一个无意义的 unset,地址反而看起来"删不掉";
// - profile 写成功后用宿主回包的 revision 刷新重试基线,再写凭证,失败可原地重试;
// - 只有 llm-pi-ai 显示「获取可用模型」—— 宿主只为它注册了模型发现。
import { t } from "../../../shared/i18n.js";
import {
  stackedRow, textInput, secretInput, bindSecretToggles, select, button, notice, tag, escapeHtml
} from "./settings-ui.js";
import {
  jsonValueAt, jsonPathExists, profilePathOps, deriveKeyRef, apiKeyFailure,
  formatCapacitySpelling, catalogRowsFromModels, inheritedProviderModels, providerKeyCredential
} from "../../../features/settings/settings-service.js";
import { createModelCatalogEditor } from "./model-list-editor.js";
import { protocolChoices } from "./custom-provider-sheet.js";
import { providerDisplayName } from "./settings-ui.js";

const LAYOUT_BY_NS = {
  "llm-deepseek": "deepseek",
  // 账号路由:web 的账号卡片 —— 只有模型目录,没有密钥/地址字段。
  "llm-deepseek-account": "deepseek-account",
  "llm-pi-ai": "pi-ai"
};

/// 目录条目里声明输入类型的字段按适配器命名:deepseek 系叫 inputModalities,
/// pi-ai 写作 input(对齐 web 的 inputField)。
const INPUT_FIELD_BY_LAYOUT = {
  deepseek: "inputModalities",
  "deepseek-account": "inputModalities",
  "pi-ai": "input"
};

const KEY_FAILURE_TEXT = { blank: "prov.keyBlank", illegalCharacters: "prov.keyFormatInvalid" };

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stringAt(source, key) {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function openProviderEditor({
  entry, state, sheet, deps, settingsService, rowFor, translateSaveError, onSaved
}) {
  const ns = entry.settingsNs;
  const path = entry.settingsPath ?? [];
  const namespace = state?.namespaces.get(ns);
  const layout = entry.provider === "deepseek-account" ? "deepseek-account" : LAYOUT_BY_NS[ns] ?? "unknown";
  const inputField = INPUT_FIELD_BY_LAYOUT[layout] ?? "input";
  const declared = entry.declared === true;
  const effective = jsonValueAt(path, namespace?.value);
  const schema = namespace?.schema;
  const protocols = layout === "pi-ai" ? protocolChoices(schema) : [];

  let userDraft = clone(jsonValueAt(path, namespace?.user)) ?? {};
  let committedOriginal = clone(jsonValueAt(path, namespace?.user));
  let expectedRevision = namespace?.revision;

  const current = () => rowFor(entry.provider);
  const keyRef = () => stringAt(userDraft, "apiKeyEnv") ?? stringAt(effective, "apiKeyEnv")
    ?? deriveKeyRef(entry.provider);
  let keyDraft = "";
  let keyRevealed = false;
  let message = null;
  let saving = false;

  const userOwnsModels = jsonPathExists(userDraft, ["models"]) || jsonPathExists(namespace?.user, [...path, "models"]);

  const editor = createModelCatalogEditor({
    allowFetch: layout === "pi-ai",
    inputField,
    discover: (request) => settingsService.discoverModels(request),
    formatErrorDetails: (error) => deps.formatErrorDetails(error),
    requestRender: (mode) => { if (mode === "hard") repaint(); else repaintSoft(); },
    context: () => {
      const keyFailureKind = apiKeyFailure(keyDraft);
      return {
        disabled: saving || (current()?.settingsWritable ?? state?.writable) === false,
        inheritedModels: inheritedProviderModels(namespace, path),
        defaultInput: effective?.defaultInput,
        probeEnabled: Boolean(entry.provider) || Boolean(stringAt(userDraft, "baseURL") ?? stringAt(effective, "baseURL")),
        probeBlocked: keyFailureKind ? KEY_FAILURE_TEXT[keyFailureKind] : undefined,
        probe: {
          settingsNs: ns,
          provider: entry.provider,
          ...(stringAt(userDraft, "baseURL") ?? stringAt(effective, "baseURL")
            ? { baseURL: stringAt(userDraft, "baseURL") ?? stringAt(effective, "baseURL") } : {}),
          ...(stringAt(userDraft, "api") ?? stringAt(effective, "api")
            ? { api: stringAt(userDraft, "api") ?? stringAt(effective, "api") } : {}),
          ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {})
        },
        capacityPlaceholders: {
          contextWindow: typeof effective?.defaultContextWindow === "number"
            ? formatCapacitySpelling(effective.defaultContextWindow) : undefined,
          maxTokens: typeof (effective?.defaultMaxTokens ?? effective?.maxTokens) === "number"
            ? formatCapacitySpelling(effective.defaultMaxTokens ?? effective.maxTokens) : undefined
        }
      };
    }
  });
  editor.setRows(
    catalogRowsFromModels(
      jsonPathExists(userDraft, ["models"]) ? userDraft.models : inheritedProviderModels(namespace, path),
      inputField
    ),
    userOwnsModels
  );

  /// 当前草稿折回设置对象:模型目录只在用户拥有它时才写进草稿。
  function nextDraft() {
    const next = clone(userDraft) ?? {};
    if (editor.touched) {
      if (editor.owned) next.models = editor.models();
      else delete next.models;
    } else if (!userOwnsModels) delete next.models;
    return next;
  }

  function keyFailureText() {
    const kind = apiKeyFailure(keyDraft);
    return kind ? t(KEY_FAILURE_TEXT[kind]) : null;
  }

  function catalogFailureText() {
    const failure = editor.validation();
    if (!failure) return null;
    return t(CATALOG_ERROR_TEXT[failure.kind], { row: failure.index + 1 });
  }

  const CATALOG_ERROR_TEXT = {
    idRequired: "cat.rowIdRequired",
    duplicate: "cat.rowDuplicateId",
    contextInvalid: "cat.rowContextUnreadable",
    maxTokensInvalid: "cat.rowMaxTokensUnreadable"
  };

  function dirty() {
    return JSON.stringify(nextDraft()) !== JSON.stringify(committedOriginal ?? {}) || Boolean(keyDraft);
  }

  function canSave() {
    return !saving && (current()?.settingsWritable ?? state?.writable) !== false
      && !(keyDraft && providerKeyCredential(current())?.writable === false)
      && layout !== "unknown" && dirty()
      && !catalogFailureText() && !keyFailureText();
  }

  /// 用户层已有的自定义项数量(地址 / 显示名 / 协议 / 模型目录)。折叠标题上
  /// 给出这个数,用户不展开也知道这里是不是改过。
  function customizedCount() {
    return ["baseURL", "displayName", "api", "models"].filter((key) => jsonPathExists(userDraft, [key])).length;
  }

  // 只在首次绘制时根据是否已有自定义项决定展开;之后尊重用户的手动开合。
  let detailsOpen = null;
  function customizedOpen() {
    if (detailsOpen === null) detailsOpen = customizedCount() > 0;
    return detailsOpen;
  }

  function placeholderNames() {
    if (layout === "pi-ai" && declared) return ["displayName", "api"];
    return [];
  }

  function body() {
    const row = current();
    const keyCredential = providerKeyCredential(row);
    const locked = keyCredential?.writable === false || (row?.settingsWritable ?? state?.writable) === false;
    if (layout === "deepseek-account") {
      // web 账号卡片:只有模型目录。路由用登录态认证,没有密钥与地址可改。
      return editor.html()
        + (catalogFailureText() ? notice(catalogFailureText()) : "")
        + (message ? notice(message) : "");
    }
    // 标题旁的状态胶囊:打开编辑器第一眼就知道密钥在不在,不用读灰色的说明行。
    const keyStatus = keyCredential?.configured
      ? tag(t("prov.keyConfiguredShort"), "ok")
      : keyCredential ? tag(t("prov.keyMissingShort"), "warn") : "";
    const keyRow = stackedRow({
      label: escapeHtml(t("prov.apiKey")) + keyStatus,
      control: secretInput({
        id: "prov-key", value: keyDraft, revealed: keyRevealed,
        placeholder: keyCredential?.configured ? t("prov.keyKeepPlaceholder") : t("prov.keyPastePlaceholder"),
        disabled: locked
      }),
      hint: escapeHtml(locked ? t("prov.keyLockedFooter")
        : keyCredential?.configured ? t("prov.keyStoredFooter")
        : row?.apiKeyEnv == null ? t("prov.keyRefCreatedFooter")
        : t("prov.keyStoreFooter"))
    });
    if (layout === "unknown") {
      return keyRow + notice(t("prov.unknownLayout", { ns }));
    }
    const names = placeholderNames();
    const detailBody = (names.includes("displayName")
      ? stackedRow({
        label: escapeHtml(t("prov.displayName")),
        control: textInput({
          id: "prov-displayname", value: stringAt(userDraft, "displayName") ?? "",
          placeholder: stringAt(effective, "displayName") ?? entry.provider
        })
      })
      : "")
      + (names.includes("api")
        ? stackedRow({
          label: escapeHtml(t("custom.apiProtocol")),
          control: select({
            id: "prov-api",
            options: [
              ...(stringAt(userDraft, "api") ?? stringAt(effective, "api")
                ? [] : [{ value: "", label: t("custom.apiUnset"), selected: true }]),
              ...protocols.map((value) => ({
                value, label: value,
                selected: value === (stringAt(userDraft, "api") ?? stringAt(effective, "api"))
              }))
            ]
          })
        })
        : "")
      + stackedRow({
        label: escapeHtml(t("prov.baseUrl")),
        hint: escapeHtml(t("prov.baseUrlFooter")),
        control: textInput({
          id: "prov-baseurl", value: stringAt(userDraft, "baseURL") ?? "",
          placeholder: stringAt(effective, "baseURL") ?? t("cat.auto")
        })
      })
      + editor.html();
    return keyRow
      + '<details class="set-details"' + (customizedOpen() ? " open" : "") + '><summary>' + escapeHtml(t("prov.customized"))
      + (customizedCount() ? tag(t("prov.customizedCount", { count: customizedCount() })) : "") + "</summary>"
      + '<div class="set-details-body">' + detailBody + "</div></details>"
      + (catalogFailureText() ? notice(catalogFailureText()) : "")
      + (message ? notice(message) : "");
  }

  let sheetToken = 0;

  function repaint() {
    if (!sheet.owns(sheetToken)) return;
    sheet.setBody(body(), sheetToken);
    sheet.setActions(
      button({ id: "prov-cancel", label: t("set.cancel") })
      + button({ id: "prov-save", label: saving ? t("set.saving") : t("set.save"), kind: "primary", disabled: !canSave() }),
      sheetToken
    );
    bindEditor();
    if (saving || (current()?.settingsWritable ?? state?.writable) === false) {
      for (const input of sheet.root.querySelectorAll("input, select")) input.disabled = true;
    }
  }

  /// 只更新按钮可用态,不重画输入框 —— 重画会让正在输入的字段失焦。
  function repaintSoft() {
    if (!sheet.owns(sheetToken)) return;
    const save = sheet.root.querySelector("#prov-save");
    if (save) save.disabled = !canSave();
    const readOnly = (current()?.settingsWritable ?? state?.writable) === false;
    const key = sheet.root.querySelector("#prov-key");
    if (key) key.disabled = readOnly || saving || providerKeyCredential(current())?.writable === false;
    for (const field of sheet.root.querySelectorAll("#prov-baseurl, #prov-displayname, #prov-api")) field.disabled = saving || readOnly;
    editor.syncChrome(sheet.root);
  }

  function bindEditor() {
    const root = sheet.root;
    root.querySelector("#prov-key")?.addEventListener("input", (event) => {
      keyDraft = event.target.value;
      repaintSoft();
    });
    root.querySelector("#prov-baseurl")?.addEventListener("input", (event) => {
      if (event.target.value.trim()) userDraft.baseURL = event.target.value;
      else delete userDraft.baseURL;
      repaintSoft();
    });
    root.querySelector("#prov-displayname")?.addEventListener("input", (event) => {
      if (event.target.value.trim()) userDraft.displayName = event.target.value;
      else delete userDraft.displayName;
      repaintSoft();
    });
    root.querySelector("#prov-api")?.addEventListener("change", (event) => {
      if (event.target.value) userDraft.api = event.target.value;
      else delete userDraft.api;
      repaintSoft();
    });
    // 单行字段里按 Enter 直接保存(可保存时),与原生表单的提交手感一致。
    for (const field of root.querySelectorAll("#prov-key, #prov-baseurl, #prov-displayname")) {
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing || !canSave()) return;
        event.preventDefault();
        void commit();
      });
    }
    bindSecretToggles(root, (_id, revealed) => { keyRevealed = revealed; });
    root.querySelector(".set-details")?.addEventListener("toggle", (event) => { detailsOpen = event.target.open; });
    root.querySelector("#prov-cancel")?.addEventListener("click", () => sheet.close(sheetToken));
    root.querySelector("#prov-save")?.addEventListener("click", () => { void commit(); });
    editor.bind(root);
  }

  async function commit() {
    if (saving || !canSave()) return;
    const fresh = rowFor(entry.provider);
    if (!fresh) { message = t("prov.noLongerListed"); repaint(); return; }
    saving = true; message = null; repaint();
    const keyValue = keyDraft.trim();
    try {
      const next = nextDraft();
      if (layout === "pi-ai" && keyValue
        && stringAt(next, "apiKeyEnv") === undefined && stringAt(effective, "apiKeyEnv") === undefined) {
        next.apiKeyEnv = keyRef();
      }
      const materializesNativeProfile = layout === "pi-ai"
        && effective === undefined && committedOriginal === undefined && Object.keys(next).length === 0;
      const ops = materializesNativeProfile
        ? [{ op: "set", path, value: {} }]
        : profilePathOps(path, committedOriginal, next);
      if (ops.length) {
        const view = await settingsService.mutate(ns, ops, expectedRevision);
        committedOriginal = clone(jsonValueAt(path, view?.user));
        expectedRevision = view?.revision ?? expectedRevision;
        userDraft = clone(jsonValueAt(path, view?.user)) ?? {};
      }
      if (keyValue) {
        if (providerKeyCredential(current())?.writable === false) throw new Error("keyLocked");
        await settingsService.setCredential(keyRef(), keyValue);
      }
      sheet.close(sheetToken);
      await onSaved?.(providerDisplayName(entry));
    } catch (error) {
      if (!sheet.owns(sheetToken)) return;
      message = translateSaveError(error);
      saving = false;
      repaint();
    }
  }

  sheetToken = sheet.open({
    title: providerDisplayName(entry),
    body: body(),
    actions: "",
    bind: (_root, generation) => { sheetToken = generation; repaint(); }
  });
  // 广播只更新事实/可用态,不重建输入或推进脏草稿的 revision。
  return {
    refreshFacts: repaintSoft,
    get active() { return sheet.owns(sheetToken); },
    get dirty() { return dirty(); }
  };
}
