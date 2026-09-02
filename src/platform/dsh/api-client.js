// DSH API client:上行 HTTP POST /api/<method>(ClientRequest 信封,rpcId 关联),
// /api/respond 回传审批/问答应答。协议:packages/host/apiproxy/src/api/rpc.ts。
import { toWebSocketUrl } from "../storage/settings.js";

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

  async function post(path, body, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options.makeSignal ? options.makeSignal(controller.signal) : controller.signal
      });
      if (response.status === 403) {
        throw new DshTransportError("请求被 DSH 信任围栏拒绝(403):请确认 dsh web 正在运行且 DNR 规则生效");
      }
      if (!response.ok) {
        throw new DshTransportError(`DSH HTTP ${response.status} ${path}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DshTransportError) throw error;
      if (error?.name === "AbortError") throw new DshTransportError(`请求超时: ${path}`);
      throw new DshTransportError(`无法连接 DSH 后端 ${baseUrl}: ${error.message}`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  function parseServerResponse(envelope, expectedRpcId) {
    if (!envelope || envelope.type !== "server-response") {
      throw new DshTransportError("DSH 响应信封无效");
    }
    if (envelope.rpcId !== expectedRpcId) {
      throw new DshTransportError(`rpcId 不匹配: 期望 ${expectedRpcId}, 收到 ${envelope.rpcId}`);
    }
    const result = envelope.result;
    // 缺 result / 缺 error 时不能裸取:那会抛出 TypeError,而 error-details 靠
    // instanceof DshRpcError / DshTransportError 分流,裸 TypeError 全落到兜底,
    // 用户看到的是一句没有意义的 JS 内部报错,而不是"信封无效"。
    if (!result || typeof result !== "object") {
      throw new DshTransportError("DSH 响应信封无效:缺少 result");
    }
    if (!result.ok) {
      const error = result.error;
      if (!error || typeof error !== "object") {
        throw new DshRpcError("unknown", "DSH 返回了失败但没有给出原因");
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
    async call(method, payload = {}, timeoutMs) {
      const rpcId = mkId();
      const envelope = await post(`/api/${method}`, {
        type: "client-request",
        rpcId,
        method,
        payload
      }, timeoutMs);
      return parseServerResponse(envelope, rpcId);
    },
    // 审批/问答应答:ClientResponse 信封,回显下行帧的 rpcId。
    // 返回 RpcReceipt:{accepted:true} | {accepted:false, reason}。
    async respond(rpcId, result) {
      const receipt = await post("/api/respond", { type: "client-response", rpcId, result });
      return receipt && typeof receipt === "object" ? receipt : { accepted: Boolean(receipt) };
    },
    parseServerResponse
  });
}
