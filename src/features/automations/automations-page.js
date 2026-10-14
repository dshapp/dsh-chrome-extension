import { t } from "../../shared/i18n.js";
import { createRuleEditor, filterAutomations, linkedSession, automationErrorKey, validateDraft } from "./automation-model.js";
import { createAutomationCatalog, createDeliveryHistory } from "./automation-store.js";

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
  function button(key, action, className = "automations-button") {
    const b = node("button", className, t(key)); b.type = "button"; b.addEventListener("click", action); return b;
  }
  function notice(key, params, error = false) { const n = node("p", "automations-notice" + (error ? " is-error" : ""), t(key, params)); if (error) n.setAttribute("role", "alert"); return n; }
  function time(instant) {
    const el = node("time", "automations-time"); el.dateTime = instant; el.dataset.instant = instant;
    el.title = instant; updateTime(el); return el;
  }
  function updateTime(el) {
    const d = new Date(el.dataset.instant);
    el.textContent = Number.isFinite(d.getTime()) ? d.toLocaleString() : el.dataset.instant;
    if (el.dataset.next === "true" && d.getTime() <= Date.now()) el.textContent += " · " + t("automationsOverdue");
  }
  function closeDetail() { selected = null; editor = null; history?.dispose(); history = null; failure = null; confirmingDelete = false; lifecycle++; pending = deleting = false; render(); }
  function select(entry) {
    if (selected === entry.id) return;
    lifecycle++; pending = deleting = false; failure = null; confirmingDelete = false;
    selected = entry.id; editor = createRuleEditor(entry); tab = "rule";
    history?.dispose(); history = createDeliveryHistory(service, entry, () => { if (visible && !disposed && tab === "records") render(); }); render();
  }
  function render() {
    if (disposed || !visible) return;
    // Catalog updates never steal text focus/cursor from a dirty editor.
    const active = doc.activeElement;
    const field = root.contains(active) ? active?.dataset?.field : null;
    const selection = field && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = root.querySelector(".automations-detail-body")?.scrollTop ?? 0;
    const layout = node("div", "automations-layout" + (selected ? " has-detail" : ""));
    layout.append(renderList());
    if (editor) layout.append(renderDetail());
    root.replaceChildren(layout);
    const body = root.querySelector(".automations-detail-body"); if (body) body.scrollTop = scroll;
    if (field) {
      const input = [...root.querySelectorAll("[data-field]")].find(el => el.dataset.field === field);
      if (input && !input.disabled) { input.focus(); if (selection && input.setSelectionRange) { try { input.setSelectionRange(...selection); } catch {} } }
    }
  }
  function renderList() {
    const pane = node("section", "automations-list-pane"); pane.setAttribute("aria-label", t("automationsTitle"));
    const tools = node("div", "automations-toolbar");
    tools.append(button("automationsNew", () => onNewSession?.(), "automations-button is-primary"));
    const status = node("select", "automations-filter"); status.setAttribute("aria-label", t("automationsFilter")); status.dataset.field = "filter";
    for (const [value, key] of [["all", "automationsFilterAll"], ["active", "automationsStatusActive"], ["inactive", "automationsStatusInactive"]]) { const o = node("option", "", t(key)); o.value = value; status.append(o); }
    status.value = filter; status.addEventListener("change", () => { filter = status.value; render(); }); tools.append(status);
    const search = node("input", "automations-search"); search.type = "search"; search.placeholder = t("automationsSearch"); search.setAttribute("aria-label", t("automationsSearch")); search.dataset.field = "search"; search.value = query;
    search.addEventListener("input", () => { query = search.value; render(); }); tools.append(search);
    if (query) tools.append(button("automationsSearchClear", () => { query = ""; render(); }));
    pane.append(tools);
    if (snapshot.status === "error") { pane.append(notice("automationsLoadError", null, true), button("automationsRetry", () => catalog.refresh())); }
    const rows = filterAutomations(snapshot.records, query, filter);
    const list = node("div", "automations-list"); list.setAttribute("role", "list");
    if (!snapshot.records.length && ["loading", "idle"].includes(snapshot.status)) list.append(notice("automationsLoading"));
    else if (!rows.length && snapshot.status !== "error") list.append(notice(snapshot.records.length ? "automationsNoMatches" : filter === "inactive" ? "automationsEmptyInactive" : "automationsEmpty"));
    for (const entry of rows) {
      const row = node("button", "automations-row" + (selected === entry.id ? " is-selected" : "")); row.type = "button"; row.dataset.taskId = entry.id; row.setAttribute("aria-pressed", String(selected === entry.id));
      row.append(node("strong", "automations-row-title", entry.title));
      const summary = node("span", "automations-row-summary");
      summary.append(node("span", "automations-status " + entry.status, t(entry.status === "active" ? "automationsStatusActive" : "automationsStatusInactive")), node("span", "", t("automationsKind" + ({ after: "Once", at: "Once", every: "Every", daily: "Daily", weekly: "Weekly", cron: "Cron" })[entry.kind])));
      if (entry.status === "active") { const next = time(entry.scheduledAt); next.dataset.next = "true"; updateTime(next); summary.append(next); }
      row.append(summary); row.addEventListener("click", () => select(entry)); list.append(row);
    }
    pane.append(list); return pane;
  }
  function renderDetail() {
    const entry = editor.entry;
    const detail = node("section", "automations-detail"); detail.setAttribute("aria-label", entry.title);
    const header = node("div", "automations-detail-header");
    for (const [value, key] of [["rule", "automationsTabRule"], ["records", "automationsTabRecords"]]) {
      const b = button(key, () => { tab = value; render(); if (tab === "records" && history.getSnapshot().status === "idle") void history.load({ reset: true }); });
      b.setAttribute("aria-pressed", String(tab === value)); header.append(b);
    }
    header.append(button("automationsDetailClose", closeDetail)); detail.append(header);
    const body = node("div", "automations-detail-body");
    body.append(node("h2", "automations-detail-title", entry.title));
    const linked = linkedSession(entry, sessions, workspaces);
    const link = button("automationsOpenSession", () => onOpenSession?.(entry.sessionId)); link.textContent = t("automationsOpenSession", { title: linked.title }); link.disabled = Boolean(linked.reason); link.dataset.action = "open-session"; body.append(link);
    if (linked.reason) body.append(notice(linked.reason));
    if (tab === "rule") renderRule(body); else renderHistory(body);
    body.append(node("div", "automations-task-id", t("automationsTaskId") + ": " + entry.id));
    if (confirmingDelete) {
      const confirm = node("div", "automations-delete-confirm"); confirm.setAttribute("role", "alertdialog"); confirm.setAttribute("aria-label", t("automationsDeleteTitle"));
      confirm.append(node("strong", "", t("automationsDeleteTitle")), notice("automationsDeleteDescription"), button("automationsCancel", () => { confirmingDelete = false; render(); }), button("automationsDeleteConfirm", remove, "automations-button is-danger"));
      for (const b of confirm.querySelectorAll("button")) b.disabled = deleting;
      body.append(confirm);
    } else { const del = button(deleting ? "automationsDeleting" : "automationsDelete", () => { confirmingDelete = true; render(); }, "automations-button is-danger"); del.disabled = pending || deleting; body.append(del); }
    detail.append(body);
    if (editor.dirty && entry.status === "active") detail.append(renderSaveBar());
    return detail;
  }
  function inputField(body, key, field, { type = "text", disabled = false } = {}) {
    const label = node("label", "automations-field"); label.append(node("span", "", t(key)));
    const input = node(type === "textarea" ? "textarea" : "input", "automations-input"); if (type !== "textarea") input.type = type;
    input.dataset.field = field; input.value = editor.draft[field]; input.disabled = disabled;
    if (field === "time") input.step = "0.001";
    if (field === "title") input.maxLength = 120;
    if (field === "seconds") { input.min = "60"; input.step = "1"; }
    input.addEventListener("input", () => { editor.edit(field, input.value); failure = null; updateSaveBar(); });
    label.append(input); body.append(label); return input;
  }
  function renderRule(body) {
    const entry = editor.entry, draft = editor.draft;
    const disabled = entry.status !== "active" || pending || deleting;
    if (entry.status !== "active") body.append(notice("automationsInactiveReadonly"));
    inputField(body, "automationsName", "title", { disabled });
    inputField(body, "automationsInstruction", "prompt", { type: "textarea", disabled });
    if (entry.status === "active") { const next = node("p", "automations-next", t("automationsNextRun") + ": "); const instant = time(entry.scheduledAt); instant.dataset.next = "true"; updateTime(instant); next.append(instant); body.append(next); }
    const label = node("label", "automations-field"); label.append(node("span", "", t("automationsKind")));
    const kind = node("select", "automations-input"); kind.dataset.field = "kind"; kind.disabled = disabled;
    for (const [value, suffix] of [["once", "Once"], ["every", "Every"], ["daily", "Daily"], ["weekly", "Weekly"], ["cron", "Cron"]]) { const o = node("option", "", t("automationsKind" + suffix)); o.value = value; kind.append(o); }
    kind.value = draft.kind; kind.addEventListener("change", () => { editor.edit("kind", kind.value); failure = null; render(); }); label.append(kind); body.append(label);
    if (draft.kind === "every") inputField(body, "automationsSeconds", "seconds", { type: "number", disabled });
    else {
      if (draft.kind === "once") inputField(body, "automationsDate", "date", { type: "date", disabled });
      if (draft.kind !== "cron") inputField(body, "automationsTime", "time", { type: "time", disabled });
      inputField(body, "automationsTimeZone", "timeZone", { disabled });
      if (draft.kind === "weekly") {
        const days = node("fieldset", "automations-weekdays"); days.disabled = disabled; days.append(node("legend", "", t("automationsWeekdays")));
        for (let day = 1; day <= 7; day++) { const l = node("label", ""); const cb = node("input", ""); cb.type = "checkbox"; cb.checked = draft.weekdays.includes(day); cb.dataset.field = "weekday-" + day; cb.addEventListener("change", () => { editor.edit("weekdays", cb.checked ? [...editor.draft.weekdays, day].sort((a, b) => a - b) : editor.draft.weekdays.filter(n => n !== day)); failure = null; updateSaveBar(); }); l.append(cb, doc.createTextNode(String(day))); days.append(l); }
        body.append(days);
      }
      if (draft.kind === "cron") { inputField(body, "automationsExpression", "expression", { disabled }); body.append(notice("automationsCronHint")); }
      if (draft.kind === "once" && !entry.timeZone) body.append(notice("automationsZoneNoStored"));
    }
    const error = failure ?? (editor.dirty ? validateDraft(draft) : null);
    const feedback = node("div", "automations-rule-feedback"); if (error) feedback.append(notice(error, null, true)); body.append(feedback);
  }
  function renderSaveBar() {
    const bar = node("div", "automations-save-bar"); bar.append(node("span", "", t("automationsUnsaved")));
    const cancel = button("automationsCancel", () => { editor.cancel(); failure = null; render(); }); cancel.disabled = pending;
    const saveButton = button(pending ? "automationsSaving" : "automationsSave", save, "automations-button is-primary"); saveButton.disabled = pending || deleting || Boolean(validateDraft(editor.draft));
    bar.append(cancel, saveButton); return bar;
  }
  function updateSaveBar() {
    const detail = root.querySelector(".automations-detail"); detail?.querySelector(".automations-save-bar")?.remove();
    if (editor.dirty && editor.entry.status === "active") detail?.append(renderSaveBar());
    const feedback = root.querySelector(".automations-rule-feedback"); const error = failure ?? (editor.dirty ? validateDraft(editor.draft) : null); feedback?.replaceChildren(...(error ? [notice(error, null, true)] : []));
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
    body.append(notice("automationsHistoryDisclaimer"));
    if (state.retention) body.append(notice("automationsHistoryRetention", { days: state.retention.days, records: state.retention.records }));
    if (state.earlierRecordsPruned) body.append(notice("automationsHistoryPruned"));
    if (state.earlierRecordsUnavailable) body.append(notice("automationsHistoryUnavailable"));
    if (state.error) { body.append(notice(automationErrorKey(state.error), null, true), button("automationsHistoryReload", () => history.load({ reset: true }))); }
    if (!state.records.length && state.status === "ready") body.append(notice("automationsHistoryEmpty"));
    for (const record of state.records) {
      const card = node("article", "automations-delivery"); card.dataset.messageId = record.messageId;
      for (const [key, instant] of [["automationsScheduledAt", record.scheduledAt], ["automationsDeliveredAt", record.deliveredAt]]) { const p = node("p", "", t(key) + ": "); p.append(time(instant)); card.append(p); }
      card.append(node("p", "automations-receipt-id", t("automationsMessageId") + ": " + record.messageId));
      card.append(record.prompt !== undefined ? node("pre", "automations-delivered-prompt", record.prompt) : notice("automationsHistoryPromptMissing")); body.append(card);
    }
    if (state.status === "loading") body.append(notice("automationsHistoryLoading"));
    if (state.nextBefore && state.status !== "loading" && !state.error) body.append(button("automationsHistoryMore", () => history.load()));
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
  function keydown(event) { if (event.key === "Escape" && selected) { event.preventDefault(); closeDetail(); } }
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
