// 设置页里单个插件的「有新版 → 一键更新」:浏览器页(dsh-chrome-control)与移动端访问页
// (dsh-mobile-bridge)共用。对齐 Mac 的 PluginUpdateChecker。
//
// 全部交给宿主(0.2.2 pluginManager):listBundles 的 updatable 说这个包是不是从 registry
// 装的(link: / file: / git 装的本地开发版不提示,装回 registry 版会把开发版冲掉);
// listVersions 列出比已装版本新的版本,并标好预发布、弃用、能否当 bundle 装、是否兼容当前 DSH;
// updateBundle 换版:宿主开着 HMR 时先停用并卸掉旧版再装新版,新版装不上就把旧版装回去,
// 保留原来的启停。已加载的包换代码只能重启,宿主因此答 restart-required,交给调用方的 restart。
//
// 卸旧版时宿主会先停用它:要是停不下来(bundle-in-use / stop-profile —— 典型是宿主启动后
// profile 的依赖又被改过,只能重启才能换代码),宿主会把它留在停用状态,这里把开关拨回去,
// 并改成「重启服务并更新」:重启后再走一遍。
import { t } from "../../shared/i18n.js";
import { isExactVersion, isUpgrade } from "../host-proxy/version.js";
import { managementErrorText } from "./plugin-meta.js";

/// 宿主列出的较新版本里挑更新目标:latest 标签优先,否则最新的稳定版;
/// 必须声明 bundle、兼容当前 DSH、未弃用、不是预发布。没有可装的给 null。
export function pickUpdate(list) {
  if (list?.status !== "listed") return null;
  const usable = (Array.isArray(list.versions) ? list.versions : []).filter((entry) =>
    entry?.bundle && !entry.incompatible && !entry.deprecated && !entry.prerelease && isExactVersion(entry.version));
  const pick = usable.find((entry) => entry.tags?.includes("latest")) ?? usable[0];
  return pick ? { version: pick.version, registry: list.registry } : null;
}

/// 宿主的变更没有落地(失败或被取消)。
function failed(result) {
  return result?.application === "failed" || result?.application === "cancelled";
}

/// 卸载时这几种拒绝说明插件此刻停不下来,重启宿主后就能卸。
const BLOCKED_WHILE_RUNNING = new Set(["bundle-in-use", "stop-profile"]);

/// 失败的说法:宿主 / pnpm 的原话优先,最后才是错误码。
function reason(result) {
  return result.error?.diagnostic || result.packageResult?.output || managementErrorText(result.error) || result.application;
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
/// @param pluginManager plugin-manager-service:读清单、列版本、换版。
/// @param restart       宿主说要重启时调用;返回 true = 重启好了,否则是没重启成功的原因。
/// @param onChange      状态变了就回调一次。
export function createPluginUpdate({ name, pluginManager, restart, onChange } = {}) {
  const state = {
    installed: null,
    latest: null,
    /// 答出 latest 的源:更新从它装。
    registry: undefined,
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

  /// 读已装版本,再问宿主有哪些新版。每进一次页面调一次 —— 宿主要去问 registry,不放进轮询。
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
    if (!bundle?.installed || bundle.updatable !== true || !isExactVersion(bundle.version)) {
      state.installed = null;
      state.latest = null;
      emit();
      return;
    }
    state.installed = bundle.version;
    state.enabled = bundle.enabled !== false;
    const update = pickUpdate(await pluginManager.listVersions(name).catch(() => null));
    if (seq !== checkSeq) return;
    state.latest = update?.version ?? null;
    state.registry = update?.registry;
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
    state.updating = true;
    state.restartFirst = false;
    state.restartFailed = false;
    state.restartError = "";
    emit();
    try {
      const outcome = await pluginManager.updateBundle(name, target, {
        registry: state.registry,
        requestId: "plugin-update-" + Date.now().toString(36)
      });
      const result = outcome?.result;
      if (failed(result)) {
        if (outcome.step === "remove") {
          // 宿主卸载前先停用了它:卸不掉就把开关拨回去,别让插件就此被关掉。
          if (state.enabled) await pluginManager.setBundleEnabled(name, true).catch(() => undefined);
          if (BLOCKED_WHILE_RUNNING.has(result.error?.code)) { state.restartFirst = true; return; }
        }
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
