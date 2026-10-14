// Human-readable rule summaries and times for the automations page.
// Pure formatting: never used to build RPC payloads (those stay in automation-model).
import { t, getLang } from "../../shared/i18n.js";

export function uiLocale() { return getLang() === "zh" ? "zh-CN" : "en"; }

export function localTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/// Zones offered in the time-zone datalist; the local zone is always first.
export function suggestedTimeZones() {
  const common = ["UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Tokyo", "Asia/Kolkata", "Asia/Dubai",
    "Europe/London", "Europe/Berlin", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"];
  return [...new Set([localTimeZone(), ...common])];
}

/// "09:00:00.000" → "09:00"; seconds are kept only when non-zero.
export function formatClock(time) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(time ?? ""));
  if (!match) return String(time ?? "");
  return match[3] && match[3] !== "00" ? `${match[1]}:${match[2]}:${match[3]}` : `${match[1]}:${match[2]}`;
}

/// ISO weekday numbers (Mon 1 … Sun 7) → localized short names.
export function weekdayName(day, style = "short") {
  try {
    // 2024-01-01 was a Monday, so Jan <day> is ISO weekday <day>.
    return new Intl.DateTimeFormat(uiLocale(), { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, day)));
  } catch { return String(day); }
}

export function intervalText(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value % 86400 === 0) return t("automationsUnitDays", { n: value / 86400 });
  if (value % 3600 === 0) return t("automationsUnitHours", { n: value / 3600 });
  if (value % 60 === 0) return t("automationsUnitMinutes", { n: value / 60 });
  return t("automationsUnitSeconds", { n: value });
}

function sameDays(days, expected) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  return sorted.length === expected.length && sorted.every((day, index) => day === expected[index]);
}

function weekdaysText(days) {
  if (sameDays(days, [1, 2, 3, 4, 5, 6, 7])) return t("automationsEveryDayLabel");
  if (sameDays(days, [1, 2, 3, 4, 5])) return t("automationsWorkdaysLabel");
  if (sameDays(days, [6, 7])) return t("automationsWeekendLabel");
  const separator = getLang() === "zh" ? "、" : ", ";
  return [...days].sort((a, b) => a - b).map((day) => weekdayName(day)).join(separator);
}

function zoneSuffix(zone) {
  return zone && zone !== localTimeZone() ? ` (${zone})` : "";
}

/// Summary of a stored catalog record.
export function scheduleSummary(entry) {
  switch (entry?.kind) {
    case "every": return t("automationsSummaryEvery", { interval: intervalText(entry.everySeconds) });
    case "daily": return t("automationsSummaryDaily", { time: formatClock(entry.time) }) + zoneSuffix(entry.timeZone);
    case "weekly": return t("automationsSummaryWeekly", { days: weekdaysText(entry.weekdays ?? []), time: formatClock(entry.time) }) + zoneSuffix(entry.timeZone);
    case "cron": return t("automationsSummaryCron", { expression: entry.expression }) + zoneSuffix(entry.timeZone);
    case "after":
    case "at": return t("automationsSummaryOnce", { time: formatInstant(entry.scheduledAt) });
    default: return "";
  }
}

/// Summary of an editor draft (live preview while editing).
export function draftSummary(draft) {
  switch (draft?.kind) {
    case "every": return intervalText(draft.seconds) ? t("automationsSummaryEvery", { interval: intervalText(draft.seconds) }) : "";
    case "daily": return t("automationsSummaryDaily", { time: formatClock(draft.time) }) + zoneSuffix(draft.timeZone);
    case "weekly": return draft.weekdays?.length
      ? t("automationsSummaryWeekly", { days: weekdaysText(draft.weekdays), time: formatClock(draft.time) }) + zoneSuffix(draft.timeZone) : "";
    case "cron": return t("automationsSummaryCron", { expression: draft.expression }) + zoneSuffix(draft.timeZone);
    case "once": return t("automationsSummaryOnce", { time: `${draft.date} ${formatClock(draft.time)}` }) + zoneSuffix(draft.timeZone);
    default: return "";
  }
}

/// Compact absolute time: omits the year when it is the current year.
export function formatInstant(instant) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return String(instant ?? "");
  const options = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  try { return new Intl.DateTimeFormat(uiLocale(), options).format(date); } catch { return date.toLocaleString(); }
}

/// "in 14 minutes" / "3 hours ago".
export function relativeTime(instant, now = Date.now()) {
  const target = new Date(instant).getTime();
  if (!Number.isFinite(target)) return "";
  const diff = (target - now) / 1000;
  const abs = Math.abs(diff);
  const units = [["second", 60], ["minute", 3600], ["hour", 86400], ["day", 86400 * 30], ["month", 86400 * 365], ["year", Infinity]];
  const size = { second: 1, minute: 60, hour: 3600, day: 86400, month: 86400 * 30, year: 86400 * 365 };
  let unit = "second";
  for (const [name, limit] of units) { unit = name; if (abs < limit) break; }
  try {
    const value = unit === "second" ? Math.round(diff / 10) * 10 : Math.round(diff / size[unit]);
    return new Intl.RelativeTimeFormat(uiLocale(), { numeric: "auto" }).format(value, unit);
  } catch { return ""; }
}
