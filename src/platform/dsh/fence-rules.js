// DSH 后端可达性围栏绕行规则:扩展请求携带 chrome-extension:// Origin 与
// Sec-Fetch-Site: cross-site,均会被 api-request-trust 拒绝。用 declarativeNetRequest
// 动态规则对后端地址 remove 这两个请求头(Host 为 loopback 本身即可信)。
// 规则 id 固定,后端地址变更时整体替换。

const RULE_ID = 9001;
const HEADER_NAMES = ["origin", "sec-fetch-site"];

function partitionKeyFromOrigin(origin) {
  // chrome-extension 页面发起的请求带扩展 Origin;DNR 规则只应命中扩展自己的请求,
  // 不能影响用户在普通网页里访问同域资源。
  return origin?.startsWith("chrome-extension://") ? origin : undefined;
}

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

export function rulesForBackendUrl(backendUrl) {
  const parsed = new URL(backendUrl);
  // requestDomains 约束主机;端口无法在 condition 中表达(DNR 无 ports 字段),
  // 用 regexFilter 匹配 authority(含可选端口),避免误伤同主机其他端口。
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const isDefaultPort = String(port) === (parsed.protocol === "https:" ? "443" : "80");
  const escapedHost = parsed.hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const authority = isDefaultPort
    ? `${escapedHost}(?::\\d+)?`
    : `${escapedHost}:${parsed.port}`;
  return buildRules({
    regexFilter: `^https?://${authority}/`,
    resourceTypes: ["xmlhttprequest", "websocket"]
  });
}

// 注册/更新动态规则。dnr 为 chrome.declarativeNetRequest;测试注入 fake。
export async function applyFenceRules(dnr, backendUrl) {
  await dnr.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: rulesForBackendUrl(backendUrl)
  });
  return RULE_ID;
}

export async function clearFenceRules(dnr) {
  await dnr.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules: [] });
}

export const FENCE_RULE_ID = RULE_ID;
export const FENCE_REMOVED_HEADERS = HEADER_NAMES;
