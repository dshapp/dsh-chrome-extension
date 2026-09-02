// 宿主代理客户端:扩展访问 daemon `/host/*` 的唯一出口。
//
// 与 api-client.js 的关系:那个走 dsh web 的 /api/<method>(JSON-RPC 信封),
// 这个走 chrome-daemon 固定端口上的普通 REST。两者协议不同、宿主不同、失败
// 模式也不同,所以不复用编解码 —— 合并只会让两边的错误分层互相污染。
//
// 没有令牌。放行只靠 daemon 侧比对 Origin 是否精确等于本扩展(daemon 的
// host_guard.rs)。因此这里不读 chrome.storage、不发 native message、也没有
// 401 重试逻辑;若将来加回令牌,改动应集中在这个文件。
//
// 失败分层是本模块存在的主要理由:调用方需要区分「这台机器没这功能」与
// 「这次操作失败了」,前者要静默隐藏 UI,后者要把宿主的原始报错显示出来。
import { t } from "../../shared/i18n.js";

/// daemon 的固定端口。与 background.js 的 DEFAULT_BRIDGE_WS_URL 同一个 daemon。
const DEFAULT_BASE_URL = "http://127.0.0.1:37086";

/// 只读命令很快;装包与重启要等子进程,给足预算。
const DEFAULT_TIMEOUT_MS = 35000;
const LONG_TIMEOUT_MS = 200000;

/// 失败原因。UI 按这个分流,不靠解析错误文案。
export const HostProxyReason = Object.freeze({
  /// 这台机器上没有这个能力:daemon 太老(404)、连不上、或没装。
  /// 调用方应当整块隐藏,而不是显示一个报错。
  UNSUPPORTED: "unsupported",
  /// daemon 在跑,但拒绝了我们(Origin 不符,或用户按了总开关)。
  FORBIDDEN: "forbidden",
  /// 请求本身不合法(白名单外的命令、越界的 cwd 等)。
  INVALID: "invalid",
  /// 同类操作正在进行(重启/更新的单飞锁)。
  BUSY: "busy",
  /// dsh 不是用 pnpm 装的,重启/更新无从下手。
  NOT_PNPM: "dsh-not-installed-via-pnpm",
  /// daemon 内部错误或子进程超时。
  FAILED: "failed"
});

export class HostProxyError extends Error {
  constructor(reason, message, status) {
    super(message || reason);
    this.name = "HostProxyError";
    this.reason = reason;
    this.status = status ?? null;
  }

  /// 「此部署没有这个能力」—— 调用方据此隐藏 UI 而不是报错。
  get isUnsupported() {
    return this.reason === HostProxyReason.UNSUPPORTED;
  }
}

/// HTTP 状态 → 失败原因。
///
/// 404 归入 unsupported 而不是错误:老 daemon 根本没有 /host/* 路由,这是
/// 版本问题,重试永远不会好,所以不能让 UI 显示成一次失败。
function reasonForStatus(status) {
  if (status === 404) return HostProxyReason.UNSUPPORTED;
  if (status === 403) return HostProxyReason.FORBIDDEN;
  if (status === 400) return HostProxyReason.INVALID;
  if (status === 409) return HostProxyReason.BUSY;
  return HostProxyReason.FAILED;
}

export function createHostProxyClient(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = options.fetch || ((...args) => fetch(...args));

  async function request(path, { method = "POST", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: method === "GET" ? undefined : { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
        signal: controller.signal
      });
    } catch (error) {
      // 连不上 daemon 与超时都归为 unsupported:两者在 UI 上的正确反应相同 ——
      // 不是"操作失败了",而是"现在用不了这个功能"。
      const message = error?.name === "AbortError" ? t("host.errTimeout") : t("host.errUnreachable");
      throw new HostProxyError(HostProxyReason.UNSUPPORTED, message, null);
    } finally {
      clearTimeout(timer);
    }

    // 先读文本再解析:daemon 的错误体是 JSON,但代理层/框架的错误未必是,
    // 直接 .json() 会把一个 502 变成难以理解的 SyntaxError。
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const reason = payload?.reason === HostProxyReason.NOT_PNPM
        ? HostProxyReason.NOT_PNPM
        : reasonForStatus(response.status);
      throw new HostProxyError(reason, payload?.error || `HTTP ${response.status}`, response.status);
    }
    return payload ?? {};
  }

  return {
    /// daemon 支持哪些宿主能力。失败即视为不支持。
    ///
    /// 用 POST 而非 GET,不是为了和其它路由对称:实测 Chrome 对扩展页发出的
    /// 简单 GET **不带 Origin 头**,而 daemon 的放行完全依赖 Origin —— 用 GET
    /// 探测会被自己的守卫拒掉(403 origin required)。POST + application/json
    /// 是预检请求,Chrome 必定带上 Origin。
    capabilities() {
      return request("/host/capabilities", {});
    },

    /// 跑一条白名单内的 git 命令。
    ///
    /// 子进程非零退出**不抛错**:那是 git 自己的失败,调用方要拿 stderr 展示给
    /// 用户。只有"没跑成"才抛。
    git(cwd, args, { timeoutMs } = {}) {
      return request("/host/git", { body: { cwd, args }, timeoutMs });
    },

    plugin(action, name, { timeoutMs } = {}) {
      const body = name ? { action, name } : { action };
      const readOnly = action === "list" || action === "outdated";
      return request("/host/plugin", { body, timeoutMs: timeoutMs ?? (readOnly ? DEFAULT_TIMEOUT_MS : LONG_TIMEOUT_MS) });
    },

    serverVersion() {
      return request("/host/server/version", { timeoutMs: 45000 });
    },

    serverRestart() {
      return request("/host/server/restart", { timeoutMs: LONG_TIMEOUT_MS });
    },

    serverUpdate() {
      return request("/host/server/update", { timeoutMs: LONG_TIMEOUT_MS });
    },

    /// 关掉宿主代理,直到 daemon 重启。用户的止损开关。
    disable() {
      return request("/host/disable", {});
    }
  };
}
