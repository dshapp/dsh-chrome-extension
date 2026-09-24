// 插件安装的下载源(dsh 0.1.7)。对齐 Mac PluginManagerStore.RegistryChoice /
// automaticRegistry / pluginRegistryName,与 web ui-plugin-manager 的
// eligibleMirror + readRegistries(见 web 笔记 2026-09-18-plugin-install-registries)。
//
// 只决定"首先问哪个源";问的顺序与回退是宿主的(registryPlan),这里不复制那套
// 规则 —— 复制了就会漂移(web 笔记"让对话框描述计划"被否决的原因)。
import { t } from "../../shared/i18n.js";

/// npm 官方源:pnpm 零配置时就是它。与 web OFFICIAL_NPM_REGISTRY 同值。
export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
/// 宿主默认回退的公共镜像。与 web NPMMIRROR_REGISTRY 同值。
export const NPMMIRROR_REGISTRY = "https://registry.npmmirror.com/";
/// 与宿主校验 `--registry` 用的同一条规则(web REGISTRY_URL)。
export const REGISTRY_URL = /^https?:\/\/\S+$/;

/// 下拉里的四个选项,顺序即显示顺序(Mac RegistryChoice)。
export const REGISTRY_CHOICES = Object.freeze(["automatic", "official", "mirror", "custom"]);

const CHOICE_KEY = "dsh.plugin-install.registry";
const CUSTOM_KEY = "dsh.plugin-install.customRegistry";

function storageOf(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/// 上次的选择。选择属于这个浏览器,不进宿主设置(web 笔记否决了存 Host 设置)。
export function readRegistryChoice(storage) {
  const store = storageOf(storage);
  let choice = null;
  let custom = "";
  try {
    choice = store?.getItem(CHOICE_KEY) ?? null;
    custom = store?.getItem(CUSTOM_KEY) ?? "";
  } catch { /* 隐私模式下读不了,按默认 */ }
  return { choice: REGISTRY_CHOICES.includes(choice) ? choice : "automatic", custom };
}

export function saveRegistryChoice({ choice, custom }, storage) {
  const store = storageOf(storage);
  try {
    if (choice !== undefined) store?.setItem(CHOICE_KEY, choice);
    if (custom !== undefined) store?.setItem(CUSTOM_KEY, custom);
  } catch { /* 写不了就只在本次弹窗内有效 */ }
}

/// pnpm 比较源的形式:小写主机 + 尾斜杠(web normalizeRegistry)。非 http(s) 返回 null。
export function normalizeRegistry(url) {
  let parsed;
  try { parsed = new URL(String(url ?? "")); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.href;
}

/// 「自动」首先问的源。对齐 Mac automaticRegistry / web eligibleMirror:
/// 只有宿主没配首选源、pnpm 自身指向 npm 官方源、且回退里有 npmmirror 时,
/// 才让宿主并行 ping 一次(宿主缓存 5 分钟),镜像更快就从镜像开始。
/// 其余一律 undefined —— 省略 registry,由宿主按它的配置问(私有源不被改道)。
export async function automaticRegistry(service) {
  try {
    const registries = await service.pluginRegistries();
    if (registries?.registry !== null
      || normalizeRegistry(registries?.resolved) !== OFFICIAL_NPM_REGISTRY
      || !(registries?.fallbackRegistries ?? []).includes(NPMMIRROR_REGISTRY)) return undefined;
    const fastest = await service.fastestRegistry();
    return fastest === NPMMIRROR_REGISTRY ? NPMMIRROR_REGISTRY : undefined;
  } catch {
    // 老宿主没有这两个端点:退回宿主配置,不挡安装。
    return undefined;
  }
}

/// 选项 → 这次安装首先问的源。返回 {registry}(undefined = 省略)或 {invalid:true}。
export async function resolveRegistryChoice({ choice, custom }, service) {
  if (choice === "official") return { registry: OFFICIAL_NPM_REGISTRY };
  if (choice === "mirror") return { registry: NPMMIRROR_REGISTRY };
  if (choice === "custom") {
    const typed = String(custom ?? "").trim();
    return REGISTRY_URL.test(typed) ? { registry: typed } : { invalid: true };
  }
  return { registry: await automaticRegistry(service) };
}

/// 一个源读作什么:null 是 pnpm 自身配置的源,两个公共源叫名字,其余显示主机名
/// (Mac pluginRegistryName)。
export function registryName(registry) {
  if (registry === null || registry === undefined) return t("plug.registryPnpm");
  const normalized = normalizeRegistry(registry);
  if (normalized === OFFICIAL_NPM_REGISTRY) return t("plug.registryOfficial");
  if (normalized === NPMMIRROR_REGISTRY) return t("plug.registryMirror");
  if (!normalized) return String(registry);
  return new URL(normalized).host;
}

/// 按顺序试过的源,拼成一行(Mac triedRegistries)。
export function registriesText(registries) {
  if (!Array.isArray(registries) || !registries.length) return "";
  return t("plug.registryTried", { list: registries.map(registryName).join(" → ") });
}
