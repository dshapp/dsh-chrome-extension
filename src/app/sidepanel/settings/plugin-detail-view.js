import { t } from "../../../shared/i18n.js";
import { bundleText, entryText } from "../../../features/settings/plugin-meta.js";
import { section, row, button, toggle, tag, notice, escapeHtml, chevron, backLink, groupHeader, bindClickableRows } from "./settings-ui.js";
import { packageArtwork } from "./plugin-artwork.js";
import { lucideIconSvg } from "../../../features/chat/file-icons.js";

const PHASE_KIND = { active: "ok", failed: "err", pending: "busy", loading: "busy", unloading: "busy" };
const PHASE_TEXT = { active: "inv.active", failed: "inv.failed", pending: "inv.pending", loading: "inv.loadingPhase", unloading: "inv.unloading" };
function phaseStatus(phase) {
  const label = phase ? (PHASE_TEXT[phase] ? t(PHASE_TEXT[phase]) : phase) : t("inv.unobserved");
  return `<span class="set-status ${PHASE_KIND[phase] ?? "muted"}"><i aria-hidden="true"></i>${escapeHtml(label)}</span>`;
}
function readOnlyText(status) {
  return status === "management-required" ? t("plug.readOnlyManagement")
    : status === "unaddressable" ? t("plug.readOnlyUnaddressable") : status;
}
export function updateAvailable(pkg) {
  if (!pkg.installed || pkg.availability === "installation" || !pkg.installTarget) return false;
  const linked = pkg.installTarget.spec.startsWith("link:") || pkg.source?.startsWith("link:");
  return pkg.version !== pkg.installTarget.version || Boolean(linked && pkg.source !== pkg.installTarget.spec);
}
export function bundleRows(pkg, entries) {
  return (pkg.rows ?? []).map(item => {
    const matches = entries.filter(entry => entry.entryId === item.entryId);
    const entry = item.entryId && matches.length === 1 ? matches[0] : null;
    return { ...item, entry, enabled: entry?.enabled === true,
      readOnlyReason: entry?.readOnlyReason ?? (!entry ? "unaddressable" : null) };
  });
}
export function detailSubject(pkg, rows, selected) {
  const ref = { name: pkg.name, version: pkg.version, installed: pkg.installed,
    availability: pkg.availability, official: pkg.official === true, enabled: pkg.enabled,
    rows: rows.map(({ rowId, moduleName, enabled }) => ({ rowId, moduleName, enabled })) };
  return selected ? { kind: "row", pkg: ref, row: { rowId: selected.rowId, moduleName: selected.moduleName, enabled: selected.enabled } }
    : { kind: "bundle", pkg: ref };
}
// Slots are explicit LOCAL adapter callbacks. Remote React/plugin scripts are never
// evaluated here; callers supply trusted {html, bind(root)} contributions.
export function createPluginDetailView({ settingsService, sheet, deps, schemaConfig, renderSlot, onChange, onBack, onOpenRow, onEnable, onInstall, onRemove }) {
  let target = null, exemptions = {}, exemptionWarnings = [], exemptionsError = null;
  let loadingExemptions = false, disposed = false;
  const busy = new Set(), errors = new Map();
  const contributions = [];
  function slot(name, subject, key) {
    const ns = subject.kind === "row" ? subject.row.rowId : null;
    const result = renderSlot?.(name, { subject, view: "page", form: ns ? schemaConfig.form?.(ns) : undefined }, key ? { entryKey: key } : undefined);
    if (!result) return "";
    if (typeof result === "string") return result;
    contributions.push(result);
    return result.html ?? "";
  }
  async function refreshExemptions() {
    if (loadingExemptions || disposed) return;
    loadingExemptions = true;
    try {
      const result = await settingsService.listVersionExemptions();
      if (disposed) return;
      exemptions = result?.exemptions ?? {}; exemptionWarnings = result?.warnings ?? []; exemptionsError = null;
    } catch (error) { exemptionsError = deps.formatErrorDetails(error); }
    finally { loadingExemptions = false; if (!disposed) onChange(); }
  }
  function render(pkg, entries, rowId, message) {
    contributions.length = 0;
    const rows = bundleRows(pkg, entries);
    const selected = rowId ? rows.find(item => item.rowId === rowId) : null;
    target = { pkg, rows, selected };
    const subject = detailSubject(pkg, rows, selected);
    const text = selected ? entryText({ ...selected, ...selected.entry, meta: selected.meta ?? selected.entry?.meta }) : bundleText(pkg);
    const incompatible = pkg.error?.incompatible ?? [];
    const status = selected ? selected.readOnlyReason : pkg.readOnlyReason
      ?? (pkg.availability === "missing" && !pkg.installTarget ? t("plug.installTargetMissing") : null);
    const active = selected ? selected.enabled : pkg.enabled;
    // 返回链接写明上一级是谁:组件页回到所属插件,插件页回到列表。
    const back = backLink({ id: "plug-detail-back", label: selected ? bundleText(pkg).title : t("plug.crumbRoot") });
    const actions = slot("plugins.detail.actions", subject)
      + (!selected && updateAvailable(pkg) ? button({ id: "plug-detail-update", label: t("plug.update"), kind: "primary", disabled: busy.size > 0 }) : "")
      + (!selected && pkg.removable && pkg.installed ? button({ id: "plug-detail-remove", label: t("plug.uninstall"), kind: "danger", disabled: busy.size > 0 }) : "");
    // 头部卡片:身份(头像 / 名称 / 版本 / 说明 / 包名)+ 右侧的启停开关与状态字。
    const hero = `<div class="set-hero">`
      // 接口自带的图标:组件页用组件行的 meta.icon,插件页用包的(web DetailTop)。
      + (selected
        ? packageArtwork(selected.meta?.icon ?? selected.entry?.meta?.icon, { component: true, size: "lg" })
        : packageArtwork(pkg.meta?.icon, { size: "lg" }))
      + `<div class="set-hero-text">`
      + `<div class="set-hero-title">${escapeHtml(text.title)}`
      + (pkg.version ? tag("v" + pkg.version, "muted") : "")
      + (!selected && updateAvailable(pkg) ? tag(t("plug.updateAvailable"), "accent") : "")
      + slot("plugins.detail.badge", subject) + `</div>`
      + (text.description ? `<div class="set-row-hint">${escapeHtml(text.description)}</div>` : "")
      + `<div class="set-mono">${escapeHtml(pkg.name)}${selected ? "#" + escapeHtml(selected.rowId) : ""}</div>`
      + `</div>`
      + `<div class="set-hero-control">`
      + `<span class="set-hero-state${active ? " on" : ""}">${escapeHtml(active ? t("inv.enabledTag") : t("inv.disabledTag"))}</span>`
      + toggle({ id: "plug-detail-enabled", checked: active, disabled: Boolean(status) || busy.size > 0,
        ariaLabel: t("plug.enableNamed", { name: text.title }) })
      + `</div></div>`;
    let body = `<div class="set-detail-nav">${back}</div>`
      + section({ body: hero
        + (status ? notice(readOnlyText(status), "muted") : "")
        + (message ? notice(message, "muted") : "")
        + (pkg.error ? notice(pkg.error.diagnostic ?? pkg.error.code) : "")
        + (actions ? `<div class="set-form-footer"><span class="set-spacer"></span>${actions}</div>` : "") });
    const info = (pkg.source ? row({ label: escapeHtml(t("plug.source")), control: `<span class="set-value mono" title="${escapeHtml(pkg.source)}">${escapeHtml(pkg.source)}</span>` }) : "")
      + (pkg.availability ? row({ label: escapeHtml(t("plug.availability")), control: `<span class="set-value">${escapeHtml(pkg.availability)}</span>` }) : "");
    if (selected) {
      body += section({ header: t("plug.info"), body: row({ label: escapeHtml(selected.moduleName), control: phaseStatus(selected.entry?.fiberPhase) }) + info });
      body += slot("plugins.row.config", subject, pkg.name + "#" + selected.rowId)
        || schemaConfig.render(selected.rowId);
    } else {
      if (info) body += section({ header: t("plug.info"), body: info });
      body += slot("plugins.bundle.config", subject, pkg.name);
      // 组件:整行进入组件详情(配置在组件页里),行尾是运行状态。
      body += section({ headerHtml: groupHeader(t("plug.components"), rows.length), body: rows.map((item, index) => row({
        leading: packageArtwork(item.meta?.icon ?? item.entry?.meta?.icon, { component: true }),
        label: escapeHtml(entryText({ ...item, meta: item.meta }).title),
        hint: `<span class="set-mono">${escapeHtml(item.moduleName)}</span>`
          + (item.readOnlyReason ? `<div class="set-row-hint">${escapeHtml(readOnlyText(item.readOnlyReason))}</div>` : ""),
        control: phaseStatus(item.entry?.fiberPhase) + chevron(),
        id: "plug-detail-row-" + index,
        clickable: true
      })).join("") || notice(t("plug.noComponents"), "muted") });
    }
    body += versionControls(pkg, incompatible) + slot("plugins.detail.section", subject);
    return body;
  }
  function versionControls(pkg, incompatible) {
    const own = pkg.version ? pkg.name + "@" + pkg.version : null;
    const grants = Object.entries(exemptions).filter(([key]) => key === own || incompatible.some(item => key === item.name + "@" + item.version));
    const problems = incompatible.map((item, index) => row({ label: escapeHtml(item.name + "@" + item.version),
      hint: escapeHtml(t("plug.incompatibleRuntime", { version: item.runtimeVersion })) + '<pre class="set-code">' + escapeHtml(JSON.stringify(item.peers, null, 2)) + '</pre>',
      control: button({ id: "plug-exempt-grant-" + index, label: t("plug.allowVersion"), kind: "danger", disabled: loadingExemptions || Boolean(exemptionsError) || busy.size > 0 }) })).join("");
    const saved = grants.flatMap(([key, versions]) => versions.map(version => ({ key, version })));
    const existing = saved.map((item, index) => row({ label: escapeHtml(item.key), hint: escapeHtml(item.version),
      control: button({ id: "plug-exempt-revoke-" + index, label: t("plug.revokeVersion"), disabled: busy.size > 0 }) })).join("");
    target.incompatible = incompatible; target.grants = saved;
    return !problems && !existing && !exemptionsError && !exemptionWarnings.length && !errors.size ? "" : section({ header: t("plug.versionCompatibility"), body: problems + existing
      + exemptionWarnings.map(warning => notice(warning)).join("")
      + (exemptionsError ? notice(exemptionsError) + button({ id: "plug-exempt-retry", label: t("set.retry") }) : "")
      + [...errors.values()].map(error => notice(error)).join("") });
  }
  async function setExemption(item, enabled) {
    const key = item.key ?? item.name + "@" + item.version;
    if (busy.has(key) || disposed) return;
    busy.add(key); onChange();
    try {
      const result = await settingsService.setVersionExemption(key, item.runtimeVersion ?? item.version, enabled, enabled ? true : undefined);
      if (result?.application === "failed") errors.set(key, result.error?.diagnostic ?? result.error?.code);
      else { errors.delete(key); if (result?.application === "restart-required") errors.set(key, t("plug.changedRestart")); }
      await refreshExemptions(); await onChange({ refresh: true });
    } catch (error) { errors.set(key, deps.formatErrorDetails(error)); }
    finally { busy.delete(key); if (!disposed) onChange(); }
  }
  function confirmRisk(item) {
    if (!sheet) return;
    const token = sheet.open({ title: t("plug.allowVersion"), body: notice(t("plug.versionRisk")),
      actions: button({ id: "plug-risk-cancel", label: t("set.cancel") }) + button({ id: "plug-risk-accept", label: t("plug.acceptVersionRisk"), kind: "danger" }),
      bind(root) {
        root.querySelector("#plug-risk-cancel")?.addEventListener("click", () => sheet.close(token));
        root.querySelector("#plug-risk-accept")?.addEventListener("click", () => { if (!sheet.owns(token)) return; sheet.close(token); setExemption(item, true); });
      }
    });
  }
  function bind(host) {
    if (!target) return;
    const { pkg, selected, rows, incompatible, grants } = target;
    host.querySelector("#plug-detail-back")?.addEventListener("click", onBack);
    host.querySelector("#plug-detail-enabled")?.addEventListener("change", event => onEnable(pkg, event.target.checked, selected));
    host.querySelector("#plug-detail-update")?.addEventListener("click", () => onInstall(pkg));
    host.querySelector("#plug-detail-remove")?.addEventListener("click", () => onRemove(pkg));
    rows.forEach((item, index) => host.querySelector("#plug-detail-row-" + index)?.addEventListener("click", () => onOpenRow(pkg.name, item.rowId)));
    incompatible.forEach((item, index) => host.querySelector("#plug-exempt-grant-" + index)?.addEventListener("click", () => confirmRisk(item)));
    grants.forEach((item, index) => host.querySelector("#plug-exempt-revoke-" + index)?.addEventListener("click", () => setExemption(item, false)));
    host.querySelector("#plug-exempt-retry")?.addEventListener("click", refreshExemptions);
    if (selected) schemaConfig.bind(host, selected.rowId);
    bindClickableRows(host);
    contributions.forEach(item => item.bind?.(host));
  }
  return { render, bind, refreshExemptions, dispose() { disposed = true; contributions.length = 0; } };
}
