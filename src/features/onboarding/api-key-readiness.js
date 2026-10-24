// 首次使用的第二步:dsh 已连上,但还没有任何能对话的模型提供方 —— 引导用户
// 填一把 DeepSeek 官方 API Key。判定口径逐条对齐 Mac AppModel.evaluateOnboarding
// 与 web dsh-client-ui-settings-models 的 onboardingReadiness / providerUsable:
//
// - 只要**任何一个**提供方已可用,这一步就结束(用户已经有模型可聊);
// - 都不可用时,只有官方 DeepSeek 路由(llm-deepseek 根 profile)是这一步能修的,
//   它缺席 / 未启用 / 凭证读不到 / 设置只读 / 凭证由启动环境锁定,都不弹;
// - 输入是 settings-service 的 loadProviderRows() 联结结果,与「设置 → 模型」同源,
//   不另起一套事实来源。
//
// 纯函数,不碰 DOM;弹窗在 src/app/sidepanel/api-key-onboarding.js。

export const OFFICIAL_PROVIDER = "deepseek-official";
export const OFFICIAL_SETTINGS_NS = "llm-deepseek";
/// 官方 DeepSeek API Key 的创建页(Mac DeepSeekOnboardingDialog.apiKeysURL)。
export const DEEPSEEK_API_KEYS_URL = "https://platform.deepseek.com/api_keys";
/// 官方 profile 没写 apiKeyEnv 时的兜底引用名(Mac onboardingCredentialRef 默认值)。
export const DEFAULT_CREDENTIAL_REF = "DEEPSEEK_API_KEY";

/// 某一行是否已经能对话(web providerUsable)。
///
/// 账号路由:loadProviderRows 只在账号已登录(模型目录里有非空 deepseek-account
/// 分组)时才保留这一行,所以行存在即等价于 web 的 accountAvailable === true。
export function providerUsable(row) {
  if (row?.entry?.active !== true) return false;
  if (row.entry.provider === "deepseek-account") return true;
  // profile 没命名凭证引用:靠提供方自己的认证链路(Bedrock / Vertex ADC / 无鉴权网关)。
  if (row.apiKeyEnv == null) return true;
  return row.credential?.configured === true;
}

function isOfficialRow(row) {
  return row?.entry?.provider === OFFICIAL_PROVIDER
    && row.entry.settingsNs === OFFICIAL_SETTINGS_NS
    && (row.entry.settingsPath ?? []).length === 0;
}

/**
 * 首次使用 API Key 引导的判定。
 * @param state - loadProviderRows() 的结果;null/undefined 表示读取失败。
 * @returns {{kind:"provider-ready"}|{kind:"adapter-absent"}|{kind:"unavailable",reason:string}
 *   |{kind:"credential-missing",ref:string}}
 */
export function onboardingReadiness(state) {
  if (!state) return { kind: "unavailable", reason: "load-failed" };
  const rows = state.rows ?? [];
  if (rows.some(providerUsable)) return { kind: "provider-ready" };
  const row = rows.find(isOfficialRow);
  if (!row) return { kind: "adapter-absent" };
  if (row.entry.active !== true) return { kind: "unavailable", reason: "provider-inactive" };
  if (state.credentialError || !row.credential) return { kind: "unavailable", reason: "credentials-unavailable" };
  if (state.writable !== true) return { kind: "unavailable", reason: "settings-read-only" };
  if (row.credential.writable !== true) return { kind: "unavailable", reason: "credential-read-only" };
  return { kind: "credential-missing", ref: row.apiKeyEnv || DEFAULT_CREDENTIAL_REF };
}
