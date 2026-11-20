import { PACKAGE_VERSION } from 'kehikot-module-protocol'

import type { JobSteps } from './jobSteps.ts'
import type { UpdatePreview } from './restart.ts'
import { json, moduleIn, routes, type Desk, type RouteTable } from './routes.ts'
import { readCheckout, topLevels, type Place, type Reading } from './updates.ts'

/** Where one update has got. `applying` is the checkout having moved: from there nothing is cancelled. */
export type UpdateStep = 'updating' | 'applying' | 'installing' | 'preparing' | 'restarting'
export type Phase = (now: UpdateStep) => void

/**
 * Whether the host and the modules are behind GitHub, and catching them up:
 *
 *  - `GET  /host/updates` — every checkout, read (and with `fetch=1`, fetched).
 *  - `GET  /host/module-release` — one installed module's releases.
 *  - `GET  /host/steps`, `POST /host/steps/cancel` — how far each install and update has got, and Cancel. Cancel is the page's alone.
 *  - `POST /host/updates/cancel` — Cancel for an update a page started. The page's alone.
 *  - `POST /host/updates` — one update, answered as it goes, one JSON object a line.
 *  - `POST /host/updates/step-back` — the person's "Step back to …?", then the same update. The page's alone.
 */
export const UPDATE_ROUTES = {
  updates: { method: 'GET', path: '/host/updates' },
  moduleRelease: { method: 'GET', path: '/host/module-release' },
  steps: { method: 'GET', path: '/host/steps' },
  stepsCancel: { method: 'POST', path: '/host/steps/cancel', pageOnly: true },
  updatesCancel: { method: 'POST', path: '/host/updates/cancel', pageOnly: true },
  update: { method: 'POST', path: '/host/updates' },
  stepBack: { method: 'POST', path: '/host/updates/step-back', pageOnly: true },
} as const satisfies RouteTable

export interface UpdateDeps {
  /** The host (when it is a checkout) and every registered module that names a directory. */
  updatePlaces(): Place[]
  /** One module's place, with its releases when it is installed. */
  placeOf(id: string, dir: string): Place
  official: { refresh(): Promise<void> }
  appProtocols: { settled(ms: number, running?: string | null): Promise<void> }
  auto: { found(checkouts: readonly Reading[]): Promise<unknown>; settled(id: string): void; said(): unknown }
  judgeStaleness(press?: boolean): Promise<void>
  /** Whether this host was started by the desktop app, which alone can restart it. */
  restartable: boolean
  /** An update still running, by checkout. */
  progress: Map<string, UpdateStep>
  staleness: { all(): unknown; older(): unknown }
  updatePreviews(checkouts: readonly Reading[]): Promise<Record<string, UpdatePreview>>
  /** Which modules have containers pinned to a version. */
  pinned(): unknown
  keptAndRunning(): Promise<string[]>
  /** Which modules a restart ends live sessions in. */
  holds(): string[]
  builds: { said(): unknown }
  registrationOf(id: string): Promise<{ dir?: string } | null>
  isInstalled(dir: string): boolean
  buildOf(id: string, dir: string, installed: boolean): Promise<unknown>
  jobSteps: Pick<JobSteps, 'said' | 'active' | 'cancel'>
  /** How to stop an update a page started, by checkout. */
  updateCancels: Map<string, AbortController>
  /** No idle timeout for this request. */
  patient(request: Request): void
  updateHost(place: Place, signal: AbortSignal, phase: Phase): Promise<unknown>
  updateModule(place: Place, signal: AbortSignal, phase: Phase): Promise<unknown>
}

