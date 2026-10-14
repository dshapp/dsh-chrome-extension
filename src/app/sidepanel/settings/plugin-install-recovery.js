// An ambiguous transport failure must not trigger a second package operation.
// Recovery joins the Host's original request, never retries installBundle.
export function createInstallRecovery({ settingsService, onSettled, onUncertain }) {
  let active = null;
  let recovering = false;
  let disposed = false;
  async function recover() {
    if (!active || recovering || disposed) return;
    const request = active;
    recovering = true;
    try {
      const result = await settingsService.waitForInstall(request.requestId);
      if (disposed || active !== request) return;
      if (result === null) { active = null; onUncertain?.(null, true); }
      else { active = null; await onSettled(result); }
    } catch (error) {
      if (!disposed && active === request) onUncertain?.(error, false);
    } finally { recovering = false; }
  }
  return {
    async start(spec, options) {
      if (active || disposed) return;
      const request = { requestId: options.requestId };
      active = request;
      try {
        const result = await settingsService.installBundle(spec, options);
        if (disposed || active !== request) return;
        active = null;
        await onSettled(result);
      } catch (error) {
        if (disposed || active !== request) return;
        onUncertain?.(error, false);
        await recover();
      }
    },
    recover,
    get pending() { return active !== null; },
    dispose() { disposed = true; active = null; }
  };
}
