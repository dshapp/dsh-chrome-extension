import { scheduleRecord } from "./automation-service.js";

// Same numeric five-field dialect as official task-cron; no names/macros/seconds.
export function parseCronExpression(expression) {
  if (!expression || expression !== expression.trim()) return null;
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) return null;
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const parsed = [];
  for (let i = 0; i < fields.length; i++) {
    const [min, max] = bounds[i];
    const values = new Set();
    for (const item of fields[i].split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!match) return null;
      const step = match[2] === undefined ? 1 : Number(match[2]);
      if (!Number.isSafeInteger(step) || step < 1) return null;
      const star = match[1] === "*";
      const range = star ? [min, max] : match[1].split("-").map(Number);
      if (!star && range.length === 1 && match[2] !== undefined) return null;
      const start = range[0], end = range[1] ?? start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) return null;
      for (let v = start; v <= end; v += step) values.add(i === 4 && v === 7 ? 0 : v);
    }
    parsed.push({ values: [...values].sort((a, b) => a - b), starred: fields[i].startsWith("*") });
  }
  return parsed;
}

export function validTime(time) {
  const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?$/.exec(time);
  return Boolean(m && Number(m[1]) <= 23 && Number(m[2]) <= 59 && Number(m[3]) <= 59);
}
export function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) return false;
  const d = new Date(date + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
}
export function validTimeZone(zone) {
  if (zone !== "UTC" && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(zone)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
}
function clockAt(instant, timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute + ":" + parts.second + "." + String(new Date(instant).getUTCMilliseconds()).padStart(3, "0") };
  } catch { return { date: "", time: "" }; }
}
export function seedDraft(entry) {
  const zone = entry.timeZone ?? "UTC";
  const clock = clockAt(entry.scheduledAt, zone);
  return {
    title: entry.title, prompt: entry.prompt,
    kind: ["after", "at"].includes(entry.kind) ? "once" : entry.kind,
    date: clock.date, time: entry.time ?? clock.time, timeZone: zone,
    seconds: String(entry.everySeconds ?? 3600), expression: entry.expression ?? "0 9 * * *",
    weekdays: [...(entry.weekdays ?? [1, 2, 3, 4, 5])]
  };
}
export function timingChange(draft) {
  const time = draft.time.length === 5 ? draft.time + ":00" : draft.time;
  const time_zone = draft.timeZone;
  switch (draft.kind) {
    case "once": return { kind: "at", at: { date: draft.date, time, time_zone } };
    case "every": return { kind: "every", every_seconds: Number(draft.seconds) };
    case "daily": return { kind: "daily", daily: { time, time_zone } };
    case "weekly": return { kind: "weekly", weekly: { time, time_zone, weekdays: [...draft.weekdays].sort((a, b) => a - b) } };
    case "cron": return { kind: "cron", cron: { expression: draft.expression, time_zone } };
    default: throw new TypeError("Unsupported rule kind");
  }
}
export function draftKey(draft) { return JSON.stringify([draft.title, draft.prompt, timingChange(draft)]); }
export function validateDraft(draft) {
  if (!draft.title.trim() || draft.title.trim().length > 120) return "automationsInvalidTitle";
  if (!draft.prompt.trim()) return "automationsInvalidPrompt";
  if (draft.kind === "every") return /^\d+$/.test(draft.seconds) && Number.isSafeInteger(Number(draft.seconds)) && Number(draft.seconds) >= 60 ? null : "automationsInvalidInterval";
  if (!validTimeZone(draft.timeZone)) return "automationsInvalidZone";
  if (draft.kind === "cron") return parseCronExpression(draft.expression) ? null : "automationsCronInvalid";
  const time = draft.time.length === 5 ? draft.time + ":00" : draft.time;
  if (!validTime(time) || (draft.kind === "once" && !validDate(draft.date))) return "automationsInvalidTiming";
  if (draft.kind === "weekly" && (!draft.weekdays.length || new Set(draft.weekdays).size !== draft.weekdays.length || draft.weekdays.some(n => !Number.isInteger(n) || n < 1 || n > 7))) return "automationsInvalidWeekdays";
  return ["once", "daily", "weekly"].includes(draft.kind) ? null : "automationsInvalidTiming";
}
export function createRuleEditor(entry) {
  let latest = entry;
  let observed = { ...entry, ...scheduleRecord(entry) };
  let stored = seedDraft(entry);
  let draft = structuredClone(stored);
  return {
    get draft() { return draft; }, get entry() { return latest; },
    get dirty() { return draftKey(draft) !== draftKey(stored); },
    edit(key, value) { draft[key] = value; },
    receive(next) {
      const dirty = this.dirty;
      latest = next;
      if (!dirty || next.status !== "active") {
        observed = { ...next, ...scheduleRecord(next) }; stored = seedDraft(next); draft = structuredClone(stored);
      }
      // Dirty drafts retain their complete original expected record, so stale edits conflict.
    },
    cancel() { observed = { ...latest, ...scheduleRecord(latest) }; stored = seedDraft(latest); draft = structuredClone(stored); },
    request() {
      const error = validateDraft(draft);
      if (error) return { error };
      return { entry: observed, changes: {
        ...(draft.title.trim() !== stored.title ? { title: draft.title.trim() } : {}),
        ...(draft.prompt.trim() !== stored.prompt ? { prompt: draft.prompt.trim() } : {}),
        ...(JSON.stringify(timingChange(draft)) !== JSON.stringify(timingChange(stored)) ? { change: timingChange(draft) } : {})
      } };
    },
    accept(record) { latest = { ...latest, ...record }; this.cancel(); }
  };
}
export function filterAutomations(entries, query = "", filter = "all") {
  const q = query.trim().toLocaleLowerCase();
  return entries.filter(e => (filter === "all" || e.status === filter) && (!q || [e.title, e.prompt, e.sessionId].some(s => String(s).toLocaleLowerCase().includes(q)))).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}
export function linkedSession(entry, sessions, workspaces) {
  const archived = sessions?.archivedSessionIds?.() ?? workspaces?.archivedSessionIds ?? [];
  const archivedIds = typeof archived === "function" ? archived() : archived;
  const rows = sessions?.listStore?.get?.() ?? sessions?.get?.() ?? [];
  const summary = rows.find(s => s.sessionId === entry.sessionId);
  const reason = new Set(archivedIds).has(entry.sessionId) ? "automationsSessionArchived"
    : summary?.origin === "subagent" || sessions?.listStore?.isSubagent?.(entry.sessionId) ? "automationsSubagentSession"
    : !summary ? "automationsSessionUnavailable" : null;
  return { title: summary?.title || entry.sessionId, reason };
}
export function automationErrorKey(code) {
  return ({ schedule_conflict: "automationsErrorConflict", schedule_ended: "automationsInactiveReadonly", schedule_not_found: "automationsErrorNotFound", subagent_session: "automationsSubagentSession", invalid_time_zone: "automationsInvalidZone", not_future: "automationsNotFuture", frequency_too_high: "automationsInvalidInterval", invalid_prompt: "automationsInvalidPrompt", invalid_selector: "automationsInvalidTiming", invalid_rule: "automationsInvalidTiming", time_out_of_range: "automationsInvalidTiming", delivery_cursor_not_found: "automationsHistoryCursorMissing" })[code] ?? "automationsErrorUnknown";
}