export function updateDesk(deps: UpdateDeps): Desk {
  const { updatePlaces, official, appProtocols, auto, judgeStaleness, progress, staleness, updatePreviews, keptAndRunning, builds, registrationOf, buildOf, placeOf, jobSteps, updateCancels, patient, updateHost, updateModule } = deps

  /*
   * `/host/updates/step-back` is the person's press of "Step back to …?" on an installed copy
   * whose release needs a newer Kehikot, where moving it back on its own was not safe enough
   * (`back.ask`, `moduleReleases.ts`). It allows that one move and then runs the same update.
   * The page's alone (`PAGE_ONLY`): no program decides to risk a person's data.
   */
  async function update(request: Request, url: URL): Promise<Response> {
    const stepping = url.pathname === '/host/updates/step-back'
    const body = (await request.json().catch(() => null)) as { id?: unknown; to?: unknown } | null
    if (!body || typeof body.id !== 'string') return json({ error: 'An update names one checkout.' }, 400)
    const { places } = await topLevels(updatePlaces())
    const place = places.find((one) => one.id === body.id)
    if (!place) return json({ error: `There is no checkout called ${body.id} to update.` }, 404)
    if (progress.has(place.id)) return json({ error: `${place.name} is already being updated.` }, 409)
    if (stepping) {
      if (typeof body.to !== 'string' || !place.releases?.allow) return json({ error: 'A step back names an installed module and the release it moves to.' }, 400)
      const before = await readCheckout(place, false, request.signal)
      if ('error' in before) return json({ error: before.error }, 409)
      if (before.release?.back?.to !== body.to) return json({ error: `${place.name} has no step back to ${body.to} waiting.` }, 409)
      place.releases.allow(place.id, body.to)
    }
    /* An install and a restart outlast the idle timeout, and a line is only
       written when something changes. */
    patient(request)
    /* The update is the server's, not the request's: it runs to its end when
       the page closes the panel, reloads, or drops the connection. */
    const own = new AbortController()
    updateCancels.set(place.id, own)
    /* One JSON object per line: `{phase}` as the update moves, then `{done}`
       or `{error}`. It is finished whether or not anybody is still reading —
       see "Cancelling" in `updates.ts`. */
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(controller) {
          const say = (line: unknown) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
            } catch {
              /* Nobody is reading any more. */
            }
          }
          const phase: Phase = (now) => {
            progress.set(place.id, now)
            say({ phase: now })
          }
          try {
            phase('updating')
            say(place.id === 'host' ? await updateHost(place, own.signal, phase) : await updateModule(place, own.signal, phase))
            /* A press took it: whatever the switch had read or was waiting for is out of date. */
            if (place.id !== 'host') auto.settled(place.id)
          } catch (error) {
            say({ error: (error as Error).message })
          } finally {
            progress.delete(place.id)
            updateCancels.delete(place.id)
            try {
              controller.close()
            } catch {
              /* Already closed by the reader going away. */
            }
          }
        },
      }),
      { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } },
    )
  }

  return routes(UPDATE_ROUTES, {
    /*
     * Whether the host and the modules are behind GitHub, and catching them up.
     *
     * The places come from this process — its own checkout, and the `dir` of
     * each registration — never from the request. What arrives over the wire
     * is an id, as with Start, and an id that names nothing is a refusal.
     * `server/updates.ts` has the rules about what an update will touch.
     */
    updates: async (request, url) => {
      const { places, unreadable } = await topLevels(updatePlaces())
      const fetch = url.searchParams.get('fetch') === '1'
      /* `quiet=1`: the page's automatic check, not a press. Each checkout's remote is compared
         with `git ls-remote` and fetched only when it moved — and never a checkout somebody edits;
         that waits for Check now. See `readCheckout`. */
      const quiet = fetch && url.searchParams.get('quiet') === '1'
      const app = url.searchParams.get('app')
      const runningApp = app && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(app) ? app : null
      /* Somebody asked what is new: that includes which modules exist. Not
         waited for — the answer here is about checkouts. */
      if (fetch) void official.refresh()
      /* And which Kehikot each release works with: read at most daily, so
         this is nearly always instant; never waited for long. */
      if (fetch) await appProtocols.settled(4_000, runningApp)
      const checkouts = await Promise.all(places.map((place) => readCheckout(place, quiet ? 'compare' : fetch, request.signal)))
      /* A check: "Keep modules up to date automatically" takes what it found (`autoUpdates.ts`).
         Queued before the answer, so the answer already says what waits. Never awaited. */
      if (fetch) void auto.found(checkouts)
      await judgeStaleness(fetch && !quiet)
      return json({
        checked: new Date().toISOString(),
        checkouts: [...checkouts, ...unreadable],
        restartable: deps.restartable,
        /* What only this server knows, so a page that reloads still reads it:
           an update still running, and a module left on old code. */
        progress: Object.fromEntries(progress),
        stale: staleness.all(),
        /* And the ones whose own build identity says they are behind their
           checkout — a fact, where `stale` is what the host could not rule out. */
        older: staleness.older(),
        /* What each update would do to its module if pressed now, so the row
           can say so first. From the upstream as already fetched and the last
           sweep: no second round to the remote, and no asking of ports. */
        previews: await updatePreviews(checkouts),
        /* Which modules have containers pinned to a version, so the panel can
           say so and the header does not count them as waiting. */
        pins: deps.pinned(),
        /* Which running modules are kept: the ones whose row offers "Restart
           anyway" where an ordinary restart would only be refused. */
        kept: await keptAndRunning(),
        /* Which modules a restart ends live sessions in (`holdsShells`): their row's restart says so. */
        holds: deps.holds(),
        /* The protocol package this host has: what "you have" is compared
           with when the page does not know the app's version. */
        protocol: PACKAGE_VERSION,
        /* Installed copies being built ("Preparing Terminal…"), and the ones
           whose build did not finish and run from source. See `moduleBuilds.ts`. */
        builds: builds.said(),
        /* "Keep modules up to date automatically": the switch, what waits and why, and what it updated. */
        auto: auto.said(),
      })
    },

    /*
     * One installed module's releases, for its details in the modules list:
     * the one it runs, the newest, and which Kehikot each works with. Read
     * from the copy's own tags — nothing is asked of the remote. The id names
     * a registration; the directory is the registration's, never the request's.
     */
    moduleRelease: async (request, url) => {
      const id = moduleIn(url.searchParams.get('id'))
      if (!id) return json({ error: 'Name a module: /host/module-release?id=…' }, 400)
      const registration = await registrationOf(id)
      if (!registration?.dir || !deps.isInstalled(registration.dir)) {
        /* A checkout somebody registered is never built here; what it runs is still said. */
        return json({ release: null, protocol: PACKAGE_VERSION, ...(registration?.dir ? { build: await buildOf(id, registration.dir, false) } : {}) })
      }
      await appProtocols.settled(2_000)
      const reading = await readCheckout(placeOf(id, registration.dir), false, request.signal)
      return json({ release: 'error' in reading ? null : (reading.release ?? null), protocol: PACKAGE_VERSION, build: await buildOf(id, registration.dir, true) })
    },

    /*
     * How far each install and update has got, step by step (`jobSteps.ts`), and Cancel for one of
     * them: it stops the processes that job started, by pid, and nothing else. Cancel is the page's
     * alone (`PAGE_ONLY`).
     */
    steps: () => json({ jobs: jobSteps.said(), active: jobSteps.active() }),
    stepsCancel: async (request) => {
      const body = (await request.json().catch(() => null)) as { id?: unknown } | null
      const id = moduleIn(body?.id)
      if (!id) return json({ error: 'A cancel names one module.' }, 400)
      return json({ cancelled: jobSteps.cancel(id) })
    },

    /* Cancel: the only way to stop an update a page started. Before the merge it
       leaves the checkout as it was; after it, nothing is cancelled (`updates.ts`). */
    updatesCancel: async (request) => {
      const body = (await request.json().catch(() => null)) as { id?: unknown } | null
      if (!body || typeof body.id !== 'string') return json({ error: 'A cancel names one checkout.' }, 400)
      const running = updateCancels.get(body.id)
      running?.abort()
      return json({ cancelled: running !== undefined })
    },

    update,
    stepBack: update,
  })
}
