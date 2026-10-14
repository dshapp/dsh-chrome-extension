import { t } from "../../shared/i18n.js";
import { lucideIconSvg } from "../chat/file-icons.js";
import { createRuleEditor, filterAutomations, linkedSession, automationErrorKey, validateDraft } from "./automation-model.js";
import { createAutomationCatalog, createDeliveryHistory } from "./automation-store.js";
import {
  scheduleSummary, draftSummary, relativeTime, formatInstant, intervalText, weekdayName,
  localTimeZone, suggestedTimeZones
} from "./automation-format.js";

const KIND_KEY = { after: "Once", at: "Once", every: "Every", daily: "Daily", weekly: "Weekly", cron: "Cron" };
const KIND_ICON = { after: "clock", at: "clock", every: "refresh", daily: "clock", weekly: "list-checks", cron: "terminal" };
const QUICK_INTERVALS = [900, 1800, 3600, 21600, 86400];
const WEEKDAY_PRESETS = [
  ["automationsWorkdaysLabel", [1, 2, 3, 4, 5]],
  ["automationsWeekendLabel", [6, 7]],
  ["automationsEveryDayLabel", [1, 2, 3, 4, 5, 6, 7]]
];

/** Parent supplies route/header/style import and new-session navigation; no create RPC. */
export function mountAutomationsPage(host, { service, onNewSession, onOpenSession, showToast = () => {}, sessions, workspaces } = {}) {
  const doc = host.ownerDocument;
  const catalog = createAutomationCatalog(service);
  let visible = false, disposed = false, offs = [], timer = null;
  let query = "", filter = "all", selected = null, editor = null, tab = "rule";
  let history = null, pending = false, deleting = false, confirmingDelete = false, failure = null, lifecycle = 0, historyRefreshQueued = false;
  let snapshot = catalog.getSnapshot();
  const root = node("div", "automations-page");
  host.replaceChildren(root);
  function node(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function icon(name, size = 14) {
    const span = node("span", "automations-icon"); span.setAttribute("aria-hidden", "true");
    span.innerHTML = lucideIconSvg(name, { size }); return span;
  }
  function button(key, action, className = "automations-button") {
    const b = node("button", className, t(key)); b.type = "button"; b.addEventListener("click", action); return b;
  }
  /// Icon + text button whose textContent is still exactly the label (svg carries no text).
  function iconTextButton(key, iconName, action, className = "automations-button") {
    const b = button(key, action, className); b.prepend(icon(iconName, 13)); return b;
  }
  function iconButton(labelKey, iconName, action, className = "automations-icon-button") {
    const b = node("button", className); b.type = "button"; b.title = t(labelKey); b.setAttribute("aria-label", t(labelKey));
    b.append(icon(iconName)); b.addEventListener("click", action); return b;
  }
  function notice(key, params, error = false) { const n = node("p", "automations-notice" + (error ? " is-error" : ""), t(key, params)); if (error) n.setAttribute("role", "alert"); return n; }
  function time(instant, { next = false, relative = false } = {}) {
    const el = node("time", "automations-time"); el.dateTime = instant; el.dataset.instant = instant;
    if (next) el.dataset.next = "true";
    if (relative) el.dataset.relative = "true";
    updateTime(el); return el;
  }
  function updateTime(el) {
    const d = new Date(el.dataset.instant);
    const valid = Number.isFinite(d.getTime());
    el.title = valid ? d.toLocaleString() : el.dataset.instant;
    if (el.dataset.next === "true" && valid && d.getTime() <= Date.now()) { el.textContent = t("automationsOverdue"); el.classList.add("is-overdue"); return; }
    el.textContent = !valid ? el.dataset.instant : el.dataset.relative === "true" ? relativeTime(d) : formatInstant(d);
  }
  function statusPill(entry) {
    const pill = node("span", "automations-status " + entry.status);
    pill.append(node("i", ""), doc.createTextNode(t(entry.status === "active" ? "automationsStatusActive" : "automationsStatusInactive")));
    return pill;
  }
  /// Dirty drafts are never silently thrown away: switching or closing first asks
  /// the user to save or cancel, and the save bar flashes to show where.
  function guardDirty() {
    if (!editor?.dirty || editor.entry.status !== "active") return false;
    const bar = root.querySelector(".automations-save-bar");
    if (bar) { bar.classList.remove("is-attention"); void bar.offsetWidth; bar.classList.add("is-attention"); }
    showToast(t("automationsUnsavedBlock"));
    return true;
  }
  function closeDetail() { selected = null; editor = null; history?.dispose(); history = null; failure = null; confirmingDelete = false; lifecycle++; pending = deleting = false; render(); }
  function requestClose() { if (!guardDirty()) closeDetail(); }
  function select(entry) {
    if (selected === entry.id) return;
    if (guardDirty()) return;
    lifecycle++; pending = deleting = false; failure = null; confirmingDelete = false;
    selected = entry.id; editor = createRuleEditor(entry); tab = "rule";
    history?.dispose(); history = createDeliveryHistory(service, entry, () => { if (visible && !disposed && tab === "records") render(); }); render();
    const body = root.querySelector(".automations-detail-body"); if (body) body.scrollTop = 0;
  }
  function render() {
    if (disposed || !visible) return;
    // Catalog updates never steal text focus/cursor from a dirty editor.
    const active = doc.activeElement;
    const field = root.contains(active) ? active?.dataset?.field : null;
    const selection = field && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = root.querySelector(".automations-detail-body")?.scrollTop ?? 0;
    const listScroll = root.querySelector(".automations-list")?.scrollTop ?? 0;
    const layout = node("div", "automations-layout" + (selected ? " has-detail" : ""));
    layout.append(renderList());
    if (editor) layout.append(renderDetail());
    root.replaceChildren(layout);
    const body = root.querySelector(".automations-detail-body"); if (body) body.scrollTop = scroll;
    const list = root.querySelector(".automations-list"); if (list) list.scrollTop = listScroll;
    for (const area of root.querySelectorAll("textarea.automations-input")) autosize(area);
    if (field) {
      const input = [...root.querySelectorAll("[data-field]")].find(el => el.dataset.field === field);
      if (input && !input.disabled) { input.focus(); if (selection && input.setSelectionRange) { try { input.setSelectionRange(...selection); } catch {} } }
    }
  }
  function autosize(area) {
    if (!area.isConnected || !area.scrollHeight) return;
    area.style.height = "auto"; area.style.height = Math.min(area.scrollHeight + 2, 360) + "px";
  }
  function renderList() {
    const pane = node("section", "automations-list-pane"); pane.setAttribute("aria-label", t("automationsTitle"));
    const tools = node("div", "automations-toolbar");
    const top = node("div", "automations-toolbar-top");
    const searchWrap = node("div", "automations-search-wrap");
    searchWrap.append(icon("search", 13));
    const search = node("input", "automations-search"); search.type = "search"; search.placeholder = t("automationsSearch"); search.setAttribute("aria-label", t("automationsSearch")); search.dataset.field = "search"; search.value = query;
    search.addEventListener("input", () => { query = search.value; render(); });
    search.addEventListener("keydown", (event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); query = ""; render(); } });
    searchWrap.append(search);
    if (query) searchWrap.append(iconButton("automationsSearchClear", "x", () => { query = ""; render(); root.querySelector("[data-field=search]")?.focus(); }, "automations-search-clear"));
    top.append(searchWrap, iconTextButton("automationsNew", "plus", () => onNewSession?.(), "automations-button is-primary"));
    tools.append(top);
    // Status filter as a segmented control with live counts.
    const counts = { all: snapshot.records.length, active: 0, inactive: 0 };
    for (const entry of snapshot.records) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    const segments = node("div", "automations-segmented"); segments.setAttribute("role", "radiogroup"); segments.setAttribute("aria-label", t("automationsFilter"));
    for (const [value, key] of [["all", "automationsFilterAll"], ["active", "automationsStatusActive"], ["inactive", "automationsStatusInactive"]]) {
      const segment = node("button", "automations-segment" + (filter === value ? " is-active" : "")); segment.type = "button";
      segment.dataset.filter = value; segment.setAttribute("role", "radio"); segment.setAttribute("aria-checked", String(filter === value));
      segment.append(node("span", "", t(key)), node("span", "automations-segment-count", String(counts[value] ?? 0)));
      segment.addEventListener("click", (event) => { filter = value; render(); if (event.detail === 0) root.querySelector('[data-filter="' + value + '"]')?.focus(); });
      segments.append(segment);
    }
    tools.append(segments);
    pane.append(tools);
    if (snapshot.status === "error") {
      const box = node("div", "automations-inline-error");
      box.append(notice("automationsLoadError", null, true), button("automationsRetry", () => catalog.refresh()));
      pane.append(box);
    }
    // Active rules first (soonest next run on top), ended ones after.
    const rows = filterAutomations(snapshot.records, query, filter).sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1));
    const list = node("div", "automations-list"); list.setAttribute("role", "list");
    if (!snapshot.records.length && ["loading", "idle"].includes(snapshot.status)) list.append(skeleton());
    else if (!rows.length && snapshot.status !== "error") list.append(emptyState(snapshot.records.length ? "automationsNoMatches" : filter === "inactive" ? "automationsEmptyInactive" : "automationsEmpty", !snapshot.records.length));
    for (const entry of rows) list.append(renderRow(entry));
    pane.append(list); return pane;
  }
  function skeleton() {
    const box = node("div", "automations-skeleton"); box.setAttribute("aria-label", t("automationsLoading")); box.setAttribute("role", "status");
    for (let i = 0; i < 3; i++) box.append(node("div", "automations-skeleton-row"));
    return box;
  }
  function emptyState(key, offerCreate) {
    const box = node("div", "automations-empty");
    box.append(icon("clock", 22), node("p", "", t(key)));
    if (offerCreate) box.append(iconTextButton("automationsNew", "plus", () => onNewSession?.(), "automations-button"));
    return box;
  }
  function renderRow(entry) {
    const row = node("button", "automations-row" + (selected === entry.id ? " is-selected" : "") + (entry.status !== "active" ? " is-ended" : ""));
    row.type = "button"; row.dataset.taskId = entry.id; row.setAttribute("aria-pressed", String(selected === entry.id)); row.setAttribute("role", "listitem");
    const head = node("span", "automations-row-head");
    head.append(node("span", "automations-dot " + entry.status), node("strong", "automations-row-title", entry.title));
    row.append(head);
    const summary = node("span", "automations-row-summary");
    summary.append(icon(KIND_ICON[entry.kind] ?? "clock", 12), node("span", "automations-row-rule", scheduleSummary(entry) || t("automationsKind" + KIND_KEY[entry.kind])));
    if (entry.status === "active") {
      const next = node("span", "automations-row-next");
      next.append(time(entry.scheduledAt, { next: true, relative: true }));
      summary.append(next);
    } else summary.append(node("span", "automations-row-next", t("automationsStatusInactive")));
    row.append(summary);
    if (entry.prompt) row.append(node("span", "automations-row-prompt", entry.prompt));
    row.addEventListener("click", () => select(entry));
    return row;
  }
  function renderDetail() {
    const entry = editor.entry;
    const detail = node("section", "automations-detail"); detail.setAttribute("aria-label", entry.title);
    const header = node("div", "automations-detail-header");
    header.append(iconButton("automationsDetailClose", "chevron-left", requestClose, "automations-icon-button automations-back"));
    const heading = node("div", "automations-detail-heading");
    heading.append(node("h2", "automations-detail-title", entry.title), statusPill(entry));
    header.append(heading);
    detail.append(header);
    const tabs = node("div", "automations-tabs"); tabs.setAttribute("role", "tablist");
    for (const [value, key] of [["rule", "automationsTabRule"], ["records", "automationsTabRecords"]]) {
      const b = button(key, () => { tab = value; render(); if (tab === "records" && history.getSnapshot().status === "idle") void history.load({ reset: true }); }, "automations-tab" + (tab === value ? " is-active" : ""));
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(tab === value)); b.setAttribute("aria-pressed", String(tab === value)); tabs.append(b);
    }
    detail.append(tabs);
    const body = node("div", "automations-detail-body");
    body.append(renderOverview(entry));
    if (tab === "rule") renderRule(body); else renderHistory(body);
    body.append(renderFooter(entry));
    detail.append(body);
    if (editor.dirty && entry.status === "active") detail.append(renderSaveBar());
    return detail;
  }
  /// Summary card: rule in words, next run (absolute + relative) and the linked session.
  function renderOverview(entry) {
    const card = node("div", "automations-overview");
    const rule = node("div", "automations-overview-rule");
    rule.append(icon(KIND_ICON[entry.kind] ?? "clock", 15), node("span", "", scheduleSummary(entry)));
    card.append(rule);
    if (entry.status === "active") {
      const next = node("div", "automations-overview-next");
      next.append(node("span", "automations-overview-label", t("automationsNextRun")), time(entry.scheduledAt, { next: true }));
      const rel = time(entry.scheduledAt, { relative: true }); rel.classList.add("automations-relative"); next.append(rel);
      card.append(next);
    }
    const linked = linkedSession(entry, sessions, workspaces);
    const session = node("div", "automations-overview-session");
    session.append(node("span", "automations-overview-label", t("automationsLinkedSession")));
    const title = node("span", "automations-session-title", linked.title); title.title = entry.sessionId; session.append(title);
    const link = iconTextButton("automationsOpen", "external-link", () => onOpenSession?.(entry.sessionId), "automations-button is-small");
    link.disabled = Boolean(linked.reason); link.dataset.action = "open-session"; link.title = t("automationsOpenSession", { title: linked.title });
    session.append(link);
    card.append(session);
    if (linked.reason) card.append(notice(linked.reason));
    return card;
  }
  function inputField(parent, key, field, { type = "text", disabled = false, onInput, list } = {}) {
    const label = node("label", "automations-field"); label.append(node("span", "automations-field-label", t(key)));
    const input = node(type === "textarea" ? "textarea" : "input", "automations-input"); if (type !== "textarea") input.type = type;
    input.dataset.field = field; input.value = editor.draft[field]; input.disabled = disabled;
    if (field === "time") {
      // Show only the precision the rule actually uses: "10:00:00.000" renders as 10:00,
      // so the picker is not cluttered with seconds/milliseconds nobody set.
      const match = /^(d{2}:d{2})(?::(d{2})(?:.(d{1,3}))?)?$/.exec(input.value);
      const millis = match?.[3] && Number(match[3]) !== 0;
      if (match && !millis && (match[2] ?? "00") === "00") { input.value = match[1]; input.step = "60"; }
      else if (match && !millis) { input.value = match[1] + ":" + match[2]; input.step = "1"; }
      else input.step = "0.001";
    }
    if (field === "title") input.maxLength = 120;
    if (field === "seconds") { input.min = "60"; input.step = "1"; }
    if (list) input.setAttribute("list", list);
    input.addEventListener("input", () => { editor.edit(field, input.value); failure = null; if (type === "textarea") autosize(input); onInput?.(input.value); updateSaveBar(); });
    label.append(input); parent.append(label); return input;
  }
  function group(parent, key) {
    const box = node("div", "automations-group");
    box.append(node("h3", "automations-group-title", t(key)));
    parent.append(box); return box;
  }
  function renderRule(body) {
    const entry = editor.entry, draft = editor.draft;
    const disabled = entry.status !== "active" || pending || deleting;
    if (entry.status !== "active") body.append(notice("automationsInactiveReadonly"));
    const basics = group(body, "automationsSectionBasics");
    inputField(basics, "automationsName", "title", { disabled });
    inputField(basics, "automationsInstruction", "prompt", { type: "textarea", disabled });
    const timing = group(body, "automationsRuleTitle");
    const label = node("label", "automations-field"); label.append(node("span", "automations-field-label", t("automationsKind")));
    const kind = node("select", "automations-input"); kind.dataset.field = "kind"; kind.disabled = disabled;
    for (const [value, suffix] of [["once", "Once"], ["every", "Every"], ["daily", "Daily"], ["weekly", "Weekly"], ["cron", "Cron"]]) { const o = node("option", "", t("automationsKind" + suffix)); o.value = value; kind.append(o); }
    kind.value = draft.kind; kind.addEventListener("change", () => { editor.edit("kind", kind.value); failure = null; render(); }); label.append(kind); timing.append(label);
    if (draft.kind === "every") {
      const seconds = inputField(timing, "automationsSeconds", "seconds", { type: "number", disabled, onInput: () => updateIntervalHint() });
      const hint = node("span", "automations-field-hint"); hint.dataset.role = "interval-hint"; seconds.parentElement.append(hint);
      const quick = node("div", "automations-chips");
      for (const value of QUICK_INTERVALS) {
        const chip = node("button", "automations-chip" + (String(value) === draft.seconds ? " is-active" : ""), intervalText(value)); chip.type = "button"; chip.disabled = disabled;
        chip.addEventListener("click", () => { editor.edit("seconds", String(value)); failure = null; render(); });
        quick.append(chip);
      }
      timing.append(quick);
    } else {
      const row = node("div", "automations-field-row");
      if (draft.kind === "once") inputField(row, "automationsDate", "date", { type: "date", disabled });
      if (draft.kind !== "cron") inputField(row, "automationsTime", "time", { type: "time", disabled });
      if (row.childElementCount) timing.append(row);
      if (draft.kind === "weekly") timing.append(renderWeekdays(disabled));
      if (draft.kind === "cron") { inputField(timing, "automationsExpression", "expression", { disabled }).classList.add("is-mono"); timing.append(notice("automationsCronHint")); }
      renderZoneField(timing, disabled);
      if (draft.kind === "once" && !entry.timeZone) timing.append(notice("automationsZoneNoStored"));
    }
    const preview = node("p", "automations-preview"); preview.dataset.role = "preview"; timing.append(preview);
    const feedback = node("div", "automations-rule-feedback"); body.append(feedback);
    updateFeedback(body);
    updateIntervalHint(body);
  }
  function renderWeekdays(disabled) {
    const days = node("fieldset", "automations-weekdays"); days.disabled = disabled; days.append(node("legend", "automations-field-label", t("automationsWeekdays")));
    const chips = node("div", "automations-days");
    for (let day = 1; day <= 7; day++) {
      const l = node("label", "automations-day"); const cb = node("input", ""); cb.type = "checkbox"; cb.checked = editor.draft.weekdays.includes(day); cb.dataset.field = "weekday-" + day;
      cb.setAttribute("aria-label", weekdayName(day, "long"));
      cb.addEventListener("change", () => { editor.edit("weekdays", cb.checked ? [...editor.draft.weekdays, day].sort((a, b) => a - b) : editor.draft.weekdays.filter(n => n !== day)); failure = null; updateSaveBar(); });
      l.append(cb, node("span", "", weekdayName(day))); chips.append(l);
    }
    days.append(chips);
    const presets = node("div", "automations-chips");
    for (const [key, value] of WEEKDAY_PRESETS) {
      const chip = node("button", "automations-chip", t(key)); chip.type = "button"; chip.disabled = disabled;
      chip.addEventListener("click", () => { editor.edit("weekdays", [...value]); failure = null; render(); });
      presets.append(chip);
    }
    days.append(presets);
    return days;
  }
  function renderZoneField(parent, disabled) {
    const listId = "automations-zones";
    const input = inputField(parent, "automationsTimeZone", "timeZone", { disabled, list: listId });
    input.classList.add("is-mono"); input.spellcheck = false; input.autocomplete = "off";
    const datalist = node("datalist", ""); datalist.id = listId;
    for (const zone of suggestedTimeZones()) { const o = node("option", ""); o.value = zone; datalist.append(o); }
    input.parentElement.append(datalist);
    const local = localTimeZone();
    if (editor.draft.timeZone !== local) {
      const use = node("button", "automations-link", t("automationsUseLocalZone", { zone: local })); use.type = "button"; use.disabled = disabled;
      use.addEventListener("click", (event) => { event.preventDefault(); editor.edit("timeZone", local); failure = null; render(); });
      parent.append(use);
    }
  }
  function updateIntervalHint(scope = root) {
    const hint = scope.querySelector?.("[data-role=interval-hint]");
    if (hint) hint.textContent = editor?.draft.kind === "every" && /^\d+$/.test(editor.draft.seconds) ? "= " + intervalText(editor.draft.seconds) : "";
  }
  function updateFeedback(scope = root) {
    const error = failure ?? (editor.dirty ? validateDraft(editor.draft) : null);
    scope.querySelector(".automations-rule-feedback")?.replaceChildren(...(error ? [notice(error, null, true)] : []));
    const preview = scope.querySelector("[data-role=preview]");
    if (preview) {
      const text = editor.dirty && !validateDraft(editor.draft) ? draftSummary(editor.draft) : "";
      preview.replaceChildren(...(text ? [icon("info", 12), node("span", "", t("automationsPreview", { text }))] : []));
    }
  }
  function renderFooter(entry) {
    const footer = node("div", "automations-detail-footer");
    const id = node("div", "automations-task-id");
    id.append(node("span", "", t("automationsTaskId") + ": "), node("code", "", entry.id));
    id.append(iconButton("automationsCopyId", "copy", async () => {
      try { await doc.defaultView.navigator.clipboard.writeText(entry.id); showToast(t("automationsCopied")); } catch { /* clipboard unavailable */ }
    }, "automations-icon-button is-small"));
    footer.append(id);
    if (confirmingDelete) {
      const confirm = node("div", "automations-delete-confirm"); confirm.setAttribute("role", "alertdialog"); confirm.setAttribute("aria-label", t("automationsDeleteTitle"));
      const actions = node("div", "automations-delete-actions");
      actions.append(button("automationsCancel", () => { confirmingDelete = false; render(); }), button("automationsDeleteConfirm", remove, "automations-button is-danger-solid"));
      confirm.append(node("strong", "", t("automationsDeleteTitle")), notice("automationsDeleteDescription"), actions);
      for (const b of confirm.querySelectorAll("button")) b.disabled = deleting;
      footer.append(confirm);
    } else {
      const danger = node("div", "automations-danger");
      danger.append(node("span", "automations-field-label", t("automationsDangerZone")));
      const del = button(deleting ? "automationsDeleting" : "automationsDelete", () => { confirmingDelete = true; render(); root.querySelector(".automations-delete-actions button:last-child")?.focus(); }, "automations-button is-danger");
      del.disabled = pending || deleting; danger.append(del); footer.append(danger);
    }
    return footer;
  }
  function renderSaveBar() {
    const bar = node("div", "automations-save-bar");
    const label = node("span", "automations-save-label"); label.append(node("i", ""), node("span", "", t("automationsUnsaved")));
    label.title = t("automationsSaveHint");
    bar.append(label);
    const cancel = button("automationsCancel", () => { editor.cancel(); failure = null; render(); }); cancel.disabled = pending;
    const saveButton = button(pending ? "automationsSaving" : "automationsSave", save, "automations-button is-primary"); saveButton.disabled = pending || deleting || Boolean(validateDraft(editor.draft));
    bar.append(cancel, saveButton); return bar;
  }
  function updateSaveBar() {
    const detail = root.querySelector(".automations-detail"); detail?.querySelector(".automations-save-bar")?.remove();
    if (editor.dirty && editor.entry.status === "active") detail?.append(renderSaveBar());
    updateFeedback();
  }
  async function save() {
    if (pending || deleting || !editor?.dirty || editor.entry.status !== "active") return;
    const request = editor.request(); if (request.error) { failure = request.error; render(); return; }
    const token = lifecycle, current = editor; pending = true; failure = null; render();
    try {
      const result = await service.update(request.entry, request.changes);
      if (token !== lifecycle || disposed || !visible) return;
      if (result.record) { current.accept(result.record); showToast(t("automationsSaved")); }
      else failure = automationErrorKey(result.code);
      pending = false; render();
      if (result.record || ["schedule_conflict", "schedule_ended", "schedule_not_found"].includes(result.code)) await catalog.refresh();
    } catch (error) { if (token === lifecycle && !disposed && visible) { pending = false; failure = automationErrorKey(error?.code); render(); } }
  }
  async function remove() {
    if (!confirmingDelete || deleting || pending || !editor) return;
    const token = lifecycle, entry = editor.entry; deleting = true; render();
    try {
      const result = await service.delete(entry);
      if (token !== lifecycle || disposed || !visible) return;
      deleting = false; confirmingDelete = false;
      // Not-found is already absent, but is not reported as a confirmed deletion.
      if (result.deleted || result.code === "schedule_not_found") { showToast(t(result.deleted ? "automationsDeleted" : "automationsErrorNotFound")); closeDetail(); await catalog.refresh(); }
      else { failure = "automationsDeleteFailed"; showToast(t(failure)); render(); }
    } catch { if (token === lifecycle && !disposed && visible) { deleting = false; showToast(t("automationsDeleteFailed")); render(); } }
  }
  function renderHistory(body) {
    const state = history.getSnapshot();
    const info = node("div", "automations-history-info");
    info.append(icon("info", 13));
    const lines = node("div", "");
    lines.append(notice("automationsHistoryDisclaimer"));
    if (state.retention) lines.append(notice("automationsHistoryRetention", { days: state.retention.days, records: state.retention.records }));
    if (state.earlierRecordsPruned) lines.append(notice("automationsHistoryPruned"));
    if (state.earlierRecordsUnavailable) lines.append(notice("automationsHistoryUnavailable"));
    info.append(lines); body.append(info);
    if (state.error) {
      const box = node("div", "automations-inline-error");
      box.append(notice(automationErrorKey(state.error), null, true), button("automationsHistoryReload", () => history.load({ reset: true })));
      body.append(box);
    }
    if (!state.records.length && state.status === "ready") body.append(emptyState("automationsHistoryEmpty", false));
    const timeline = node("div", "automations-timeline");
    for (const record of state.records) {
      const card = node("article", "automations-delivery"); card.dataset.messageId = record.messageId;
      const head = node("div", "automations-delivery-head");
      head.append(icon("circle-check", 13), node("strong", "", t("automationsDelivered")));
      const when = time(record.deliveredAt, { relative: true }); when.classList.add("automations-relative"); head.append(when);
      card.append(head);
      const meta = node("dl", "automations-delivery-meta");
      for (const [key, instant] of [["automationsScheduledAt", record.scheduledAt], ["automationsDeliveredAt", record.deliveredAt]]) {
        const value = node("dd", ""); value.append(time(instant)); meta.append(node("dt", "", t(key)), value);
      }
      const delay = Math.round((new Date(record.deliveredAt) - new Date(record.scheduledAt)) / 1000);
      if (Number.isFinite(delay) && delay >= 1) meta.append(node("dt", "", t("automationsDelay", { value: "" }).trim()), node("dd", "", intervalText(delay)));
      card.append(meta);
      card.append(record.prompt !== undefined ? node("pre", "automations-delivered-prompt", record.prompt) : notice("automationsHistoryPromptMissing"));
      card.append(node("p", "automations-receipt-id", t("automationsMessageId") + ": " + record.messageId));
      timeline.append(card);
    }
    body.append(timeline);
    if (state.status === "loading") body.append(state.records.length ? notice("automationsHistoryLoading") : skeleton());
    if (state.nextBefore && state.status !== "loading" && !state.error) body.append(button("automationsHistoryMore", () => history.load(), "automations-button is-block"));
  }
  function catalogChanged(next) {
    snapshot = next;
    if (selected && next.status === "ready") {
      const entry = next.records.find(e => e.id === selected);
      if (!entry) { closeDetail(); return; }
      editor.receive(entry);
    }
    render();
  }
  function invalidateHistory() {
    history?.invalidate();
    if (historyRefreshQueued) return;
    historyRefreshQueued = true;
    queueMicrotask(() => {
      historyRefreshQueued = false;
      if (visible && !disposed && tab === "records" && history) void history.load({ reset: true });
    });
  }
  function keydown(event) {
    if (event.key === "Escape" && confirmingDelete) { event.preventDefault(); confirmingDelete = false; render(); return; }
    if (event.key === "Escape" && selected) { event.preventDefault(); requestClose(); return; }
    // Cmd/Ctrl+S saves a dirty rule instead of opening the browser's save dialog.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s" && editor?.dirty) {
      event.preventDefault();
      if (!validateDraft(editor.draft)) void save();
    }
  }
  root.addEventListener("keydown", keydown);
  function setVisible(value) {
    if (disposed || visible === Boolean(value)) return;
    visible = Boolean(value); root.hidden = !visible;
    if (visible) {
      offs = [catalog.subscribe(catalogChanged), service.subscribeChanged(invalidateHistory), service.subscribeReset(invalidateHistory), sessions?.listStore?.subscribe?.(() => render()), sessions?.onArchivedChange?.(() => render())].filter(Boolean);
      if (history && tab === "records") void history.load({ reset: true });
      timer = setInterval(() => { for (const el of root.querySelectorAll("[data-instant]")) updateTime(el); }, 30000); render();
    } else {
      lifecycle++; pending = deleting = false; confirmingDelete = false;
      for (const off of offs) off(); offs = []; clearInterval(timer); timer = null; history?.invalidate();
    }
  }
  root.hidden = true;
  return { setVisible, refresh: () => catalog.refresh(), dispose() { if (disposed) return; setVisible(false); disposed = true; catalog.dispose(); history?.dispose(); root.removeEventListener("keydown", keydown); root.remove(); } };
}
