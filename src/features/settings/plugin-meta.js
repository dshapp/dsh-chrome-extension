// 插件包自带的多语言显示元数据(dsh 0.1.7 PluginLocalizedMeta)。
// bundle / bundle 行 / pluginInventory 条目 / preset 行都可能带 `meta`:
//   { title?: LocalizedText, description?: LocalizedText, icon?, error? }
//   LocalizedText = string | { en: string, [小写语言 id]: string }
// 宿主在包没有译文时用 manifest 的 name / description 填成字面字符串。
//
// 回退规则对齐 web locale.resolveText:字符串原样;译文表按当前语言的回退链
// (完整 id → 主语言 → en)取第一个存在的值,空串也算"存在"。
import { getLang } from "../../shared/i18n.js";

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
