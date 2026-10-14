// dsh server 的版本 / 重启 / 更新。
//
// 三个操作都由 daemon 执行(扩展不能起进程)。更新只接收受限目标 —— daemon 侧
// 不接受 pid、命令或包名,否则"重启"就成了通用 kill、"更新"成了任意装包。
//
// 版本比较用本目录 version.js 的 isUpgrade:它修过字典序比较的坑
// ("0.10.0" < "0.9.0" 会让每次跨 x.9 的发布都被判成没有新版)。
import { isUpgrade, compareVersions, isExactVersion, validateUpdateTarget } from "./version.js";
import { HostProxyReason } from "../../platform/dsh/host-proxy-client.js";

export function createServerOps({ client }) {
  const ops = {
    /// 当前版本 + 远端最新版 + 是否可升级。
    ///
    /// latest 为 null 表示查不到(离线、registry 不可达)。这是正常状态,
    /// 不是错误 —— UI 显示"无法检查"即可。
    async version(target) {
      const selected = validateUpdateTarget(target);
      const payload = await client.serverVersion(target);
      const current = payload?.current ?? null;
      const latest = payload?.latest ?? null;
      // An older daemon ignores request bodies. Never infer channel support from latest.
      const updateSupported = payload?.updateSupported === true;
      const distTags = Object.fromEntries(Object.entries(payload?.distTags ?? {})
        .filter(([tag, version]) => ["latest", "next", "alpha"].includes(tag) && isExactVersion(version)));
      const targetVersion = updateSupported
        ? (payload?.target === selected && isExactVersion(payload?.targetVersion) ? payload.targetVersion : null)
        : selected === "latest" && isExactVersion(latest) ? latest : null;
      const updatable = Boolean(current && targetVersion && isUpgrade(current, targetVersion));
      return { current, latest, target: selected, targetVersion, distTags, updateSupported, updatable,
        downgrade: compareVersions(current, targetVersion) === 1, checkFailed: targetVersion === null };
    },

    /// 重启 dsh web。返回 { stopped, started, pid, log }。
    ///
    /// started 为 false 时不抛错:进程确实被拉起了但端口没就绪,调用方需要
    /// 把日志路径显示给用户,这比一个异常更有用。
    async restart() {
      return await client.serverRestart();
    },

    /// pnpm add -g @deepseek-ai/dsh@latest。
    ///
    /// 成功后**不自动重启** —— 重启会断掉用户当前会话,由 UI 询问。
    async update(target) {
      const selected = validateUpdateTarget(target);
      // Non-default targets require positive protocol negotiation: old daemons silently install latest.
      if (selected !== "latest") {
        const version = await ops.version(selected);
        if (!version.updateSupported) throw new Error("DSH update channels require a newer chrome-daemon");
        if (!version.targetVersion) throw new Error("DSH update target is unavailable");
      }
      const result = await client.serverUpdate(target);
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
