// DSH API client:上行 HTTP POST /api/<method>(ClientRequest 信封,rpcId 关联),
// `$events/result` 回传审批/问答应答。协议:packages/host/apiproxy/src/api/rpc.ts。
import { toWebSocketUrl } from "../storage/settings.js";
import { t } from "../../shared/i18n.js";

let rpcCounter = 0;

export class DshRpcError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = "DshRpcError";
    this.code = code;
    this.details = details;
  }
}

export class DshTransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "DshTransportError";
    this.cause = cause;
  }
}

export function createApiClient(options) {
  const baseUrl = options.baseUrl;
  const fetchImpl = options.fetch || ((...args) => fetch(...args));
  const mkId = options.makeRpcId || (() => `cm-dsh-${Date.now().toString(36)}-${++rpcCounter}`);

  async function post(path, body, timeoutMs = 30000, mayRetryAuth = true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
        signal: options.makeSignal ? options.makeSignal(controller.signal) : controller.signal
      });
      if (response.status === 401 && mayRetryAuth && await options.onUnauthorized?.()) {
        clearTimeout(timer);
        return post(path, body, timeoutMs, false);
      }
      if (response.status === 403) {
        throw new DshTransportError(t("api.trustFence403"));
      }
      if (!response.ok) {
        throw new DshTransportError(`DSH HTTP ${response.status} ${path}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DshTransportError) throw error;
      if (error?.name === "AbortError") throw new DshTransportError(t("api.timeout", { path }));
      throw new DshTransportError(t("api.connectFailed", { baseUrl, message: error.message }), error);
    } finally {
      clearTimeout(timer);
    }
  }

  function parseServerResponse(envelope, expectedRpcId) {
    if (!envelope || envelope.type !== "server-response") {
      throw new DshTransportError(t("api.badEnvelope"));
    }
    if (envelope.rpcId !== expectedRpcId) {
      throw new DshTransportError(t("api.rpcIdMismatch", { expected: expectedRpcId, actual: envelope.rpcId }));
    }
    const result = envelope.result;
    // 缺 result / 缺 error 时不能裸取:那会抛出 TypeError,而 error-details 靠
    // instanceof DshRpcError / DshTransportError 分流,裸 TypeError 全落到兜底,
    // 用户看到的是一句没有意义的 JS 内部报错,而不是"信封无效"。
    if (!result || typeof result !== "object") {
      throw new DshTransportError(t("api.badEnvelopeMissingResult"));
    }
    if (!result.ok) {
      const error = result.error;
      if (!error || typeof error !== "object") {
        throw new DshRpcError("unknown", t("api.failedNoReason"));
      }
      throw new DshRpcError(error.code, error.message, error.details);
    }
    return result.value;
  }

  return Object.freeze({
    baseUrl,
    webSocketUrl(path) {
      return toWebSocketUrl(baseUrl, path);
    },
    async call(method, args = {}, timeoutMs) {
      const rpcId = mkId();
      const envelope = await post(`/api/${method}`, {
        type: "client-request",
        rpcId,
        method,
        payload: { args }
      }, timeoutMs);
      return parseServerResponse(envelope, rpcId);
    },
    // DSH 1.5 通用文件上传:字节直传宿主 session/uploadFileBinary 路由,
    // 换回 receipt(receiptId + file),由后续 session/prompt 的 file content part 消费。
    // 图片仍走 base64 内联,这里只服务工作区外、agent 读不到的非图片文件。
    async uploadFile(sessionId, file, name) {
      const query = new URLSearchParams({ sessionId });
      if (name || file?.name) query.set("name", name || file.name);
      const doUpload = () => fetchImpl(`${baseUrl}/api/session/uploadFileBinary?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
        credentials: "include"
      });
      let response = await doUpload();
      if (response.status === 401 && await options.onUnauthorized?.()) response = await doUpload();
      if (!response.ok) throw new DshTransportError(t("api.uploadFailed", { status: String(response.status) }));
      const envelope = await response.json().catch(() => null);
      if (!envelope?.ok || !envelope?.value?.receiptId) {
        throw new DshRpcError(envelope?.error?.code ?? "unknown",
          envelope?.error?.message ?? "upload failed", envelope?.error?.details);
      }
      return envelope.value;
    },
    async settleRemoteEvent(clientId, eventId, outcome) {
      const method = "$events/result";
      const rpcId = mkId();
      const envelope = await post(`/api/${method}`, {
        type: "client-request", rpcId, method,
        payload: { args: { clientId, eventId, outcome } }
      });
      if (!envelope || envelope.type !== "server-response" || envelope.rpcId !== rpcId) {
        throw new DshTransportError(t("api.badEnvelope"));
      }
      if (!envelope.result?.ok && String(envelope.result?.error?.code ?? "").endsWith("bad-request")) {
        const error = envelope.result.error;
        throw new DshRpcError(error.code, error.message, error.details);
      }
      return envelope.result?.ok === true;
    },
    parseServerResponse
  });
}
