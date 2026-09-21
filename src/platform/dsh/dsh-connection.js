// DSH 连接门面:组装 api-client + downlink + DNR 围栏规则,对上层暴露领域方法
// 与下行帧订阅。生命周期:start() 前置注册围栏规则,后端地址变更时 restart()。
import { createApiClient, DshRpcError, DshTransportError } from "./api-client.js";
import { createDownlink, DshStreamState } from "./downlink.js";
import { applyFenceRules, clearFenceRules } from "./fence-rules.js";
import { installSessionCookie } from "./session-cookie.js";
import { ensureServerRunning } from "./native-supervisor.js";

export { DshRpcError, DshTransportError, DshStreamState };

export function createDshConnection(options) {
  // 每个连接的帧订阅必须私有:若放在模块顶层,第二个连接的 dispose() 会清空
  // 第一个连接的订阅,新实例的帧还会漏给旧实例的订阅者。
  const frameListeners = new Set();
  const settings = options.settings;
  const dnr = options.dnr || (typeof chrome !== "undefined" ? chrome.declarativeNetRequest : undefined);
  let backendUrl = options.baseUrl || null;
  let api = null;
  let downlink = null;
  const subscriptions = new Map();
  // 下行流是否已经开过。不能拿 api/downlink 是否为空来推断:setBackendUrl 会在
  // 启动前就把两者建好,那时流还没开,而 `!api` 的守卫已经不成立了。
  let started = false;
  let authPromise = null;

  async function ensureAuth() {
    if (!authPromise) {
      authPromise = (async () => {
        await ensureServerRunning("web", { backendUrl });
        return installSessionCookie(backendUrl);
      })().catch((error) => {
        authPromise = null;
        throw error;
      });
    }
    return authPromise;
  }

  async function refreshAuth() {
    authPromise = null;
    return ensureAuth();
  }

  const onFrame = (frame, stream) => {
    for (const listener of frameListeners) listener(frame, stream);
  };

  async function ensureStarted() {
    if (!backendUrl) backendUrl = await settings.getBackendUrl();
    await ensureAuth();
    if (!api) {
      api = createApiClient({ baseUrl: backendUrl, fetch: options.fetch, onUnauthorized: refreshAuth });
      downlink = createDownlink({
        apiClient: api,
        onFrame,
        onStateChange: options.onStateChange,
        onGenerationReady: options.onGenerationReady,
        recoverConnection: async () => {
          await ensureServerRunning("web", { backendUrl });
          return refreshAuth();
        }
      });
      for (const sub of subscriptions.values()) downlink.subscribe(sub.streamId, sub.endpoint, sub.args);
      if (dnr) await applyFenceRules(dnr, backendUrl);
    }
    if (!started) {
      started = true;
      downlink.start();
    }
  }

  return Object.freeze({
    get baseUrl() { return backendUrl; },
    async call(method, payload, timeoutMs) {
      await ensureStarted();
      return api.call(method, payload, timeoutMs);
    },
    async uploadFile(sessionId, file, name) {
      await ensureStarted();
      return api.uploadFile(sessionId, file, name);
    },
    /// 宿主插件的普通 GET 路由(非 RPC 信封)。404 → null,见 api-client.getJson。
    async getJson(path, query, timeoutMs) {
      await ensureStarted();
      return api.getJson(path, query, timeoutMs);
    },
    async settleRemoteEvent(clientId, eventId, outcome) {
      await ensureStarted();
      return api.settleRemoteEvent(clientId, eventId, outcome);
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    subscribe(streamId, endpoint, args = {}) {
      const sub = { streamId, endpoint, args };
      subscriptions.set(streamId, sub);
      downlink?.subscribe(streamId, endpoint, args);
    },
    unsubscribe(streamId) {
      subscriptions.delete(streamId);
      downlink?.unsubscribe(streamId);
    },
    get streamState() {
      return downlink?.state ?? DshStreamState.DISCONNECTED;
    },
    // 应用层显式请求重建整条 mux 时使用；单个逻辑流 error 不应走这里，
    // 否则一个永久不可用的 endpoint 会拖着所有健康流进入重连风暴。
    forceReconnect() {
      downlink?.forceReconnect?.();
    },
    // 手动重连:立即重建(不走退避),用于用户点击重连。
    restart() {
      downlink?.restart?.();
    },
    // 后端地址变更:更新设置、重建 client、刷新 DNR 规则、重开下行流。
    async setBackendUrl(url) {
      const normalized = await settings.setBackendUrl(url);
      const hadStarted = started;
      downlink?.stop();
      backendUrl = normalized;
      authPromise = null;
      await ensureAuth();
      api = createApiClient({ baseUrl: normalized, fetch: options.fetch, onUnauthorized: refreshAuth });
      downlink = createDownlink({
        apiClient: api,
        onFrame,
        onStateChange: options.onStateChange,
        onGenerationReady: options.onGenerationReady,
        recoverConnection: async () => {
          await ensureServerRunning("web", { backendUrl });
          return refreshAuth();
        }
      });
      for (const sub of subscriptions.values()) downlink.subscribe(sub.streamId, sub.endpoint, sub.args);
      if (dnr) await applyFenceRules(dnr, normalized);
      if (hadStarted) downlink.start();
      return normalized;
    },
    async dispose() {
      downlink?.stop();
      if (dnr) await clearFenceRules(dnr).catch(() => {});
      frameListeners.clear();
      api = null;
      downlink = null;
      started = false;
      authPromise = null;
    },
    ensureStarted
  });
}
