import type { Registration } from './registrations.ts'

/**
 * "Stop" on a module's row in the Kehikko modules menu, and what remembers it.
 *
 * ## Who it is for
 *
 * The child this host started and holds (`held`: it is in the nursery). It is
 * stopped by its handle, as Restart stops it (`Nursery.stop`: SIGTERM to the
 * child's own group, never a pattern, never a port lookup), and nothing else
 * is ever signalled. Anything that answers at the module's address and is not
 * that child was started outside Kehikot and is refused with `STARTED_OUTSIDE`
 * before anything is touched. A module that is not running is already stopped:
 * it is remembered as stopped and nothing is signalled.
 *
 * ## How long "stopped" holds
 *
 * Until the person presses Start (or Restart) on it, or the app starts again:
 * the set is in memory and nothing writes it down. Until then the host does not
 * start it by itself: `toStart` and `toWarm` skip it (`Standing.failed`, which
 * already means "not started a second time on its own"), and `begin` — the one
 * place those start anything — refuses it too. An open kehikko that has the
 * module does not bring it back; its container says "not running" with Start.
 * A frame that recovers after a restart only reloads a document when a module
 * answers, so it starts nothing. Only a person's press clears it.
 *
 * ## Who can press it
 *
 * A person at the page. The route is in `PAGE_ONLY` (`guard.ts`) and no MCP
 * tool stops a module.
 */

/** What a module this host did not start is told. The page says the same on the disabled row. */
export const STARTED_OUTSIDE = 'Started outside Kehikot: stop it where it runs'

/**
 * The modules a person stopped, in memory only. Read by the host's own start rules as "do not start
 * this one by yourself"; cleared by a person's press on Start or Restart, or by the app starting again.
 */
export class StoppedByPerson {
  readonly #ids = new Set<string>()
  stop(id: string): void {
    this.#ids.add(id)
  }
  /** A person pressed Start or Restart. */
  pressed(id: string): void {
    this.#ids.delete(id)
  }
  has(id: string): boolean {
    return this.#ids.has(id)
  }
  forgetAllBut(here: ReadonlySet<string>): void {
    for (const id of [...this.#ids]) if (!here.has(id)) this.#ids.delete(id)
  }
}

export interface StopModuleDeps {
  /** The registration as it is on disk at the press. */
  registration(id: string): Promise<Registration | null>
  /** An update, a start or a restart of it is in hand somewhere else. */
  busy(id: string): boolean
  /** Whether this host holds a live child for it (`Nursery.holds`). */
  held(id: string): boolean
  /** Whether anything at all answers at the registration's address. */
  reached(registration: Registration): Promise<boolean>
  /** Stop the held child by its handle and wait for its address to come free; remember it as stopped. */
  stop(id: string, registration: Registration): Promise<void>
}

/** `POST /host/stop-module`: `{ module }`. */
export function stopModuleDesk(deps: StopModuleDeps) {
  const claimed = new Set<string>()

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/host/stop-module' || request.method !== 'POST') return null
    const body = (await request.json().catch(() => null)) as { module?: unknown } | null
    if (!body || typeof body.module !== 'string' || body.module.length === 0 || body.module.length > 64) {
      return reply({ ok: false, why: 'A stop names one module.' }, 400)
    }
    const id = body.module
    if (claimed.has(id)) return reply({ ok: false, busy: true, why: `${id} is already being stopped. Nothing more was done.` }, 409)
    claimed.add(id)
    try {
      const registration = await deps.registration(id)
      if (!registration) return reply({ ok: false, why: 'There is no registration for that module.' }, 409)
      if (!registration.dir) return reply({ ok: false, external: true, why: STARTED_OUTSIDE }, 409)
      if (deps.busy(id)) return reply({ ok: false, busy: true, why: `${id} is being started, restarted or updated. Nothing was stopped.` }, 409)
      if (registration.keep === true) {
        return reply({ ok: false, kept: true, why: 'Its registration says to keep it running, so Kehikot does not stop it. Use Restart anyway to override that.' }, 409)
      }
      /* Something answers that this host did not start: it is left alone. */
      if (!deps.held(id) && (await deps.reached(registration))) return reply({ ok: false, external: true, why: STARTED_OUTSIDE }, 409)
      await deps.stop(id, registration)
      return reply({ ok: true })
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
