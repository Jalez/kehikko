/**
 * The page's own steps of a start, told to the host for its startup timeline
 * (`server/startupTimeline.ts`): the page's script running, its first paint,
 * its first reading of the modules, and each module's first greeting. Each
 * step once per page, and only in the page's first two minutes — after that
 * a greeting is a module restarted, not the start.
 */

/** How long after the page loaded a step still belongs to the start. */
export const STARTUP_STEPS_FOR_MS = 120_000

const told = new Set<string>()

/** Whether this step should be told now: not told before, and still the start. `since`: ms since the page loaded. */
export function shouldTell(step: string, since: number, already: ReadonlySet<string> = told): boolean {
  return since <= STARTUP_STEPS_FOR_MS && !already.has(step)
}

/** Tell the host this step happened now. Never awaited and never fails anything. */
export function tellStartup(step: string): void {
  if (typeof performance === 'undefined' || typeof fetch === 'undefined') return
  if (!shouldTell(step, performance.now())) return
  told.add(step)
  void fetch('/host/startup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step, at: Date.now() }),
    keepalive: true,
  }).catch(() => null)
}
