// 首次使用的 API Key 弹窗。对齐 Mac DeepSeekOnboardingDialog:
//
// - 只写的密钥框 + 与设置页同一套粘贴校验(apiKeyFailure:只含空白 = 必填未填;
//   "KEY=value" 整行、成对引号包裹、非可打印 ASCII = 格式错误);
// - 左边「配置其他模型提供商」把用户交给「设置 → 模型」,用别家提供方的用户
//   不会被困在一个只认 DeepSeek 的弹窗里;右边「保存并继续」写凭证后关闭;
// - 弹窗吞掉隐式关闭:Esc 等价于左边那个按钮(Mac .keyboardShortcut(.cancelAction)),
//   点遮罩不关 —— 这一步要么填 key,要么去配别的提供方;
// - 是否弹出由 onboardingReadiness 判定,读的是与模型设置页同源的联结,
//   读取过程中什么都不画,已配置的用户不会看到弹窗闪一下。
import { t } from "../../shared/i18n.js";
import { apiKeyFailure } from "../../features/settings/settings-service.js";
import { onboardingReadiness, DEEPSEEK_API_KEYS_URL } from "../../features/onboarding/api-key-readiness.js";
import { secretInput, bindSecretToggles, button, escapeHtml } from "./settings/settings-ui.js";

const KEY_FAILURE_TEXT = { blank: "keyOnboarding.required", illegalCharacters: "keyOnboarding.illegal" };

export function createApiKeyOnboarding({ dialog, settingsService, formatError, onConfigureOther, onSaved }) {
  let ref = null;
  let draft = "";
  let revealed = false;
  let saving = false;
  let failureText = null;
  let evaluating = null;

  const isOpen = () => Boolean(dialog?.open);

  function keyFailureText() {
    const kind = apiKeyFailure(draft);
    return kind ? t(KEY_FAILURE_TEXT[kind]) : null;
  }

  function canSubmit() {
    return !saving && Boolean(draft.trim()) && !keyFailureText();
  }

  function render() {
    dialog.innerHTML = '<form method="dialog" class="key-onb" novalidate>'
      + '<div class="key-onb-head">'
      + '<h2 id="key-onb-title">' + escapeHtml(t("keyOnboarding.title")) + "</h2>"
      + '<p class="key-onb-desc">' + escapeHtml(t("keyOnboarding.descPrefix"))
      + '<a id="key-onb-link" href="' + escapeHtml(DEEPSEEK_API_KEYS_URL) + '" target="_blank" rel="noopener noreferrer">'
      + escapeHtml(t("keyOnboarding.descLink")) + "</a>"
      + escapeHtml(t("keyOnboarding.descSuffix")) + "</p>"
      + "</div>"
      + '<div class="key-onb-field">'
      + '<label class="key-onb-label" for="key-onb-input">' + escapeHtml(t("keyOnboarding.keyLabel")) + "</label>"
      + secretInput({ id: "key-onb-input", value: draft, revealed, placeholder: t("keyOnboarding.placeholder"), disabled: saving })
      + '<div class="key-onb-error" id="key-onb-error" role="alert"></div>'
      + "</div>"
      + '<div class="key-onb-actions">'
      + button({ id: "key-onb-other", label: t("keyOnboarding.other"), kind: "ghost", disabled: saving })
      + '<span class="set-spacer"></span>'
      + button({ id: "key-onb-save", label: t(saving ? "keyOnboarding.saving" : "keyOnboarding.save"), kind: "primary", disabled: !canSubmit() })
      + "</div></form>";
    bind();
    sync();
  }

  /// 只更新错误文字与按钮可用态,不重画输入框 —— 重画会打断输入与输入法组字。
  function sync() {
    const error = dialog.querySelector("#key-onb-error");
    if (error) error.textContent = keyFailureText() ?? failureText ?? "";
    const save = dialog.querySelector("#key-onb-save");
    if (save) {
      save.disabled = !canSubmit();
      save.textContent = t(saving ? "keyOnboarding.saving" : "keyOnboarding.save");
    }
    const other = dialog.querySelector("#key-onb-other");
    if (other) other.disabled = saving;
    const input = dialog.querySelector("#key-onb-input");
    if (input) {
      input.disabled = saving;
      input.setAttribute("aria-invalid", String(Boolean(keyFailureText() || failureText)));
    }
  }

  function bind() {
    const input = dialog.querySelector("#key-onb-input");
    input?.setAttribute("aria-describedby", "key-onb-error");
    input?.addEventListener("input", (event) => {
      draft = event.target.value;
      failureText = null;
      sync();
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void save();
    });
    bindSecretToggles(dialog, (_id, next) => { revealed = next; });
    dialog.querySelector("#key-onb-save")?.addEventListener("click", () => { void save(); });
    dialog.querySelector("#key-onb-other")?.addEventListener("click", configureOther);
  }

  function configureOther() {
    if (saving) return;
    close();
    onConfigureOther?.();
  }

  async function save() {
    if (!canSubmit() || !ref) return;
    saving = true; failureText = null; sync();
    try {
      await settingsService.setCredential(ref, draft.trim());
      saving = false;
      close();
      onSaved?.();
    } catch (error) {
      saving = false;
      failureText = formatError ? formatError(error) : (error?.message ?? String(error));
      sync();
      dialog.querySelector("#key-onb-input")?.focus();
    }
  }

  function show(credentialRef) {
    ref = credentialRef;
    draft = ""; revealed = false; saving = false; failureText = null;
    render();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("#key-onb-input")?.focus();
  }

  function close() {
    if (dialog.open) dialog.close();
    dialog.innerHTML = "";
    draft = "";
  }

  // Esc:吞掉 <dialog> 的默认关闭,改走「配置其他模型提供商」(Mac cancelAction)。
  dialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    configureOther();
  });

  return {
    get open() { return isOpen(); },
    /// 读一次提供方联结,只有确实缺 key 且能写时才弹。并发调用合并成一次。
    /// 返回判定结果,便于调用方/测试观察;读失败按 unavailable 处理,从不抛。
    evaluate() {
      if (!dialog) return Promise.resolve({ kind: "unavailable", reason: "no-dialog" });
      evaluating ||= (async () => {
        let state = null;
        try { state = await settingsService.loadProviderRows(); } catch { state = null; }
        const readiness = onboardingReadiness(state);
        if (readiness.kind === "credential-missing") {
          if (!isOpen()) show(readiness.ref);
        } else if (isOpen() && !saving) {
          // 别处(Mac 端 / 设置页)已经配好:不再拦着用户。
          close();
        }
        return readiness;
      })().finally(() => { evaluating = null; });
      return evaluating;
    },
    /// 语言切换:弹窗开着就按新语言重画,输入的内容与可见态保留。
    relabel() {
      if (!isOpen()) return;
      const focused = dialog.ownerDocument.activeElement?.id === "key-onb-input";
      render();
      if (focused) dialog.querySelector("#key-onb-input")?.focus();
    },
    close
  };
}
