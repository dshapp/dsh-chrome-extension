// 设置页里单个插件的「有新版 → 一键更新」:浏览器页(dsh-chrome-control)与移动端访问页
// (dsh-mobile-bridge)共用。对齐 Mac 的 PluginUpdateChecker。
//
// 已装版本以宿主 pluginManager/listBundles 为准 —— 它读的就是正在跑的那个 profile。
// 最新版直接问 npm registry 的 dist-tags.latest:宿主的 inspect 对已装的包一律答
// already-installed,问不出新版本。只检查从 registry 装的:link: / file: / git 装的
// 是本地开发版,"有新版"无从谈起,装回 registry 版反而会把开发版冲掉。
//
// 更新走宿主 installBundle(name@latest),保留原来的启停;已加载的包换代码只能重启,
// 宿主因此答 restart-required,交给调用方的 restart。
//
// 宿主开着 HMR 时(dsh web 默认)不许原地换版本、答 already-installed,它给的路是先
// removeBundle 再装(web 插件页的「更新」也是这么做的),两步都当场生效、不必重启;
// 新版装不上时把原版本装回去。卸载前宿主会先停用它:要是停不下来(bundle-in-use /
// stop-profile —— 典型是宿主启动后 profile 的依赖又被改过,只能重启才能换代码),
// 宿主会把它留在停用状态,这里把开关拨回去,并改成「重启服务并更新」:重启后再走一遍。
import { t } from "../../shared/i18n.js";
import { isExactVersion, isUpgrade } from "../host-proxy/version.js";
import { OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY } from "./plugin-registry.js";

/// 依次问的源:npm 官方源不通(常见于国内网络)再问 npmmirror。
export const UPDATE_REGISTRIES = Object.freeze([OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY]);
const FETCH_TIMEOUT_MS = 8000;

/// profile 里这一项是不是按 registry 版本号装的。宿主把它报成 `name@<range>`;
/// 本地路径、git、npm: 别名的 range 都带 ":" 或 "/"。
export function installedFromRegistry(bundle) {
  const source = bundle?.source;
  const prefix = `${bundle?.name}@`;
  if (typeof source !== "string" || !source.startsWith(prefix)) return false;
  const range = source.slice(prefix.length);
  return range !== "" && !/[:/]/.test(range);
}

