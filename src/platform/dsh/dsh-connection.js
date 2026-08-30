// DSH 连接门面:组装 api-client + downlink + DNR 围栏规则,对上层暴露领域方法
// 与下行帧订阅。生命周期:start() 前置注册围栏规则,后端地址变更时 restart()。
import { createApiClient, DshRpcError, DshTransportError } from "./api-client.js";
import { createDownlink, DshStreamState } from "./downlink.js";
import { applyFenceRules, clearFenceRules } from "./fence-rules.js";

export { DshRpcError, DshTransportError, DshStreamState };

const frameListeners = new Set();

export function createDshConnection(options) {
  const settings = options.settings;
  const dnr = options.dnr || (typeof chrome !== "undefined" ? chrome.declarativeNetRequest : undefined);
  let backendUrl = options.baseUrl || null;
  let api = null;
  let downlink = null;

  const onFrame = (frame, stream) => {
    for (const listener of frameListeners) listener(frame, stream);
  };

  async function ensureStarted() {
    if (!backendUrl) backendUrl = await settings.getBackendUrl();
    if (!api) {
      api = createApiClient({ baseUrl: backendUrl, fetch: options.fetch });
      downlink = createDownlink({
        apiClient: api,
        onFrame,
        onStateChange: options.onStateChange,
        onGenerationReady: options.onGenerationReady
      });
      if (dnr) await applyFenceRules(dnr, backendUrl);
      downlink.start();
    }
  }

  return Object.freeze({
    get baseUrl() { return backendUrl; },
    async call(method, payload, timeoutMs) {
      await ensureStarted();
      return api.call(method, payload, timeoutMs);
    },
    async respond(rpcId, result) {
      await ensureStarted();
      return api.respond(rpcId, result);
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    get streamState() {
      return downlink?.state ?? DshStreamState.DISCONNECTED;
    },
    // 应用层请求重建连接(stream/error 帧):委托给 downlink 的退避重连。
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
      const hadStarted = downlink !== null;
      downlink?.stop();
      backendUrl = normalized;
      api = createApiClient({ baseUrl: normalized, fetch: options.fetch });
      downlink = createDownlink({
        apiClient: api,
        onFrame,
        onStateChange: options.onStateChange,
        onGenerationReady: options.onGenerationReady
      });
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
    },
    ensureStarted
  });
}
