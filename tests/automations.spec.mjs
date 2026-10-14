import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createAutomationService, scheduleRecord, mountAutomationsPage } from "../src/features/automations/index.js";
import { createRuleEditor, seedDraft, timingChange, parseCronExpression, validateDraft, filterAutomations, linkedSession } from "../src/features/automations/automation-model.js";
import { createAutomationCatalog, createDeliveryHistory } from "../src/features/automations/automation-store.js";
import { AUTOMATION_MESSAGES } from "../src/features/automations/automation-messages.js";
import { t } from "../src/shared/i18n.js";

// Real 0.2.1-alpha.2 wire shapes, transcribed from dsh-schedule types/types.d.ts,
// typert.remote-client.js and official UI catalog-source/task-timing/DeliveryHistory.
// Values are synthetic; tests never call the host or mutate real settings/tasks.
const base = { id: "schedule-1", title: "Daily review", prompt: "Review the open work", scheduledAt: "2030-10-14T01:00:00.000Z" };
const records = [
  { ...base, kind: "after", afterSeconds: 120 },
  { ...base, kind: "at" },
  { ...base, kind: "every", everySeconds: 3600 },
  { ...base, kind: "daily", time: "09:00:00.000", timeZone: "Asia/Shanghai" },
  { ...base, kind: "weekly", time: "09:00:00.000", timeZone: "Asia/Shanghai", weekdays: [1, 3, 5] },
  { ...base, kind: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Shanghai" }
];
const catalogEntry = (i = 3, overrides = {}) => ({ ...records[i], sessionId: "session-parent", status: "active", lastDelivery: { scheduledAt: "2030-10-13T01:00:00.000Z", deliveredAt: "2030-10-13T01:00:00.004Z", messageId: "message-previous" }, ...overrides });
const receipt = (id, prompt = "Immutable delivered instruction") => ({ messageId: id, scheduledAt: "2030-10-13T01:00:00.000Z", deliveredAt: "2030-10-13T01:00:00.004Z", ...(prompt === null ? {} : { prompt }) });
const historyPage = (ids = ["message-3", "message-2"], nextBefore = "message-2") => ({ id: base.id, records: ids.map(id => receipt(id)), earlierRecordsPruned: true, earlierRecordsUnavailable: true, retention: { days: 30, records: 100 }, ...(nextBefore ? { nextBefore } : {}) });
const changedFrame = { type: "item", streamId: "events", value: { type: "emit", event: "schedule/changed", args: [] } };
const readyFrame = { type: "item", streamId: "events", value: { type: "ready", clientId: "client-1", host: { home: "/synthetic/home" } } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function connection(handler = () => []) {
  const calls = [], listeners = new Set();
  return { calls, listeners, call(method, args) { calls.push({ method, args }); return Promise.resolve().then(() => handler(method, args)); }, onFrame(fn) { listeners.add(fn); return () => listeners.delete(fn); }, emit(frame) { for (const fn of listeners) fn(frame); } };
}
function pageHarness(handler, extra = {}) {
  const dom = new JSDOM("<body><main></main></body>"); const host = dom.window.document.querySelector("main");
  const conn = connection(handler ?? (() => [catalogEntry()])); const service = createAutomationService(conn);
  const opened = [], notices = []; let created = 0;
  const sessions = { listStore: { get: () => [{ sessionId: "session-parent", title: "Linked session", origin: "user" }], subscribe: () => () => {} }, archivedSessionIds: () => [], onArchivedChange: () => () => {} };
  const page = mountAutomationsPage(host, { service, sessions, onNewSession: () => created++, onOpenSession: id => opened.push(id), showToast: text => notices.push(text), ...extra });
  return { dom, host, conn, service, page, opened, notices, get created() { return created; }, close() { page.dispose(); service.dispose(); dom.window.close(); } };
}
function clickText(host, key) { const button = [...host.querySelectorAll("button")].find(b => b.textContent === t(key)); assert.ok(button, "missing button " + key); button.click(); return button; }
function input(host, field, value) { const el = host.querySelector('[data-field="' + field + '"]'); assert.ok(el, "missing field " + field); el.value = value; el.dispatchEvent(new el.ownerDocument.defaultView.Event("input", { bubbles: true })); return el; }

test("schedule RPC fixtures use request envelopes, full expected records, and no create endpoint", async () => {
  const conn = connection(() => []), service = createAutomationService(conn);
  await service.catalog(); await service.list("session-parent");
  for (let i = 0; i < records.length; i++) {
    const entry = catalogEntry(i);
    await service.update(entry, { title: "Edited name", prompt: "Edited instruction" });
    const call = conn.calls.at(-1);
    assert.equal(call.method, "schedule/update");
    assert.deepEqual(call.args, { request: { sessionId: entry.sessionId, id: entry.id, expected: records[i], title: "Edited name", prompt: "Edited instruction" } });
    if (entry.weekdays) assert.notEqual(call.args.request.expected.weekdays, entry.weekdays);
    assert.equal("sessionId" in call.args.request.expected, false);
    assert.equal("status" in call.args.request.expected, false);
    assert.equal("lastDelivery" in call.args.request.expected, false);
  }
  await service.delete(catalogEntry()); await service.history(catalogEntry(), { limit: 20, before: "message-2" });
  assert.deepEqual(conn.calls[0], { method: "schedule/catalog", args: {} });
  assert.deepEqual(conn.calls[1], { method: "schedule/list", args: { request: { sessionId: "session-parent" } } });
  assert.deepEqual(conn.calls.at(-2), { method: "schedule/delete", args: { request: { sessionId: "session-parent", id: base.id } } });
  assert.deepEqual(conn.calls.at(-1), { method: "schedule/history", args: { request: { sessionId: "session-parent", id: base.id, limit: 20, before: "message-2" } } });
  assert.equal(typeof service.create, "undefined");
  for (const limit of [0, 101, 1.5, Infinity]) assert.throws(() => service.history(catalogEntry(), { limit }), RangeError);
  assert.throws(() => scheduleRecord({ ...base, kind: "unknown" }), TypeError);
  service.dispose(); assert.throws(() => service.catalog(), /disposed/);
});

test("timing edits carry kind and snake_case selectors for all supported editor variants", () => {
  const draft = seedDraft(catalogEntry());
  const cases = [
    ["once", { kind: "at", at: { date: "2030-10-14", time: "09:00:00.000", time_zone: "Asia/Shanghai" } }],
    ["every", { kind: "every", every_seconds: 3600 }],
    ["daily", { kind: "daily", daily: { time: "09:00:00.000", time_zone: "Asia/Shanghai" } }],
    ["weekly", { kind: "weekly", weekly: { time: "09:00:00.000", time_zone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] } }],
    ["cron", { kind: "cron", cron: { expression: "0 9 * * *", time_zone: "Asia/Shanghai" } }]
  ];
  for (const [kind, expected] of cases) assert.deepEqual(timingChange({ ...draft, kind }), expected);
  assert.equal(timingChange({ ...draft, time: "09:00" }).daily.time, "09:00:00");
});

test("fixtures conform to installed official Schedule Remote codecs when available", async context => {
  const path = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/typert.remote-client.js";
  try { await access(path); } catch { context.skip("official installed package not available"); return; }
  const { TYPERT_REMOTE } = await import(pathToFileURL(path).href);
  const descriptors = Object.fromEntries(TYPERT_REMOTE.descriptors.map(d => [d.method, d]));
  for (const record of records) {
    descriptors.catalog.result.create().parse([{ ...record, sessionId: "session-parent", status: "active" }]);
    descriptors.list.result.create().parse([record]);
    descriptors.update.parameters[0].codec.create().parse({ sessionId: "session-parent", id: record.id, expected: record, title: "Edited" });
    descriptors.update.result.create().parse({ id: record.id, updated: true, record });
  }
  for (const kind of ["once", "every", "daily", "weekly", "cron"]) descriptors.update.parameters[0].codec.create().parse({ sessionId: "session-parent", id: base.id, expected: records[3], change: timingChange({ ...seedDraft(catalogEntry()), kind }) });
  descriptors.history.result.create().parse(historyPage());
  descriptors.history.result.create().parse({ id: base.id, code: "delivery_cursor_not_found" });
  descriptors.delete.result.create().parse({ id: base.id, deleted: false, code: "schedule_not_found" });
});

test("cron validation matches official numeric five-field dialect, including Sunday folding", () => {
  for (const expression of ["0 9 * * 1-5", "*/15 8-18/2 * 1,3,12 0,7", "0 0 1 * *", "* * * * *", "0 9 31 2 *", "*/100 9 * * *"]) assert.ok(parseCronExpression(expression), expression);
  for (const expression of ["", " 0 9 * * *", "0 9 * * * ", "0 0 9 * * *", "@daily", "0 9 * JAN MON", "60 9 * * *", "0 24 * * *", "0 9 0 * *", "0 9 * 13 *", "0 9 * * 8", "0 9 * * 5-1", "*/0 9 * * *", "1/2 9 * * *", "0,,1 9 * * *", "0 9 ? * *", "0 9 * * 1L", "*/9007199254740992 9 * * *"]) assert.equal(parseCronExpression(expression), null, expression);
  assert.deepEqual(parseCronExpression("0 9 * * 0,7")[4].values, [0]);
});

test("validation rejects invalid calendar dates, zones, weekdays, names and intervals", () => {
  const draft = seedDraft(catalogEntry()); assert.equal(validateDraft(draft), null);
  for (const seconds of ["59", "-60", "60.1", "", "9007199254740992"]) assert.equal(validateDraft({ ...draft, kind: "every", seconds }), "automationsInvalidInterval");
  assert.equal(validateDraft({ ...draft, title: " " }), "automationsInvalidTitle");
  assert.equal(validateDraft({ ...draft, title: "x".repeat(121) }), "automationsInvalidTitle");
  assert.equal(validateDraft({ ...draft, title: "😀".repeat(61) }), "automationsInvalidTitle"); // Host counts UTF-16 code units.
  assert.equal(validateDraft({ ...draft, prompt: " " }), "automationsInvalidPrompt");
  assert.equal(validateDraft({ ...draft, timeZone: "+08:00" }), "automationsInvalidZone");
  assert.equal(validateDraft({ ...draft, timeZone: "Invalid/Zone" }), "automationsInvalidZone");
  assert.equal(validateDraft({ ...draft, time: "24:00:00" }), "automationsInvalidTiming");
  assert.equal(validateDraft({ ...draft, kind: "once", date: "2030-02-30" }), "automationsInvalidTiming");
  assert.equal(validateDraft({ ...draft, kind: "once", date: "2032-02-29" }), null);
  for (const weekdays of [[], [1, 1], [0], [8]]) assert.equal(validateDraft({ ...draft, kind: "weekly", weekdays }), "automationsInvalidWeekdays");
});

test("dirty drafts preserve complete observed expected through invalidations; cancel adopts latest", () => {
  const initial = catalogEntry(), editor = createRuleEditor(initial);
  editor.edit("prompt", "Changed by me"); assert.equal(editor.dirty, true);
  editor.receive({ ...initial, title: "Changed elsewhere", scheduledAt: "2030-10-15T01:00:00.000Z" });
  assert.equal(editor.draft.prompt, "Changed by me"); assert.equal(editor.request().entry.scheduledAt, initial.scheduledAt);
  assert.equal(editor.request().entry.title, initial.title); assert.equal(editor.request().changes.change, undefined);
  editor.cancel(); assert.equal(editor.dirty, false); assert.equal(editor.draft.title, "Changed elsewhere");
  editor.edit("time", "10:00:00"); assert.equal(editor.request().changes.change.kind, "daily");
  editor.accept({ ...records[3], time: "10:00:00.000", scheduledAt: "2030-10-15T02:00:00.000Z" }); assert.equal(editor.dirty, false);
  editor.edit("prompt", "Pending"); editor.receive({ ...initial, status: "inactive" }); assert.equal(editor.dirty, false);
});

test("content-only edits never re-anchor after/every/once timing or invent a stored time zone", () => {
  for (const i of [0, 1, 2]) { const editor = createRuleEditor(catalogEntry(i)); editor.edit("title", " Renamed "); assert.deepEqual(editor.request().changes, { title: "Renamed" }); }
  const draft = seedDraft(catalogEntry(0)); assert.equal(draft.kind, "once"); assert.equal(draft.timeZone, "UTC"); assert.equal(draft.time, "01:00:00.000");
});

test("search includes instruction/session binding; linked sessions distinguish archive/subagent/missing", () => {
  const active = catalogEntry(), inactive = catalogEntry(2, { id: "schedule-2", status: "inactive", prompt: "Different instruction" });
  assert.deepEqual(filterAutomations([active, inactive], "DIFFERENT", "inactive"), [inactive]);
  assert.equal(filterAutomations([active, inactive], "session-parent").length, 2);
  const sessions = { listStore: { get: () => [{ sessionId: active.sessionId, title: "Session name", origin: "user" }] }, archivedSessionIds: () => [] };
  assert.equal(linkedSession(active, sessions).reason, null);
  sessions.archivedSessionIds = () => [active.sessionId]; assert.equal(linkedSession(active, sessions).reason, "automationsSessionArchived");
  sessions.archivedSessionIds = () => []; sessions.listStore.get = () => [{ sessionId: active.sessionId, origin: "subagent" }]; assert.equal(linkedSession(active, sessions).reason, "automationsSubagentSession");
  sessions.listStore.get = () => []; assert.equal(linkedSession(active, sessions).reason, "automationsSessionUnavailable");
});

test("catalog lazily subscribes, converges changed/reset generations, retains errors, and disposes stale reads", async () => {
  const reads = []; const conn = connection(() => { const d = deferred(); reads.push(d); return d.promise; });
  const service = createAutomationService(conn), catalog = createAutomationCatalog(service);
  assert.equal(conn.listeners.size, 0); const off = catalog.subscribe(() => {}); await flush(); assert.equal(reads.length, 1); assert.equal(conn.listeners.size, 1);
  reads[0].resolve([catalogEntry()]); await flush(); assert.equal(catalog.getSnapshot().status, "ready");
  conn.emit(changedFrame); conn.emit(changedFrame); service.generationOpened(); await flush(); assert.equal(reads.length, 2);
  conn.emit(readyFrame); await flush(); assert.equal(reads.length, 3);
  reads[1].resolve([catalogEntry(3, { title: "Old response" })]); reads[2].resolve([catalogEntry(3, { title: "Latest" })]); await flush(); assert.equal(catalog.getSnapshot().records[0].title, "Latest");
  const failed = catalog.refresh(); await flush(); reads[3].reject(new Error("temporary")); await failed; assert.equal(catalog.getSnapshot().status, "error"); assert.equal(catalog.getSnapshot().records[0].title, "Latest");
  const pending = catalog.refresh(); await flush(); off(); assert.equal(conn.listeners.size, 0); reads[4].resolve([]); await pending; assert.equal(catalog.getSnapshot().records[0].title, "Latest");
  catalog.dispose(); service.dispose();
});

test("reset-only service subscription attaches once and removes its frame listener", () => {
  const conn = connection(), service = createAutomationService(conn); let resets = 0;
  const off = service.subscribeReset(() => resets++); assert.equal(conn.listeners.size, 1); conn.emit(readyFrame); service.reset(); assert.equal(resets, 2);
  off(); assert.equal(conn.listeners.size, 0); service.dispose();
});

test("history uses exclusive message cursor, retention flags, deduplication, cursor-miss reload and stale protection", async () => {
  const replies = [historyPage(), historyPage(["message-2", "message-1"], null), { id: base.id, code: "delivery_cursor_not_found" }, historyPage(["message-new"], null)];
  const calls = []; const history = createDeliveryHistory({ history: (_e, args) => { calls.push(args); return Promise.resolve(replies.shift()); } }, catalogEntry());
  await history.load({ reset: true }); await history.load();
  assert.deepEqual(calls, [{ limit: 20 }, { limit: 20, before: "message-2" }]);
  assert.deepEqual(history.getSnapshot().records.map(r => r.messageId), ["message-3", "message-2", "message-1"]);
  assert.deepEqual(history.getSnapshot().retention, { days: 30, records: 100 });
  await history.load({ reset: true }); assert.equal(history.getSnapshot().error, "delivery_cursor_not_found"); assert.equal(history.getSnapshot().records.length, 3);
  await history.load({ reset: true }); assert.deepEqual(history.getSnapshot().records.map(r => r.messageId), ["message-new"]); assert.equal(calls.at(-1).before, undefined);
  const d = deferred(); const stale = createDeliveryHistory({ history: () => d.promise }, catalogEntry()); const loading = stale.load(); stale.dispose(); d.resolve(historyPage()); await loading; assert.equal(stale.getSnapshot().records.length, 0); history.dispose();
});

test("page is lazy, supports search/filter, new callback and safe text rendering", async () => {
  const malicious = catalogEntry(3, { title: "<img src=x onerror=alert(1)>", prompt: "Needle" });
  const h = pageHarness(() => [malicious, catalogEntry(2, { id: "schedule-inactive", status: "inactive", title: "Inactive" })]);
  assert.equal(h.conn.calls.length, 0); assert.equal(h.conn.listeners.size, 0); h.page.setVisible(true); await flush();
  assert.equal(h.host.querySelectorAll(".automations-row").length, 2); assert.equal(h.host.querySelector("img"), null);
  const search = input(h.host, "search", "needle"); assert.equal(h.host.querySelectorAll(".automations-row").length, 1);
  input(h.host, "search", ""); h.host.querySelector('[data-filter="inactive"]').click(); assert.equal(h.host.querySelectorAll(".automations-row").length, 1); assert.equal(h.host.querySelector('[data-filter="inactive"]').getAttribute("aria-checked"), "true");
  clickText(h.host, "automationsNew"); assert.equal(h.created, 1); assert.equal(h.conn.calls.some(c => c.method.includes("create")), false);
  h.page.setVisible(false); assert.equal(h.conn.listeners.size, 0); h.page.setVisible(true); await flush(); assert.equal(h.conn.listeners.size, 1); h.close(); assert.equal(h.conn.listeners.size, 0);
});

test("page saves full expected, cancels dirty edits, validates cron and disables ended editing", async () => {
  const updates = []; const initial = catalogEntry();
  const h = pageHarness((method, args) => { if (method === "schedule/update") { updates.push(args.request); return { id: base.id, updated: true, record: { ...records[3], title: args.request.title } }; } return [initial]; });
  h.page.setVisible(true); await flush(); h.host.querySelector(".automations-row").click();
  input(h.host, "title", "Changed"); assert.ok(h.host.querySelector(".automations-save-bar")); clickText(h.host, "automationsCancel"); assert.equal(h.host.querySelector('[data-field="title"]').value, initial.title);
  input(h.host, "title", "Changed"); clickText(h.host, "automationsSave"); await flush(); assert.equal(updates.length, 1); assert.deepEqual(updates[0].expected, records[3]); assert.equal(updates[0].change, undefined);
  const kind = h.host.querySelector('[data-field="kind"]'); kind.value = "cron"; kind.dispatchEvent(new h.dom.window.Event("change")); input(h.host, "expression", "@daily"); assert.equal([...h.host.querySelectorAll("button")].find(b => b.textContent === t("automationsSave")).disabled, true); assert.match(h.host.textContent, new RegExp(t("automationsCronInvalid").replace(/[.*+?^${}()|[]\]/g, "\$&")));
  input(h.host, "expression", "0 9 * * 1-5"); assert.equal([...h.host.querySelectorAll("button")].find(b => b.textContent === t("automationsSave")).disabled, false);
  h.close();
  const ended = pageHarness(() => [catalogEntry(2, { status: "inactive" })]); ended.page.setVisible(true); await flush(); ended.host.querySelector(".automations-row").click(); assert.equal(ended.host.querySelector('[data-field="title"]').disabled, true); assert.equal(ended.host.querySelector(".automations-save-bar"), null); ended.close();
});

test("page deletion requires explicit confirmation, tolerates not-found and linked callbacks", async () => {
  let exists = true; const deletes = [];
  const h = pageHarness((method, args) => { if (method === "schedule/delete") { deletes.push(args); exists = false; return { id: base.id, deleted: true }; } return exists ? [catalogEntry()] : []; });
  h.page.setVisible(true); await flush(); h.host.querySelector(".automations-row").click();
  h.host.querySelector('[data-action="open-session"]').click(); assert.deepEqual(h.opened, ["session-parent"]);
  clickText(h.host, "automationsDelete"); assert.equal(deletes.length, 0); assert.ok(h.host.querySelector('[role="alertdialog"]'));
  clickText(h.host, "automationsCancel"); assert.equal(h.host.querySelector('[role="alertdialog"]'), null);
  clickText(h.host, "automationsDelete"); clickText(h.host, "automationsDeleteConfirm"); await flush(); assert.equal(deletes.length, 1); assert.equal(h.host.querySelector(".automations-detail"), null); assert.equal(h.host.querySelectorAll(".automations-row").length, 0); h.close();
});

test("page delivery history displays retention/legacy receipts and cursor miss without claiming completion", async () => {
  let count = 0;
  const h = pageHarness(method => { if (method === "schedule/history") return ++count === 1 ? { ...historyPage(), records: [receipt("message-3", null), receipt("message-2")] } : count === 2 ? { id: base.id, code: "delivery_cursor_not_found" } : historyPage(["message-new"], null); return [catalogEntry()]; });
  h.page.setVisible(true); await flush(); h.host.querySelector(".automations-row").click(); clickText(h.host, "automationsTabRecords"); await flush();
  assert.equal(h.host.querySelectorAll(".automations-delivery").length, 2); assert.ok(h.host.textContent.includes(t("automationsHistoryPromptMissing"))); assert.ok(h.host.textContent.includes(t("automationsHistoryDisclaimer"))); assert.ok(h.host.textContent.includes(t("automationsHistoryPruned")));
  clickText(h.host, "automationsHistoryMore"); await flush(); assert.ok(h.host.textContent.includes(t("automationsHistoryCursorMissing"))); assert.equal(h.host.querySelectorAll(".automations-delivery").length, 2);
  clickText(h.host, "automationsHistoryReload"); await flush(); assert.equal(h.host.querySelectorAll(".automations-delivery").length, 1); assert.equal(h.conn.calls.filter(c => c.method === "schedule/history").at(-1).args.request.before, undefined); h.close();
});

test("hiding/disposal prevents late mutations from repainting and session notices disable navigation", async () => {
  const d = deferred(); const h = pageHarness(method => method === "schedule/update" ? d.promise : [catalogEntry()], { sessions: { archivedSessionIds: () => ["session-parent"], listStore: { get: () => [] } } });
  h.page.setVisible(true); await flush(); h.host.querySelector(".automations-row").click(); assert.equal(h.host.querySelector('[data-action="open-session"]').disabled, true);
  input(h.host, "title", "Changed"); clickText(h.host, "automationsSave"); await flush(); h.page.setVisible(false); d.resolve({ id: base.id, updated: true, record: { ...records[3], title: "Late" } }); await flush(); assert.equal(h.notices.length, 0); assert.equal(h.conn.listeners.size, 0); h.close(); assert.equal(h.host.children.length, 0);
});

test("conflicts preserve draft/focus, authoritative deletion closes detail, and cancel reloads latest", async () => {
  let current = catalogEntry(); let updateCount = 0;
  const h = pageHarness((method) => method === "schedule/update" ? (++updateCount, { id: base.id, updated: false, code: "schedule_conflict" }) : current ? [current] : []);
  h.page.setVisible(true); await flush(); h.host.querySelector(".automations-row").click();
  const field = input(h.host, "prompt", "My pending instruction"); field.focus(); field.setSelectionRange(2, 5);
  current = { ...current, title: "Remote title", prompt: "Remote instruction", scheduledAt: "2030-10-15T01:00:00.000Z" };
  h.conn.emit(changedFrame); await flush();
  assert.equal(h.dom.window.document.activeElement.dataset.field, "prompt"); assert.equal(h.dom.window.document.activeElement.selectionStart, 2); assert.equal(h.dom.window.document.activeElement.selectionEnd, 5);
  assert.equal(h.host.querySelector('[data-field="prompt"]').value, "My pending instruction");
  clickText(h.host, "automationsSave"); await flush(); assert.equal(updateCount, 1); assert.ok(h.host.textContent.includes(t("automationsErrorConflict")));
  clickText(h.host, "automationsCancel"); assert.equal(h.host.querySelector('[data-field="prompt"]').value, "Remote instruction");
  current = null; h.conn.emit(changedFrame); await flush(); assert.equal(h.host.querySelector(".automations-detail"), null); h.close();
});

test("once timezone edits, weekly day edits and interval limits are editable through DOM", async () => {
  const updates = []; let entry = catalogEntry(0);
  const h = pageHarness((method, args) => { if (method === "schedule/update") { updates.push(args.request); return { id: base.id, updated: false, code: "invalid_rule", message: "Synthetic rejection" }; } return [entry]; });
  h.page.setVisible(true); await flush(); h.host.querySelector(".automations-row").click();
  assert.ok(h.host.textContent.includes(t("automationsZoneNoStored"))); input(h.host, "timeZone", "Asia/Shanghai"); input(h.host, "time", "09:30:00"); clickText(h.host, "automationsSave"); await flush();
  assert.deepEqual(updates[0].change, { kind: "at", at: { date: "2030-10-14", time: "09:30:00", time_zone: "Asia/Shanghai" } }); assert.equal(updates[0].expected.afterSeconds, 120);
  let kind = h.host.querySelector('[data-field="kind"]'); kind.value = "weekly"; kind.dispatchEvent(new h.dom.window.Event("change"));
  const monday = h.host.querySelector('[data-field="weekday-1"]'); monday.click(); clickText(h.host, "automationsSave"); await flush(); assert.deepEqual(updates[1].change.weekly.weekdays, [2, 3, 4, 5]);
  kind = h.host.querySelector('[data-field="kind"]'); kind.value = "every"; kind.dispatchEvent(new h.dom.window.Event("change")); input(h.host, "seconds", "59"); assert.equal([...h.host.querySelectorAll("button")].find(b => b.textContent === t("automationsSave")).disabled, true);
  input(h.host, "seconds", "120"); clickText(h.host, "automationsSave"); await flush(); assert.deepEqual(updates[2].change, { kind: "every", every_seconds: 120 }); h.close();
});

test("delete-not-found reports absence rather than success; failure retains task and permits retry", async () => {
  let mode = "failed"; const h = pageHarness(method => {
    if (method === "schedule/delete") { if (mode === "failed") throw new Error("transport"); return { id: base.id, deleted: false, code: "schedule_not_found" }; }
    return mode === "not-found" ? [] : [catalogEntry()];
  });
  h.page.setVisible(true); await flush(); h.host.querySelector(".automations-row").click(); clickText(h.host, "automationsDelete"); clickText(h.host, "automationsDeleteConfirm"); await flush();
  assert.equal(h.notices.at(-1), t("automationsDeleteFailed")); assert.ok(h.host.querySelector(".automations-detail"));
  mode = "not-found"; clickText(h.host, "automationsDeleteConfirm"); await flush(); assert.equal(h.notices.at(-1), t("automationsErrorNotFound")); assert.equal(h.host.querySelector(".automations-detail"), null); h.close();
});

test("history reset supersedes stale pages; task-not-found and transport failures are non-destructive", async () => {
  const requests = []; const history = createDeliveryHistory({ history: () => { const d = deferred(); requests.push(d); return d.promise; } }, catalogEntry());
  const first = history.load({ reset: true }); requests[0].resolve(historyPage()); await first;
  const older = history.load(); const newest = history.load({ reset: true });
  requests[2].resolve(historyPage(["message-new"], null)); await newest; requests[1].resolve(historyPage(["stale"], null)); await older; assert.deepEqual(history.getSnapshot().records.map(r => r.messageId), ["message-new"]);
  const missing = history.load({ reset: true }); requests[3].resolve({ id: base.id, code: "schedule_not_found" }); await missing; assert.equal(history.getSnapshot().error, "schedule_not_found"); assert.equal(history.getSnapshot().records.length, 1);
  const failed = history.load({ reset: true }); requests[4].reject(new Error("transport")); await failed; assert.equal(history.getSnapshot().error, "internal_error"); assert.equal(history.getSnapshot().records.length, 1); history.dispose();
});

test("automation translations cover every page/model message key in both languages", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["automations-page.js", "automation-model.js"]) {
    const source = await readFile(new URL("../src/features/automations/" + file, import.meta.url), "utf8");
    for (const [, key] of source.matchAll(/"(automations[A-Za-z]+)"/g)) {
      if (key === "automationsKind") continue;
      assert.ok(AUTOMATION_MESSAGES.en[key], key); assert.ok(AUTOMATION_MESSAGES.zh[key], key);
    }
  }
});

