// dsh server 的版本 / 重启 / 更新。
//
// 三个操作都由 daemon 执行(扩展不能起进程)。更新只接收受限目标 —— daemon 侧
// 不接受 pid、命令或包名,否则"重启"就成了通用 kill、"更新"成了任意装包。
//
// 版本比较用本目录 version.js 的 isUpgrade:它修过字典序比较的坑
// ("0.10.0" < "0.9.0" 会让每次跨 x.9 的发布都被判成没有新版)。
import { isUpgrade, compareVersions, isExactVersion, validateUpdateTarget, UPDATE_CHANNELS } from "./version.js";
import { HostProxyReason } from "../../platform/dsh/host-proxy-client.js";

/// 更新检查跟随的 dist-tag,与 Mac 的 DshUpdateChecker.distTags 一致。
export const UPDATE_DIST_TAGS = Object.freeze(["next", "alpha"]);
/// 目标版本的 GitHub 发布页,发布日志在那里(同 Mac 的 latestReleaseURL)。
const RELEASE_URL = "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v";

function newestOf(versions) {
  return versions.filter(isExactVersion)
    .reduce((best, v) => (best === null || compareVersions(best, v) === -1 ? v : best), null);
}

export function createServerOps({ client }) {
  const ops = {
    /// 当前版本 + 更新目标 + 是否可升级。
    ///
    /// 目标的选法对齐 Mac 的 DshUpdateChecker:不让用户挑渠道,而是取 next(rc)
    /// 与 alpha 两个 dist-tag 中**更高**的那个 —— 两条预发布线谁都可能领先
    /// (0.2.1-alpha.2 发在 alpha 时 next 还停在 0.2.0-rc.2)。
    ///
    /// 老 daemon 不回 distTags、也装不了指定版本,只能沿用它唯一会装的 latest。
    ///
    /// targetVersion 为 null 表示查不到(离线、registry 不可达)。这是正常状态,
    /// 不是错误 —— UI 不显示更新行即可。
    async version() {
      const payload = await client.serverVersion("latest");
      const current = payload?.current ?? null;
      const latest = payload?.latest ?? null;
      // An older daemon ignores request bodies. Never infer protocol support from latest.
      const updateSupported = payload?.updateSupported === true;
      const distTags = Object.fromEntries(Object.entries(payload?.distTags ?? {})
        .filter(([tag, version]) => UPDATE_CHANNELS.includes(tag) && isExactVersion(version)));
      const targetVersion = updateSupported
        ? newestOf(UPDATE_DIST_TAGS.map((tag) => distTags[tag]))
        : isExactVersion(latest) ? latest : null;
      const updatable = Boolean(current && targetVersion && isUpgrade(current, targetVersion));
      // 交给 update() 的目标:新 daemon 装确切版本;老 daemon 只认 latest。
      const updateTarget = targetVersion ? (updateSupported ? targetVersion : "latest") : null;
      return { current, latest, targetVersion, updateTarget, distTags, updateSupported, updatable,
        releaseUrl: targetVersion ? RELEASE_URL + encodeURIComponent(targetVersion) : null,
        checkFailed: targetVersion === null };
    },

    /// 重启 dsh web。返回 { stopped, started, pid, log }。
    ///
    /// started 为 false 时不抛错:进程确实被拉起了但端口没就绪,调用方需要
    /// 把日志路径显示给用户,这比一个异常更有用。
    async restart() {
      return await client.serverRestart();
    },

    /// pnpm add -g @deepseek-ai/dsh@<target>。target 是 version() 选出的那个版本。
    ///
    /// 成功后**不自动重启** —— 重启会断掉用户当前会话,由用户按下重启。
    async update(target) {
      const selected = validateUpdateTarget(target);
      // Anything but latest needs positive protocol negotiation: old daemons silently install latest.
      if (selected !== "latest") {
        const payload = await client.serverVersion(selected);
        if (payload?.updateSupported !== true) throw new Error("Updating to a pre-release requires a newer chrome-daemon");
        if (payload?.target !== selected || !isExactVersion(payload?.targetVersion)) throw new Error("DSH update target is unavailable");
      }
      const result = await client.serverUpdate(selected);
      if (result?.exitCode !== 0) {
        const stderr = String(result?.stderr ?? "").trim();
        const error = new Error(stderr || `pnpm exited with ${result?.exitCode}`);
        error.name = "ServerUpdateError";
        throw error;
      }
      return result;
    },

    /// 关掉 daemon 的整个 /host/* 面,直到它重启。
    ///
    /// 放在这里而不是让 UI 直接调 client:服务端 pane 的其余动作都经本模块,
    /// 混着两种调用风格会让"这一页能做什么"变得要看两个文件才知道。
    disableHostProxy() {
      return client.disable();
    },

    /// dsh 没用 pnpm 装时,UI 要给出可执行的下一步而不是一句失败。
    isNotPnpmInstall(error) {
      return error?.reason === HostProxyReason.NOT_PNPM;
    }
  };
  return ops;
}