/// registry 上 latest 指向的版本;都问不到时 null(离线是常态,不算错)。
export async function fetchLatestVersion(name, {
  fetchImpl = globalThis.fetch, registries = UPDATE_REGISTRIES, timeoutMs = FETCH_TIMEOUT_MS
} = {}) {
  const path = "-/package/" + name.replace("/", "%2f") + "/dist-tags";
  for (const registry of registries) {
    try {
      const response = await fetchImpl(registry + path, {
        headers: { accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) continue;
      const latest = (await response.json())?.latest;
      if (isExactVersion(latest)) return latest;
    } catch {
      // 换下一个源。
    }
  }
  return null;
}

/// 宿主的变更没有落地(失败或被取消)。
function failed(result) {
  return result?.application === "failed" || result?.application === "cancelled";
}

/// 卸载时这几种拒绝说明插件此刻停不下来,重启宿主后就能卸。
const BLOCKED_WHILE_RUNNING = new Set(["bundle-in-use", "stop-profile"]);

/// 失败的说法:宿主 / pnpm 的原话优先,最后才是错误码。
function reason(result) {
  return result.error?.diagnostic || result.packageResult?.output || result.error?.code || result.application;
}

/// 更新 / 安装后宿主要重启时用:经 serverOps 重启 dsh web(与服务端页的「重启服务」同一条路)。
/// 返回 true = 新服务已就绪;否则返回没重启成功的原因(字符串,说不出时为空串):
/// 旧服务可能已经停了而新服务没起来(比如 dsh 本体装坏了),界面要把原因和日志位置说出来,
/// 只说"重启不了"会让人以为什么都没发生。
export function serverRestarter(serverOps) {
  return async () => {
    if (!serverOps) return "";
    try {
      const result = await serverOps.restart();
      if (result?.started) return true;
      return result?.log ? t("plugUpd.restartNoStart", { log: result.log }) : "";
    } catch (error) {
      return String(error?.message || "");
    }
  };
}

/// @param name          插件包名。
/// @param pluginManager plugin-manager-service:读清单与装包。
/// @param restart       宿主说要重启时调用;返回 true = 重启好了,否则是没重启成功的原因。
/// @param fetchLatest   (name) => 最新版本号 | null,测试替身用。
/// @param onChange      状态变了就回调一次。
export function createPluginUpdate({ name, pluginManager, restart, fetchLatest = fetchLatestVersion, onChange } = {}) {
  const state = {
    installed: null,
    latest: null,
    enabled: true,
    updating: false,
    /// 刚由这一页更新到的版本:给一句"已更新",直到下次检查。
    updated: null,
    /// 装好了但重启不了:新版要等服务重启才加载。
    restartRequired: false,
    /// 插件正在运行、换不了:得先重启服务,下一次「更新」会先重启再装。
    restartFirst: false,
    /// 要先重启,可没重启成功:只能请用户手动重启。
    restartFailed: false,
    /// 没重启成功的原因(serverOps 的说法或新服务的日志位置),说不出时为空。
    restartError: "",
    error: ""
  };
  // 进页面的检查与更新后的检查可能交错;只认最后一次。
  let checkSeq = 0;
  const emit = () => onChange?.(state);
  const available = () => Boolean(state.installed && state.latest && isUpgrade(state.installed, state.latest));

  /// 读已装版本,再问 registry。每进一次页面调一次 —— 它要走网络,不放进轮询。
  async function check() {
    if (state.updating) return;
    const seq = ++checkSeq;
    let bundle = null;
    try {
      const bundles = await pluginManager.pluginBundles();
      bundle = (Array.isArray(bundles) ? bundles : []).find((entry) => entry?.name === name) ?? null;
    } catch {
      return; // 宿主暂时答不上(比如正在重启):保留手头的状态。
    }
    if (seq !== checkSeq) return;
    state.updated = null;
    state.restartRequired = false;
    state.restartFirst = false;
    state.restartFailed = false;
    state.restartError = "";
    state.error = "";
    if (!bundle?.installed || !installedFromRegistry(bundle) || !isExactVersion(bundle.version)) {
      state.installed = null;
      state.latest = null;
      emit();
      return;
    }
    state.installed = bundle.version;
    state.enabled = bundle.enabled !== false;
    const latest = await fetchLatest(name);
    if (seq !== checkSeq) return;
    state.latest = latest;
    emit();
  }

  async function update() {
    if (state.updating || !available()) return;
    checkSeq += 1;
    state.updating = true;
    state.error = "";
    state.updated = null;
    state.restartRequired = false;
    emit();
    if (state.restartFirst) {
      const restarted = restart ? await restart() : "";
      state.updating = false;
      if (restarted !== true) {
        state.restartFailed = true;
        state.restartError = typeof restarted === "string" ? restarted : "";
        emit();
        return;
      }
      // 重启后的宿主才是真的:重读一遍再装(它可能已经是新版了)。
      await check();
      if (!available()) { emit(); return; }
    }
    await install();
  }

  async function install() {
    const target = state.latest;
    const previous = state.installed;
    state.updating = true;
    state.restartFirst = false;
    state.restartFailed = false;
    state.restartError = "";
    emit();
    const add = (version) => pluginManager.installBundle(`${name}@${version}`, {
      requestId: "plugin-update-" + Date.now().toString(36),
      enabled: state.enabled
    });
    try {
      let result = await add(target);
      if (failed(result) && result.error?.code === "already-installed") {
        const removed = await pluginManager.removeBundle(name).catch((error) => ({ application: "failed", thrown: error }));
        if (failed(removed)) {
          // 宿主卸载前先停用了它:卸不掉就把开关拨回去,别让插件就此被关掉。
          if (state.enabled) await pluginManager.setBundleEnabled(name, true).catch(() => undefined);
          if (removed.thrown) throw removed.thrown;
          if (BLOCKED_WHILE_RUNNING.has(removed.error?.code)) state.restartFirst = true;
          else state.error = reason(removed);
          return;
        }
        // 旧版已经卸掉了:新版装不上就把原来的装回去,别让插件就此没了。
        const restore = () => add(previous).catch(() => undefined);
        result = await add(target).catch(async (error) => { await restore(); throw error; });
        if (failed(result)) await restore();
      }
      if (failed(result)) {
        state.error = reason(result);
        return;
      }
      // pnpm 已经把新版放进 profile;重读清单要等重启后的宿主,这里直接记下。
      state.installed = target;
      state.updated = target;
      if (result?.application === "restart-required") {
        const restarted = restart ? await restart() : "";
        if (restarted !== true) state.restartRequired = true;
      }
    } catch (error) {
      state.error = String(error?.message || error || "");
    } finally {
      state.updating = false;
      emit();
    }
  }

  return {
    state,
    check,
    update,
    get available() { return available(); },
    /// 这一页要不要给更新那一行:有新版、正在更新、刚更新完或失败了。
    get visible() { return available() || state.updating || Boolean(state.updated || state.error); }
  };
}