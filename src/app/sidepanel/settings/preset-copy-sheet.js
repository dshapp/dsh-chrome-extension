// 复制预设弹窗。对齐 Mac CopyPresetSheet(与 web ui-agent-preset/CopyDialog):
// 标识符 + 名称两个输入,标识符实时校验并在本地预检占用,创建中禁用,错误就地显示。
//
// 弹窗用设置页共用那块 <dialog>(settings-root 的 createSheet),所以每次异步回调
// 落 DOM 前都要用打开时拿到的 generation 校验所有权 —— 用户可能在复制期间
// 关掉它,或换开了别的 sheet。
import { t } from "../../../shared/i18n.js";
import { button, textInput, escapeHtml } from "./settings-ui.js";
import { canConfirmPresetCopy, isPresetIdOccupied, isPresetIdValid } from "../../../features/settings/preset-identifier.js";

/// 打开复制弹窗。presets 只用于本地占用预检;onDone 在成功后由调用方刷新 roster。
export function openPresetCopySheet({ sheet, from, fromName, presets, settingsService, deps, showToast, onDone }) {
  const token = sheet.open({
    title: t("pset.copyTitle", { name: fromName }),
    body: renderBody({ intro: escapeHtml(t("pset.copyIntro")) }),
    actions: button({ id: "pset-copy-cancel", label: t("set.cancel") })
      + button({ id: "pset-copy-confirm", label: t("set.create"), kind: "primary", disabled: true }),
    bind(root) {
      const idInput = root.querySelector("#pset-copy-id");
      const nameInput = root.querySelector("#pset-copy-name");
      const confirm = root.querySelector("#pset-copy-confirm");
      const taken = root.querySelector("#pset-copy-taken");
      const error = root.querySelector("#pset-copy-error");
      let copying = false;

      /// 每一次输入都重算可提交状态。占用提示只在"看起来是个合法 id 但已被用"
      /// 时显示 —— 一个还没敲完的 id 报"已被占用"是把噪音当信息。
      const sync = () => {
        const id = idInput.value.trim();
        const occupied = isPresetIdOccupied(id, presets);
        taken.hidden = !occupied || !isPresetIdValid(id);
        confirm.disabled = !canConfirmPresetCopy({ id, presets, copying })
          || !idInput.value.trim();
      };
      idInput.addEventListener("input", sync);
      nameInput.addEventListener("input", sync);
      sync();

      root.querySelector("#pset-copy-cancel").addEventListener("click", () => sheet.close(token));
      confirm.addEventListener("click", async () => {
        const id = idInput.value.trim();
        const name = nameInput.value.trim();
        copying = true;
        confirm.disabled = true;
        confirm.textContent = t("set.saving");
        error.textContent = "";
        try {
          await settingsService.presetCopy(from, id, name || undefined);
          if (!sheet.owns(token)) return;
          sheet.close(token);
          await onDone?.();
        } catch (failure) {
          copying = false;
          if (!sheet.owns(token)) return;
          // 名称可以留空(宿主会回落成标识符),所以只有标识符可能触发冲突类错误。
          error.textContent = failure?.code === "agent-preset/exists"
            ? t("pset.identifierTaken")
            : deps.formatErrorDetails(failure);
          confirm.textContent = t("set.create");
          sync();
        }
      });
      idInput.focus();
    }
  });
  return token;
}

function renderBody({ intro }) {
  return `<p class="set-sheet-text">${intro}</p>`
    + `<div class="set-sheet-field"><label class="set-sheet-label" for="pset-copy-id">`
    + `${escapeHtml(t("pset.identifier"))}</label>`
    + textInput({ id: "pset-copy-id", value: "", placeholder: "my-agent", mono: true })
    + `<div class="set-sheet-error" id="pset-copy-taken" hidden>`
    + `${escapeHtml(t("pset.identifierTaken"))}</div></div>`
    + `<div class="set-sheet-field"><label class="set-sheet-label" for="pset-copy-name">`
    + `${escapeHtml(t("pset.name"))}</label>`
    + textInput({ id: "pset-copy-name", value: "", placeholder: t("pset.namePlaceholder") })
    + `</div><div class="set-sheet-error" id="pset-copy-error"></div>`;
}
