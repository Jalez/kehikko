import { writeFileSync } from 'node:fs'
import type { Database } from 'bun:sqlite'

import { writeRestartReason, type RestartHold, type RestartWhy } from './restartHold.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'

/**
 * Restarting the whole app:
 *
 *  - `POST /host/restart/queue` — "Restart to update", waiting for queued work. The page's alone.
 *  - `POST /host/restart/now` — Restart now, past a hold. The page's alone.
 *  - `GET  /host/restart/state` — what is held, and an update the queue let go.
 *  - `POST /host/restart` — a plain restart, for a host the desktop app started.
 */
export const RESTART_ROUTES = {
  restartQueue: { method: 'POST', path: '/host/restart/queue', pageOnly: true },
  restartNow: { method: 'POST', path: '/host/restart/now', pageOnly: true },
  restartState: { method: 'GET', path: '/host/restart/state' },
  restart: { method: 'POST', path: '/host/restart' },
} as const satisfies RouteTable

export interface RestartDeps {
  db: Database
  /** Where the desktop shell watches for a restart request, when it started this host. */
  restartFile: string | null
  restartHold: Pick<RestartHold, 'ask' | 'drop' | 'state'>
  /** The page is told a restart's hold changed. */
  restartChanged(): void
  /** Restart the app now for `why` (`restartFor`). */
  restartFor(why: RestartWhy): { ok: true; page: boolean } | { ok: false; why: string }
  /** An app update the queue let go, for the page to apply: read once, and cleared. */
  takeRestartGo(): (RestartWhy & { at: number }) | null
}

export function restartDesk(deps: RestartDeps): Desk {
  const { db, restartHold, restartFor } = deps
  const RESTART_FILE = deps.restartFile
  return routes(RESTART_ROUTES, {
    /*
     * An app restart that waits for queued work (protocol 2.110.0, `restartHold.ts`). The page's
     * "Restart to update" asks here first: held by the work queue, it waits (the page says so, with
     * Restart now); not held, it goes now — saved for the next host, applied by the page for an update.
     */
    restartQueue: async (request) => {
      const body = (await request.json().catch(() => null)) as { reason?: unknown; version?: unknown } | null
      const reason = body?.reason === 'app-restart' ? 'app-restart' : body?.reason === 'app-update' ? 'app-update' : null
      if (!reason) return json({ error: 'say the reason: app-update or app-restart' }, 400)
      const version = typeof body?.version === 'string' ? body.version : null
      const label = reason === 'app-update' ? `Restart Kehikot to update${version ? ` to ${version}` : ''}` : 'Restart Kehikot'
      const asked = await restartHold.ask({ reason, version, label })
      if (asked.held) {
        deps.restartChanged()
        return json({ held: true, restart: asked.restart })
      }
      const went = restartFor({ reason, version: version && /^\d+\.\d+\.\d+/.test(version) ? version : null })
      return went.ok ? json({ held: false, page: went.page, why: asked.why }) : json({ error: went.why }, 409)
    },
    /* Restart now, past a hold: what was held is let go (the queue's row says the host went another way). */
    restartNow: async (request) => {
      const was = restartHold.drop()
      const body = (await request.json().catch(() => null)) as { reason?: unknown; version?: unknown } | null
      const reason = was?.reason ?? (body?.reason === 'app-restart' ? 'app-restart' : 'app-update')
      const version = was?.version ?? (typeof body?.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version) ? body.version : null)
      const went = restartFor({ reason, version })
      deps.restartChanged()
      return went.ok ? json({ ok: true, page: went.page }) : json({ error: went.why }, 409)
    },
    /* What is held, and whether an update the queue let go is the page's to apply now (read once). */
    restartState: () => {
      const go = deps.takeRestartGo()
      return json({ held: restartHold.state(), go: go ? { version: go.version } : null })
    },

    /*
     * Restart the whole app, so a server that was just updated actually runs.
     *
     * Only the desktop shell can do it, and only for a host it started: it gives
     * that host `KEHIKKO_RESTART_FILE` and watches for the file. This writes
     * it; the shell stops this process group and relaunches itself, which starts
     * a fresh host. Without the variable — a host run from a terminal, or one the
     * shell adopted — nothing would bring this back, so it is a refusal.
     */
    restart: () => {
      if (!RESTART_FILE) {
        return json({ error: 'This host was not started by the Kehikot app, so nothing here can restart it. Quit and reopen it yourself.' }, 409)
      }
      try {
        /* Saved for the next host, so the modules it starts say why (protocol 2.110.0). */
        writeRestartReason(db, { reason: 'app-restart', version: null })
        writeFileSync(RESTART_FILE, new Date().toISOString())
      } catch (error) {
        return json({ error: `The restart could not be asked for: ${(error as Error).message}` }, 500)
      }
      return json({ ok: true })
    },
  })
}