test("rule summaries read naturally for every kind", async () => {
  const { scheduleSummary, intervalText, draftSummary } = await import("../src/features/automations/automation-format.js");
  const { setLang } = await import("../src/shared/i18n.js");
  setLang("zh");
  assert.equal(intervalText(600), "10 分钟"); assert.equal(intervalText(7200), "2 小时"); assert.equal(intervalText(86400), "1 天"); assert.equal(intervalText(90), "90 秒");
  assert.equal(scheduleSummary({ kind: "every", everySeconds: 600 }), "每 10 分钟");
  assert.match(scheduleSummary({ kind: "daily", time: "09:00:00.000", timeZone: "Asia/Shanghai" }), /^每天 09:00/);
  assert.match(scheduleSummary({ kind: "weekly", time: "10:00:00.000", weekdays: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai" }), /^工作日 10:00/);
  assert.match(scheduleSummary({ kind: "weekly", time: "08:30:00.000", weekdays: [6, 7], timeZone: "Asia/Shanghai" }), /^周末 08:30/);
  assert.match(scheduleSummary({ kind: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" }), /^Cron 0 9 \* \* 1-5/);
  assert.match(draftSummary({ kind: "once", date: "2030-10-14", time: "09:30", timeZone: "UTC" }), /2030-10-14 09:30/);
  setLang("en");
  assert.match(scheduleSummary({ kind: "weekly", time: "10:00:00.000", weekdays: [1, 3], timeZone: "UTC" }), /^Mon, Wed at 10:00/);
  setLang("zh");
});

test("dirty drafts are protected: switching rows or Escape keeps the draft, Ctrl+S saves", async () => {
  const updates = [];
  const second = catalogEntry(2, { id: "schedule-2", title: "Second" });
  const h = pageHarness((method, args) => { if (method === "schedule/update") { updates.push(args.request); return { id: base.id, updated: true, record: { ...records[3], title: args.request.title } }; } return [catalogEntry(), second]; });
  h.page.setVisible(true); await flush();
  h.host.querySelector('[data-task-id="schedule-1"]').click();
  input(h.host, "title", "Draft title");
  h.host.querySelector('[data-task-id="schedule-2"]').click();
  assert.equal(h.host.querySelector('[data-field="title"]').value, "Draft title", "switching rows must not discard the draft");
  assert.equal(h.notices.at(-1), t("automationsUnsavedBlock"));
  h.host.querySelector('[data-field="title"]').dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(h.host.querySelector(".automations-detail"), "Escape must not close a dirty detail");
  h.host.querySelector('[data-field="title"]').dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
  await flush();
  assert.equal(updates.length, 1); assert.equal(updates[0].title, "Draft title");
  assert.ok(h.host.querySelector(".automations-row-rule").textContent.length > 0, "rows show a readable rule summary");
  h.close();
});
