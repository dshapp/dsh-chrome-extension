// DSH 后端可达性围栏绕行规则:扩展请求携带 chrome-extension:// Origin 与
// Sec-Fetch-Site: cross-site,均会被 api-request-trust 拒绝。用 declarativeNetRequest
// 动态规则对后端地址 remove 这两个请求头(Host 为 loopback 本身即可信)。
// 规则 id 固定,后端地址变更时整体替换。
//
// 规则必须**只命中扩展自己发起的请求**:DNR 的 modifyHeaders 作用于浏览器里所有
// 匹配该 URL 的请求,并不区分发起方。不限定 initiatorDomains 时,任何一个普通
// 网页对后端地址的 fetch/XHR 也会被摘掉 origin 与 sec-fetch-site,在宿主
// api-request-trust 眼里就成了"可信请求" —— 而那正是这道围栏要拦的东西。
//
// 扩展页与 service worker 的 initiator 就是扩展 id,普通网页是页面所在域,所以拿
// 扩展 id 做白名单正好把规则收在扩展自己身上(已在浏览器里用 testMatchOutcome
// 实测:扩展页/worker 命中,普通网页与其它扩展不命中)。

const RULE_ID = 9001;
const HEADER_NAMES = ["origin", "sec-fetch-site"];

function buildRules(requestFilter) {
  return [{
    id: RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: HEADER_NAMES.map((header) => ({ header, operation: "remove" }))
    },
    condition: requestFilter
  }];
}

/// 规整 initiatorDomains:去空、去重;结果为空视为"没给",返回 undefined。
function normalizeInitiatorDomains(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  for (const entry of list) {
    const domain = typeof entry === "string" ? entry.trim() : "";
    if (domain) seen.add(domain);
  }
  return seen.size ? [...seen] : undefined;
}

/**
 * 后端地址 → 动态规则。
 * @param {string} backendUrl 后端地址(如 http://127.0.0.1:3080)。
 * @param {{extensionId?: string, initiatorDomains?: string[]|string}} [options]
 *   扩展 id 或显式 initiatorDomains;给了就只命中这些发起方。
 */
export function rulesForBackendUrl(backendUrl, options = {}) {
  const parsed = new URL(backendUrl);
  // requestDomains 约束主机;端口无法在 condition 中表达(DNR 无 ports 字段),
  // 用 regexFilter 匹配 authority(含可选端口),避免误伤同主机其他端口。
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const isDefaultPort = String(port) === (parsed.protocol === "https:" ? "443" : "80");
  const escapedHost = parsed.hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const authority = isDefaultPort
    ? `${escapedHost}(?::\\d+)?`
    : `${escapedHost}:${parsed.port}`;
  const initiatorDomains = normalizeInitiatorDomains(options.initiatorDomains ?? options.extensionId);
  return buildRules({
    // ws/wss 也要覆盖:规则声明了 websocket,而 WebSocket 的 URL 是 ws:// 或
    // wss:// —— ^https?:// 一个都匹配不到,那条声明等于空转(浏览器实测:
    // ws:// 地址不匹配 ^https?://,匹配 ^wss?://)。
    regexFilter: `^(?:https?|wss?)://${authority}/`,
    resourceTypes: ["xmlhttprequest", "websocket"],
    ...(initiatorDomains ? { initiatorDomains } : {})
  });
}

/// 当前扩展 id。拿不到(非扩展环境 / 极老版本)返回 undefined —— 此时规则退回
/// 不加白名单的旧行为,宁可少一层收紧也不要让扩展自己连不上后端。
function currentExtensionId() {
  const runtime = typeof chrome !== "undefined" ? chrome.runtime : undefined;
  return typeof runtime?.id === "string" && runtime.id ? runtime.id : undefined;
}

/**
 * 注册/更新动态规则。dnr 为 chrome.declarativeNetRequest;测试注入 fake。
 *
 * 未显式给 extensionId/initiatorDomains 时,自动取 chrome.runtime.id 作为白名单 ——
 * 白名单是安全相关默认值,不能依赖每个调用点都记得传。
 */
export async function applyFenceRules(dnr, backendUrl, options = {}) {
  await dnr.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: rulesForBackendUrl(backendUrl, {
      initiatorDomains: options.initiatorDomains ?? options.extensionId ?? currentExtensionId()
    })
  });
  return RULE_ID;
}

export async function clearFenceRules(dnr) {
  await dnr.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules: [] });
}

export const FENCE_RULE_ID = RULE_ID;
export const FENCE_REMOVED_HEADERS = HEADER_NAMES;
