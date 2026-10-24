// 首次使用 API Key 引导的文案(中英),逐字对齐 Mac L10n+Strings 的 onboarding* 条目
// (它又对齐 web ui-settings-models 的 onboarding 文案)。并进 i18n 总表的做法同 setup-messages。

export const API_KEY_ONBOARDING_MESSAGES = Object.freeze({
  en: Object.freeze({
    "keyOnboarding.title": "Add an API key to get started",
    "keyOnboarding.descPrefix": "Configure the ",
    "keyOnboarding.descLink": "official DeepSeek provider",
    "keyOnboarding.descSuffix": " to start building.",
    "keyOnboarding.keyLabel": "API key",
    "keyOnboarding.placeholder": "Enter your API key",
    "keyOnboarding.other": "Configure another provider",
    "keyOnboarding.save": "Save and continue",
    "keyOnboarding.saving": "Saving…",
    "keyOnboarding.required": "Enter an API key to continue.",
    "keyOnboarding.illegal": "This API key is not in a valid format. Please check it."
  }),
  zh: Object.freeze({
    "keyOnboarding.title": "添加一个 API Key 开始使用",
    "keyOnboarding.descPrefix": "配置 ",
    "keyOnboarding.descLink": "DeepSeek 官方模型",
    "keyOnboarding.descSuffix": "，即可开始使用。",
    "keyOnboarding.keyLabel": "API 密钥",
    "keyOnboarding.placeholder": "输入 API 密钥",
    "keyOnboarding.other": "配置其他模型提供商",
    "keyOnboarding.save": "保存并继续",
    "keyOnboarding.saving": "保存中…",
    "keyOnboarding.required": "请输入 API 密钥后继续。",
    "keyOnboarding.illegal": "该 API 密钥格式错误，请检查。"
  })
});
