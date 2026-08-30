// 把 DshRpcError / DshTransportError / 原生 Error 统一格式化为用户可读文案。
import { DshRpcError, DshTransportError } from "../platform/dsh/api-client.js";
import { t } from "./i18n.js";

export function formatErrorDetails(error) {
  if (!error) return t("error.rpc", { code: "unknown", message: "" });
  if (error instanceof DshRpcError) {
    const detail = error.details && typeof error.details === "object"
      ? ` ${safeJson(error.details)}`
      : "";
    return t("error.rpc", { code: error.code, message: error.message }) + detail;
  }
  if (error instanceof DshTransportError || error?.name === "DshTransportError") {
    return t("error.transport", { message: error.message });
  }
  return error.message || String(error);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
