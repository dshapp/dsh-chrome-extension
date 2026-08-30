// 已配置提供方的编辑器弹窗。对齐 macos/.../Settings/ProviderEditorSheet.swift。
// 一个密钥字段、一个地址、一张四列目录表 —— 塞不进列表行里,所以是模态。
import { t } from "../../../shared/i18n.js";
import {
  section, stackedRow, textInput, button, iconButton, notice, escapeHtml
} from "./settings-ui.js";
import {
  jsonValueAt, jsonPathExists, modelCatalogOp, modelCatalogMatchesSaved,
  hydrateCatalogRows, validateCatalogRows, canDiscoverModels
} from "../../../features/settings/settings-service.js";

const CATALOG_ERROR_TEXT = {
  idRequired: "cat.rowIdRequired",
  duplicate: "cat.rowDuplicateId",
  nameInvalid: "cat.rowNameSpaces",
  contextInvalid: "cat.rowContextUnreadable",
  maxTokensInvalid: "cat.rowMaxTokensUnreadable"
};

export function openProviderEditor({
  entry, state, sheet, deps, settingsService, rowFor, translateSaveError, onSaved
}) {
  const current = rowFor(entry.provider);
  const namespace = state?.namespaces.get(entry.settingsNs);
  const profile = jsonValueAt(entry.settingsPath ?? [], namespace?.value);
  // api(协议)不在编辑器里露出,但发现模型要靠它选驱动:自定义提供方的
  // profile 里存着,内置提供方则由宿主按 provider 自己推断。读出来带上即可。
  const profileApi = typeof profile?.api === "string" ? profile.api : "";
  const draft = {
    baseURL: typeof profile?.baseURL === "string" ? profile.baseURL : "",
    displayName: typeof profile?.displayName === "string" ? profile.displayName : "",
    apiKey: "",
    rows: hydrateCatalogRows(entry.settingsPath ?? [], namespace?.value)
  };
  const saved = {
    baseURL: draft.baseURL,
    displayName: draft.displayName,
    rows: draft.rows.map((catalogRow) => ({ ...catalogRow }))
  };
  const catalogOverridden = jsonPathExists(namespace?.user, [...(entry.settingsPath ?? []), "models"]);
  const savedCatalogPresent = Array.isArray(profile?.models);
  const keyLocked = current?.credential?.configured === true && current?.credential?.writable === false;
  let discovery = null;
  let saving = false;
  let message = null;

  const dirty = () => draft.baseURL !== saved.baseURL
    || draft.displayName !== saved.displayName
    || Boolean(draft.apiKey)
    || !modelCatalogMatchesSaved(draft.rows, saved.rows);
  const catalogFailure = () => validateCatalogRows(draft.rows);

  function keyFooter() {
    if (keyLocked) return t("prov.keyLockedFooter");
    if (current?.credential?.configured) return t("prov.keyStoredFooter");
    if (current?.apiKeyEnv == null) return t("prov.keyRefCreatedFooter");
    return t("prov.keyStoreFooter");
  }

  function catalogTable() {
    const header = `<div class="cat-row head">`
      + `<span>${escapeHtml(t("cat.columnId"))}</span>`
      + `<span>${escapeHtml(t("cat.columnName"))}</span>`
      + `<span>${escapeHtml(t("cat.columnContext"))}</span>`
      + `<span>${escapeHtml(t("cat.columnMaxOutput"))}</span>`
      + `<span>${escapeHtml(t("cat.columnImage"))}</span>`
      + `<span></span></div>`;
    const body = draft.rows.map((catalogRow, index) => `<div class="cat-row">`
      + textInput({ id: `cat-id-${index}`, value: catalogRow.modelId, placeholder: t("cat.required"), mono: true })
      + textInput({ id: `cat-name-${index}`, value: catalogRow.name, placeholder: t("cat.auto") })
      + textInput({ id: `cat-ctx-${index}`, value: catalogRow.contextWindow, placeholder: t("cat.auto") })
      + textInput({ id: `cat-max-${index}`, value: catalogRow.maxTokens, placeholder: t("cat.auto") })
      + `<label class="cat-check"><input type="checkbox" id="cat-img-${index}"${catalogRow.supportsImage ? " checked" : ""} /></label>`
      + iconButton({ id: `cat-del-${index}`, glyph: "✕", title: t("cat.remove") })
      + `</div>`).join("");
    const failure = catalogFailure();
    return header + body
      + (draft.rows.length ? "" : `<div class="set-row-hint">${escapeHtml(t("cat.emptyFooter"))}</div>`)
      + (failure ? notice(t(CATALOG_ERROR_TEXT[failure.kind], { row: failure.index + 1 })) : "")
      + `<div class="cat-actions">`
      + button({ id: "cat-add", label: t("cat.add") })
      + button({ id: "cat-restore", label: t("cat.restoreDefaults"), disabled: !catalogOverridden && !draft.rows.length })
      + button({
        id: "cat-fetch",
        label: t("cat.fetch"),
        title: canDiscoverModels(draft.apiKey, current?.apiKeyEnv, current?.credential?.configured)
          ? t("cat.fetchHelp") : t("cat.fetchNeedsKey"),
        disabled: !canDiscoverModels(draft.apiKey, current?.apiKeyEnv, current?.credential?.configured)
      })
      + `</div>`
      + (discovery ? `<div class="set-row-hint">${escapeHtml(discovery)}</div>` : "")
      + `<div class="set-section-footer">${escapeHtml(t("cat.footer"))}</div>`;
  }

  function body() {
    return section({
      header: t("prov.connectionSection"),
      body: stackedRow({
        label: escapeHtml(t("prov.baseUrl")),
        hint: escapeHtml(t("prov.baseUrlFooter")),
        control: textInput({ id: "prov-baseurl", value: draft.baseURL, placeholder: t("cat.auto") })
      })
      + stackedRow({
        label: escapeHtml(t("prov.apiKey")),
        control: textInput({
          id: "prov-key", value: draft.apiKey, type: "password",
          placeholder: current?.credential?.configured ? "••••••••" : "", disabled: keyLocked
        })
      })
      + stackedRow({
        label: escapeHtml(t("prov.displayName")),
        control: textInput({ id: "prov-displayname", value: draft.displayName, placeholder: entry.provider })
      }),
      footer: escapeHtml(keyFooter())
    })
    + section({
      header: t("cat.title") + (catalogOverridden ? " " : ""),
      body: catalogTable()
    })
    + (message ? notice(message) : "");
  }

  function repaint() {
    sheet.setBody(body());
    sheet.setActions(
      button({ id: "prov-cancel", label: t("set.cancel") })
      + button({
        id: "prov-save",
        label: saving ? t("set.saving") : t("set.save"),
        kind: "primary",
        disabled: saving || !dirty() || Boolean(catalogFailure())
      })
    );
    bindEditor();
  }

  function bindEditor() {
    const root = sheet.root;
    root.querySelector("#prov-key")?.addEventListener("input", (event) => {
      draft.apiKey = event.target.value; repaintSoft();
    });
    root.querySelector("#prov-baseurl")?.addEventListener("input", (event) => {
      draft.baseURL = event.target.value; repaintSoft();
    });
    root.querySelector("#prov-displayname")?.addEventListener("input", (event) => {
      draft.displayName = event.target.value; repaintSoft();
    });
    draft.rows.forEach((catalogRow, index) => {
      root.querySelector(`#cat-id-${index}`)?.addEventListener("input", (event) => {
        catalogRow.modelId = event.target.value; repaintSoft();
      });
      root.querySelector(`#cat-name-${index}`)?.addEventListener("input", (event) => {
        catalogRow.name = event.target.value; repaintSoft();
      });
      root.querySelector(`#cat-ctx-${index}`)?.addEventListener("input", (event) => {
        catalogRow.contextWindow = event.target.value; repaintSoft();
      });
      root.querySelector(`#cat-max-${index}`)?.addEventListener("input", (event) => {
        catalogRow.maxTokens = event.target.value; repaintSoft();
      });
      root.querySelector(`#cat-img-${index}`)?.addEventListener("change", (event) => {
        catalogRow.supportsImage = event.target.checked; repaintSoft();
      });
      root.querySelector(`#cat-del-${index}`)?.addEventListener("click", () => {
        draft.rows.splice(index, 1); repaint();
      });
    });
    root.querySelector("#cat-add")?.addEventListener("click", () => {
      draft.rows.push({ modelId: "", name: "", contextWindow: "", maxTokens: "", supportsImage: false, existing: false });
      repaint();
    });
    root.querySelector("#cat-restore")?.addEventListener("click", () => {
      draft.rows = []; repaint();
    });
    root.querySelector("#cat-fetch")?.addEventListener("click", () => discoverModels());
    root.querySelector("#prov-cancel")?.addEventListener("click", () => sheet.close());
    root.querySelector("#prov-save")?.addEventListener("click", () => commit());
  }

  /// 只更新按钮可用态,不重画输入框 —— 重画会让正在输入的字段失焦。
  function repaintSoft() {
    const save = sheet.root.querySelector("#prov-save");
    if (save) save.disabled = saving || !dirty() || Boolean(catalogFailure());
    const fetchButton = sheet.root.querySelector("#cat-fetch");
    if (fetchButton) {
      fetchButton.disabled = !canDiscoverModels(draft.apiKey, current?.apiKeyEnv, current?.credential?.configured);
    }
  }

  /// 「获取可用模型」走宿主 llm.discoverModels。不支持发现的提供方宿主会明确
  /// 报错(如 no model discovery is registered),原话展示给用户 —— 这是与
  /// 使用者确认过的行为:不猜、不静默。
  async function discoverModels() {
    discovery = null;
    try {
      const value = await settingsService.discoverModels({
        settingsNs: entry.settingsNs,
        provider: entry.provider,
        baseURL: draft.baseURL || undefined,
        api: profileApi || undefined,
        apiKey: draft.apiKey || undefined
      });
      const found = value?.models ?? [];
      const known = new Set(draft.rows.map((catalogRow) => catalogRow.modelId.trim()).filter(Boolean));
      const added = found.filter((model) => model?.id && !known.has(model.id));
      for (const model of added) {
        draft.rows.push({
          modelId: model.id,
          name: model.name ?? "",
          contextWindow: "",
          maxTokens: "",
          supportsImage: Array.isArray(model.input) && model.input.includes("image"),
          existing: false
        });
      }
      discovery = !found.length
        ? t("cat.discoveryNone")
        : added.length
          ? t("cat.discoveryAdded", { found: found.length, added: added.length })
          : t("cat.discoveryAllKnown", { found: found.length });
    } catch (error) {
      discovery = deps.formatErrorDetails(error);
    }
    repaint();
  }

  async function commit() {
    if (saving) return;
    const fresh = rowFor(entry.provider);
    if (!fresh) { message = t("prov.noLongerListed"); repaint(); return; }
    saving = true; message = null; repaint();
    const ops = [];
    const path = entry.settingsPath ?? [];
    const pathOp = (field, value) => (value
      ? { op: "set", path: [...path, field], value }
      : { op: "unset", path: [...path, field] });
    if (draft.baseURL !== saved.baseURL) ops.push(pathOp("baseURL", draft.baseURL.trim()));
    if (draft.displayName !== saved.displayName) ops.push(pathOp("displayName", draft.displayName.trim()));
    if (!modelCatalogMatchesSaved(draft.rows, saved.rows)) {
      const catalog = modelCatalogOp(draft.rows, path, savedCatalogPresent);
      if (catalog) ops.push(catalog);
    }
    try {
      await settingsService.saveProvider(
        { ...fresh, expectedRevision: state?.namespaces.get(entry.settingsNs)?.revision },
        ops,
        draft.apiKey
      );
      sheet.close();
      await onSaved?.(entry.displayName || entry.provider);
    } catch (error) {
      message = translateSaveError(error);
      saving = false;
      repaint();
    }
  }

  sheet.open({
    title: entry.displayName || entry.provider,
    body: body(),
    actions: "",
    bind: () => repaint()
  });
}
