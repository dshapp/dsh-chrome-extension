// Subscriber-owned catalog: no permanent stream/timer; stale generations never publish.
export function createAutomationCatalog(service) {
  let snapshot = { records: [], status: "idle", error: null };
  let epoch = 0, queued = false, disposed = false;
  let offs = [];
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(snapshot); };
  async function refresh() {
    if (disposed || !listeners.size) return;
    const generation = ++epoch;
    snapshot = { ...snapshot, status: "loading", error: null }; emit();
    try {
      const records = await service.catalog();
      if (generation !== epoch || disposed) return;
      if (!Array.isArray(records)) throw new TypeError("Invalid schedule/catalog response");
      snapshot = { records, status: "ready", error: null }; emit();
    } catch (error) {
      if (generation !== epoch || disposed) return;
      snapshot = { ...snapshot, status: "error", error }; emit();
    }
  }
  function invalidate() {
    // Invalidate in-flight reads immediately; collapse same-tick changed/reset storms.
    epoch++;
    if (queued || disposed || !listeners.size) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!disposed && listeners.size) void refresh(); });
  }
  function stop() { epoch++; for (const off of offs) off?.(); offs = []; }
  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(fn) {
      if (disposed) throw new Error("Automation catalog disposed");
      listeners.add(fn);
      if (listeners.size === 1) { offs = [service.subscribeChanged(invalidate), service.subscribeReset(invalidate)]; invalidate(); }
      fn(snapshot);
      return () => { listeners.delete(fn); if (!listeners.size) stop(); };
    },
    dispose() { disposed = true; stop(); listeners.clear(); }
  };
}

export function createDeliveryHistory(service, entry, onChange = () => {}) {
  let state = { records: [], status: "idle", error: null, nextBefore: undefined, retention: null, earlierRecordsPruned: false, earlierRecordsUnavailable: false };
  let epoch = 0, disposed = false;
  return {
    getSnapshot: () => state,
    async load({ reset = false } = {}) {
      if (disposed || (!reset && (state.status === "loading" || (state.status === "ready" && !state.nextBefore)))) return;
      const token = ++epoch;
      const before = reset ? undefined : state.nextBefore;
      state = { ...state, status: "loading", error: null }; onChange();
      try {
        const result = await service.history(entry, { limit: 20, ...(before !== undefined ? { before } : {}) });
        if (token !== epoch || disposed) return;
        if (result.code) { state = { ...state, status: "error", error: result.code, ...(result.code === "delivery_cursor_not_found" ? { nextBefore: undefined } : {}) }; onChange(); return; }
        if (!Array.isArray(result.records)) throw new TypeError("Invalid schedule/history response");
        const records = reset ? [] : state.records;
        const seen = new Set(records.map(r => r.messageId));
        state = { ...result, records: [...records, ...result.records.filter(r => !seen.has(r.messageId))], status: "ready", error: null };
        onChange();
      } catch (error) {
        if (token !== epoch || disposed) return;
        state = { ...state, status: "error", error: error?.code ?? "internal_error" }; onChange();
      }
    },
    invalidate() { epoch++; state = { ...state, status: "idle" }; },
    dispose() { disposed = true; epoch++; }
  };
}
