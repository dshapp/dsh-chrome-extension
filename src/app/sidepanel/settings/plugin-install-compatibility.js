import { t } from "../../../shared/i18n.js";
import { notice, button, escapeHtml } from "./settings-ui.js";
// Installation rolled back: do not silently install after accepting a risk.
export function createInstallCompatibility({ settingsService, onChange }) {
  let incompatible = [], accepted = false, busy = false, error = null;
  return {
    set(result) { incompatible = result?.error?.incompatible ?? result?.packageResult?.incompatible ?? []; accepted = false; error = null; },
    render() {
      if (!incompatible.length) return error ? notice(error, "muted") : "";
      return incompatible.map(item => '<div class="set-sheet-text">' + escapeHtml(item.name + "@" + item.version) + " · " + escapeHtml(item.runtimeVersion)
        + '<pre class="set-code">' + escapeHtml(JSON.stringify(item.peers, null, 2)) + '</pre></div>').join("")
        + notice(t("plug.versionRisk")) + '<label><input id="plug-install-risk" type="checkbox"' + (accepted ? " checked" : "") + (busy ? " disabled" : "") + ' /> ' + escapeHtml(t("plug.acceptVersionRisk")) + '</label>'
        + button({ id: "plug-install-exempt", label: t("plug.allowVersion"), kind: "danger", disabled: !accepted || busy }) + (error ? notice(error) : "");
    },
    bind(root) {
      root.querySelector("#plug-install-risk")?.addEventListener("change", event => { accepted = event.target.checked; onChange(); });
      root.querySelector("#plug-install-exempt")?.addEventListener("click", async () => {
        if (!accepted || busy) return;
        busy = true; onChange();
        try {
          for (const item of incompatible) {
            const result = await settingsService.setVersionExemption(item.name + "@" + item.version, item.runtimeVersion, true, true);
            if (result?.application === "failed") throw new Error(result.error?.diagnostic ?? result.error?.code);
          }
          incompatible = []; accepted = false; error = t("plug.exemptionSavedRetry");
        } catch (cause) { error = cause?.message ?? String(cause); }
        finally { busy = false; onChange(); }
      });
    }
  };
}
