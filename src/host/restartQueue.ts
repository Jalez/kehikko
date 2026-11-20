/**
 * "Restart to update" through the work queue (protocol 2.110.0, `server/restartHold.ts`).
 *
 * The page asks the host first (`askRestart`): when a work queue holds restarts and has runs ahead,
 * the restart waits there as a run of its own, and the page says so with Restart now. Otherwise the
 * page applies the update at once, as before. When the queue lets a held update go, the host says so
 * on `/host/watch` (`{ restart: true }`), and the page reads `/host/restart/state` and applies it: only
 * the page can (the desktop shell's updater is its alone).
 */

/** A restart held behind queued work, as the host says it. */
export interface HeldRestart {
  reason: 'app-update' | 'app-restart'
  version: string | null
  by: string
  ahead: number
  at: number
}

export type RestartAsked = { held: true; restart: HeldRestart } | { held: false }

const isHeld = (value: unknown): value is HeldRestart =>
  !!value && typeof value === 'object' && typeof (value as HeldRestart).by === 'string' && typeof (value as HeldRestart).ahead === 'number'

/** Ask the host to hold the update behind queued work. Anything but a hold — an older host, a refusal — is "go now". */
export async function askRestart(version: string | null, ask: typeof fetch = fetch): Promise<RestartAsked> {
  try {
    const response = await ask('/host/restart/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'app-update', version }) })
    if (!response.ok) return { held: false }
    const body = (await response.json()) as { held?: unknown; restart?: unknown }
    return body.held === true && isHeld(body.restart) ? { held: true, restart: body.restart } : { held: false }
  } catch {
    return { held: false }
  }
}

/** Go past the hold: the host lets it go, saves why, and the page applies the update. */
export async function restartNow(version: string | null, ask: typeof fetch = fetch): Promise<void> {
  await ask('/host/restart/now', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'app-update', version }) }).catch(() => null)
}

/** What is held now, and whether an update the queue let go is the page's to apply (`go`, read once). */
export async function restartState(ask: typeof fetch = fetch): Promise<{ held: HeldRestart | null; go: boolean }> {
  try {
    const response = await ask('/host/restart/state')
    if (!response.ok) return { held: null, go: false }
    const body = (await response.json()) as { held?: unknown; go?: unknown }
    return { held: isHeld(body.held) ? body.held : null, go: !!body.go && typeof body.go === 'object' }
  } catch {
    return { held: null, go: false }
  }
}

/** The words for a held restart: who holds it and what it waits for. */
export function heldSaid(held: HeldRestart): string {
  if (held.ahead <= 0) return `${held.by} is about to restart Kehikot.`
  return `Waiting in ${held.by}: restarts when the ${held.ahead === 1 ? 'run' : `${held.ahead} runs`} ahead ${held.ahead === 1 ? 'finishes' : 'finish'}.`
}

/** The host said a held restart moved (`{ restart: true }` on `/host/watch`). */
const RESTART_CHANGED = 'kehikot:restart-changed'
export function announceRestartChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RESTART_CHANGED))
}
export function onRestartChanged(then: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(RESTART_CHANGED, then)
  return () => window.removeEventListener(RESTART_CHANGED, then)
}
