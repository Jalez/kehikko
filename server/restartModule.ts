import type { Runnable, Startable } from './launch.ts'
import type { Registration } from './registrations.ts'

/**
 * "Restart module": the item at the foot of every module's Run menu.
 *
 * ## One path
 *
 * This is not a second way to restart. `restart` in `server.ts` is the one
 * path for the Start button, the retry in the Updates panel and the restart an
 * update does by itself: it stops the process THIS host started by its handle
 * (SIGTERM to its group, never a pattern), waits for the port to come free,
 * runs `run.sh` again with the same environment, and covers the container as
 * `restarting` while it does. This file is the door in front of it for a
 * person's press, and says no in the places the others do not need to.
 *
 * ## Who it is for
 *
 * A module this host starts: a registration with a directory and a `run.sh`
 * (`startable`). One registered with only a URL is somebody else's program; the
 * answer names that and nothing is signalled. A `keep` module is refused by
 * `restart` with its own sentence — "Restart anyway" (`anyway.ts`) is how a
 * person overrides that.
 *
 * ## One at a time
 *
 * A second press while the first is in hand does nothing: it is answered
 * `busy` and nothing is stopped or started. The claim is taken before anything
 * is awaited, so two presses in one tick are still one restart.
 *
 * ## Who can press it
 *
 * A person at the page. The route is in `PAGE_ONLY` (`guard.ts`) and no MCP
 * tool restarts a module.
 */

/** How long the host waits for the module to answer again before saying it did not. */
export const RESTART_WITHIN_MS = 30_000

/** What a module registered without a directory is told. */
export const NOT_STARTED_BY_US = "Kehikot didn't start this module, so it can't restart it."

export type Restarted =
  | { ok: true; answered: boolean; detail: string[]; presence: unknown }
  | { ok: false; why: string; detail?: string[]; refused?: boolean; kept?: boolean }

export interface RestartModuleDeps {
  /** The registration as it is on disk at the press. */
  registration(id: string): Promise<Registration | null>
  startable(registration: Registration | null): Startable
  /** An update, a start or a restart of it is already in hand somewhere else. */
  busy(id: string): boolean
  /** Stop the process this host started for it and start it again: `restart` in `server.ts`. */
  restart(id: string, registration: Registration, run: Runnable, within: number): Promise<Restarted>
  /** Before the wait for it to come back, which outlasts an idle connection. */
  patient?(request: Request): void
}

/** `POST /host/restart-module`: `{ module }`. */
export function restartModuleDesk(deps: RestartModuleDeps) {
  /** The modules a restart from this door is in hand for. */
  const claimed = new Set<string>()

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/host/restart-module' || request.method !== 'POST') return null
    const body = (await request.json().catch(() => null)) as { module?: unknown } | null
    if (!body || typeof body.module !== 'string' || body.module.length === 0 || body.module.length > 64) {
      return reply({ ok: false, why: 'A restart names one module.' }, 400)
    }
    const id = body.module

    /* Taken before the first await: two presses in one tick are one restart. */
    if (claimed.has(id)) return reply({ ok: false, busy: true, why: `${id} is already restarting. Nothing more was done.` }, 409)
    claimed.add(id)
    try {
      const registration = await deps.registration(id)
      if (!registration) return reply({ ok: false, why: 'There is no registration for that module.' }, 409)
      if (!registration.dir) return reply({ ok: false, external: true, why: NOT_STARTED_BY_US }, 409)
      const can = deps.startable(registration)
      if (!can.ok) return reply({ ok: false, why: can.why }, 409)
      if (deps.busy(id)) return reply({ ok: false, busy: true, why: `${id} is already being started, restarted or updated. Nothing more was done.` }, 409)

      deps.patient?.(request)
      const done = await deps.restart(id, registration, can.run, RESTART_WITHIN_MS)
      if (!done.ok) {
        return reply({ ok: false, why: done.why, detail: done.detail ?? [], ...(done.kept ? { kept: true } : {}) }, 409)
      }
      if (!done.answered) {
        return reply(
          {
            ok: false,
            timedOut: true,
            why: `${id} was started again and has not answered after ${RESTART_WITHIN_MS / 1000} seconds.`,
            detail: done.detail,
          },
          409,
        )
      }
      return reply({ ok: true, presence: done.presence })
    } finally {
      claimed.delete(id)
    }
  }

  return { route }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
