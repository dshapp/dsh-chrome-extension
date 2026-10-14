// DSH 0.2.1-alpha.2 schedule Remote; no schedule/create endpoint exists.
import { RPC } from "../../platform/dsh/rpc-methods.js";

const fields = { after: ["afterSeconds"], at: [], every: ["everySeconds"], daily: ["time", "timeZone"], weekly: ["time", "timeZone", "weekdays"], cron: ["expression", "timeZone"] };
export function scheduleRecord(entry) {
  if (!entry || !Object.hasOwn(fields, entry.kind)) throw new TypeError("Invalid ScheduleRecord kind");
  const record = {};
  for (const key of ["id", "kind", "title", "prompt", "scheduledAt", ...fields[entry.kind]]) {
    if (entry[key] === undefined) throw new TypeError("Missing ScheduleRecord field: " + key);
    record[key] = Array.isArray(entry[key]) ? [...entry[key]] : entry[key];
  }
  return record;
}

export function createAutomationService(connection) {
  const resets = new Set();
  const changed = new Set();
  let offFrame = null;
  let disposed = false;
  function attach() {
    if (offFrame || disposed || (!changed.size && !resets.size)) return;
    offFrame = connection.onFrame?.((frame) => {
      if (frame.type !== "item") return;
      const value = frame.value;
      if (value?.type === "emit" && value.event === "schedule/changed") {
        for (const fn of changed) fn();
      } else if (value?.type === "ready" && frame.streamId === "events") {
        for (const fn of resets) fn();
      }
    }) ?? (() => {});
  }
  function check() { if (disposed) throw new Error("Automation service disposed"); }
  const service = {
    catalog() { check(); return connection.call(RPC.scheduleCatalog, {}); },
    list(sessionId) { check(); return connection.call(RPC.scheduleList, { request: { sessionId } }); },
    update(entry, { title, prompt, change } = {}) {
      check();
      return connection.call(RPC.scheduleUpdate, { request: {
        sessionId: entry.sessionId, id: entry.id, expected: scheduleRecord(entry),
        ...(title !== undefined ? { title } : {}), ...(prompt !== undefined ? { prompt } : {}),
        ...(change !== undefined ? { change } : {})
      } });
    },
    delete(entry) { check(); return connection.call(RPC.scheduleDelete, { request: { sessionId: entry.sessionId, id: entry.id } }); },
    history(entry, { limit = 20, before } = {}) {
      check();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("History limit must be 1–100");
      return connection.call(RPC.scheduleHistory, { request: { sessionId: entry.sessionId, id: entry.id, limit, ...(before !== undefined ? { before } : {}) } });
    },
    subscribeChanged(fn) {
      check(); changed.add(fn); attach();
      return () => { changed.delete(fn); if (!changed.size && !resets.size) { offFrame?.(); offFrame = null; } };
    },
    subscribeReset(fn) {
      check(); resets.add(fn); attach();
      return () => { resets.delete(fn); if (!changed.size && !resets.size) { offFrame?.(); offFrame = null; } };
    },
    generationOpened() { if (!disposed) for (const fn of resets) fn(); },
    reset() { service.generationOpened(); },
    dispose() { disposed = true; offFrame?.(); offFrame = null; changed.clear(); resets.clear(); }
  };
  return service;
}
