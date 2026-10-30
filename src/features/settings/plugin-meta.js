// 插件包自带的多语言显示元数据(dsh 0.1.7 PluginLocalizedMeta)。
// bundle / bundle 行 / pluginInventory 条目 / preset 行都可能带 `meta`:
//   { title?: LocalizedText, description?: LocalizedText, icon?, error? }
//   LocalizedText = string | { en: string, [小写语言 id]: string }
// 宿主在包没有译文时用 manifest 的 name / description 填成字面字符串。
//
// 回退规则对齐 web locale.resolveText:字符串原样;译文表按当前语言的回退链
// (完整 id → 主语言 → en)取第一个存在的值,空串也算"存在"。
import { getLang, t } from "../../shared/i18n.js";

/// ManagementError 里宿主不带原话(diagnostic)的拒绝码 → 本地文案。认不出的码原样显示。
const MANAGEMENT_ERROR_TEXT = {
  "incompatible-version": "plug.errIncompatibleVersion",
  "unsupported-platform": "plug.errUnsupportedPlatform"
};

/// 插件管理失败的说法:宿主原话优先,其次已知码的文案,最后是码本身。
export function managementErrorText(error) {
  if (!error) return "";
  const key = MANAGEMENT_ERROR_TEXT[error.code];
  return error.diagnostic || (key ? t(key) : error.code ?? "");
}

export function resolveLocalizedText(text, lang = getLang()) {
  if (typeof text === "string") return text;
  if (!text || typeof text !== "object") return "";
  const key = String(lang ?? "").toLowerCase();
  const base = key.split("-")[0];
  return text[key] ?? text[base] ?? text.en ?? "";
}

/// 模块短名:@scope/dsh-xxx → dsh-xxx,cordis:include → include。
export function moduleShortName(moduleName) {
  const raw = String(moduleName ?? "");
  if (raw.includes(":")) return raw.slice(raw.lastIndexOf(":") + 1);
  if (raw.startsWith("@")) return raw.slice(raw.indexOf("/") + 1);
  return raw;
}

/// bundle 的标题与说明。对齐 web presentation.packageText:没有 meta.title 时用包名;
/// 说明缺省回退 manifest 原文(老宿主不带 meta)。
export function bundleText(bundle) {
  const meta = bundle?.meta;
  const title = meta?.title === undefined ? "" : resolveLocalizedText(meta.title);
  const description = meta?.description === undefined ? "" : resolveLocalizedText(meta.description);
  return {
    title: title || String(bundle?.name ?? ""),
    description: description || bundle?.description || ""
  };
}

/// 设置页「内置插件」里的紧凑技术名(web PluginInventorySettingsTab.moduleShortName):
/// 去掉 scope,再去掉 cordis: / cordis-plugin- / dsh-[host-|client-] 前缀。只改显示,
/// 模块身份(完整名称)在卡片详情里照原样给出。
export function inventoryShortName(moduleName) {
  const raw = String(moduleName ?? "");
  const unscoped = raw.startsWith("@") ? raw.slice(raw.indexOf("/") + 1) : raw;
  return unscoped
    .replace(/^cordis:/, "")
    .replace(/^cordis-plugin-/, "")
    .replace(/^dsh-(?:host-|client-)?/, "");
}

/// 「内置插件」卡片的标题与说明(web pluginText):真译文原样显示,字面标题或缺省
/// 压成 inventoryShortName;说明为空串时当作没有。
export function inventoryText(row) {
  const title = row?.meta?.title;
  const description = row?.meta?.description === undefined ? "" : resolveLocalizedText(row.meta.description);
  return {
    title: title && typeof title === "object" ? resolveLocalizedText(title) : inventoryShortName(title ?? row?.moduleName),
    description: description || ""
  };
}

/// 插件清单条目(及 preset 行)的标题与说明。对齐 web PluginInventorySettingsTab.pluginText:
/// 真译文原样显示;字面标题(宿主拿包名填的)与缺省一样压成短名。
export function entryText(entry) {
  const meta = entry?.meta;
  const title = meta?.title;
  return {
    title: title && typeof title === "object"
      ? resolveLocalizedText(title)
      : moduleShortName(title ?? entry?.moduleName),
    description: meta?.description === undefined ? "" : resolveLocalizedText(meta.description)
  };
}
