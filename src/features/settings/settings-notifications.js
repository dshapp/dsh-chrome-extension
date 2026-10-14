// Consume the shared $events stream; never subscribe a second copy of it.
export function createSettingsNotifications(connection, { onChange, onReset } = {}) {
  let visible = false;
  let unsubscribe = null;
  let epoch = 0;
  let queued = false;
  const revisions = new Map();
  function schedule(reset = false) {
    if (reset) { revisions.clear(); onReset?.(); }
    if (queued) return;
    queued = true;
    const token = epoch;
    queueMicrotask(() => {
      queued = false;
      if (visible && token === epoch) Promise.resolve(onChange?.()).catch(() => {});
    });
  }
  function consume(frame) {
    if (!visible || frame?.type !== "item" || !["events", "$events"].includes(frame.streamId)) return;
    const value = frame.value;
    if (value?.type === "ready") { schedule(true); return; }
    if (value?.type !== "emit") return;
    const [namespace, revision] = value.args ?? [];
    if (value.event === "settings/document-updated") {
      if (typeof namespace !== "string") return;
      if (typeof revision === "number") {
        if (revision <= (revisions.get(namespace) ?? -1)) return;
        revisions.set(namespace, revision);
      }
      schedule();
    } else if (value.event === "credentials/reference-updated") schedule();
  }
  return {
    setVisible(value) {
      const next = Boolean(value);
      if (next === visible) return;
      visible = next; epoch++; queued = false;
      unsubscribe?.(); unsubscribe = null;
      if (visible) unsubscribe = connection.onFrame?.(consume) ?? null;
    },
    generationOpened() { if (visible) schedule(true); else { revisions.clear(); onReset?.(); } },
    dispose() { visible = false; epoch++; unsubscribe?.(); unsubscribe = null; revisions.clear(); }
  };
}
