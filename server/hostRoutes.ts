import { frameOriginFor, routeOf, type ModuleRoute } from '../src/host/moduleAddress.ts'
import type { Presence } from './discover.ts'
import { toStart, type Standing } from './lifecycle.ts'
import type { ManifestCache } from './manifests.ts'
import type { ModuleProxy } from './moduleProxy.ts'
import { nextConnection, WATCH_RETRY_MS, type Openness } from './open.ts'
import { framedFetch, movedFrom, pageMovedLine, quietEntry, whyQuiet } from './quiet.ts'
import type { Registration } from './registrations.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'
import { pageStep, type StartupTimeline } from './startupTimeline.ts'
import type { VersionRuns } from './versionRuns.ts'
import type { Wakes } from './wake.ts'

/**
 * This host, to whoever asks, and the page's own line to it:
 *
 *  - `GET  /host/hello` — who is on this port, for another copy of this host.
 *  - `GET  /host/health` — whether this host is up, for the desktop app.
 *  - `GET  /host/startup`, `POST /host/startup` — when each step of this start happened; the page tells its own. The POST is the page's alone.
 *  - `GET  /host/quiet?id=M` — why a module that loaded its page said nothing.
 *  - `POST /host/open` — a page saying which kehikko it has open, or that it has gone away.
 *  - `GET  /host/watch` — the stream a page listens on, which is also its report of what it has open.
 */
export const HOST_ROUTES = {
  hello: { method: 'GET', path: '/host/hello' },
  startup: { method: 'GET', path: '/host/startup' },
  pageStep: { method: 'POST', path: '/host/startup', pageOnly: true },
  health: { method: 'GET', path: '/host/health' },
  quiet: { method: 'GET', path: '/host/quiet' },
  open: { method: 'POST', path: '/host/open' },
  watch: { method: 'GET', path: '/host/watch' },
} as const satisfies RouteTable

export interface HostRouteDeps<View extends { presences: readonly Presence[] }> {
  hostVersion: string
  port: number
  /** Whether this host serves the page itself (the desktop app's sidecar). */
  bundled: boolean
  /** Whether module addresses are on (`addressesOn`). */
  addresses: boolean
  startup: Pick<StartupTimeline, 'list' | 'mark'>
  registered: ReadonlyMap<string, Registration>
  manifests: Pick<ManifestCache, 'read'>
  /** Sweep the registry and ask every registered program what it is. */
  sweep(): Promise<View>
  /** Act on a sweep: start a module on an open kehikko that nothing answers for. */
  govern(presences: readonly Presence[]): void
  /** Where each module stands now, for the lifecycle's decisions. */
  standings(presences: readonly Presence[], now: number): Standing[]
  wakes: Pick<Wakes, 'registryChanged' | 'listen'>
  versionRuns: Pick<VersionRuns, 'all'>
  moduleProxy: Pick<ModuleProxy, 'answer'>
  openness: Pick<Openness, 'reported' | 'streamed' | 'closed'>
  /** What the pages say their modules declared for their headers. */
  headers: { held: { forget(page: string): void } }
  arranging: { forget(page: string): void }
  /** No idle timeout for this request. */
  patient(request: Request): void
  /** Watch the projects that have a screen, and stop watching the ones that lost theirs. */
  watchOpenProjects(): void
}

/** A frame's route at one of the stable frame addresses, or null: what `/host/quiet` asks through the proxy. */
function frameRouteOf(host: string, pathname: string): ModuleRoute | null {
  const route = routeOf(host, pathname)
  return route?.kind === 'frame' ? route : null
}

export function hostDesk<View extends { presences: readonly Presence[] }>(deps: HostRouteDeps<View>): Desk {
  const { startup, registered, manifests, sweep, govern, standings, wakes, versionRuns, moduleProxy, openness, arranging, patient, watchOpenProjects } = deps
  const { hostVersion: HOST_VERSION, port: PORT, bundled: BUNDLED, addresses: ADDRESSES } = deps
  const headerDesk = deps.headers
  return routes(HOST_ROUTES, {
    /**
     * Who is on this port.
     *
     * The one endpoint that exists to be asked by another copy of this program
     * rather than by a page. A host starting up needs to tell three things
     * apart on the address it wants — nothing, a stranger, and itself — and
     * without a way to say "I am a Kehikot host" the third is indistinguishable
     * from the second. See `server/ports.ts`.
     *
     * Deliberately tiny and deliberately unauthenticated: it says only what any
     * program that connected could already infer, and it must be answerable
     * before this host has decided anything at all.
     */
    hello: () => json({ ok: true, kehikko: true, version: HOST_VERSION, api: PORT, page: BUNDLED ? PORT : PORT + 1 }),

    /* When each step of this start happened (`startupTimeline.ts`), and the page's own steps, told by it. */
    startup: () => json({ ok: true, steps: startup.list() }),
    pageStep: async (request) => {
      const body = (await request.json().catch(() => null)) as { step?: unknown; at?: unknown } | null
      const step = pageStep(body?.step)
      if (!step) return json({ ok: false, error: 'Not a step a page reports.' }, 400)
      /* The page's wall clock, the same machine's: turned into this process's own time. */
      const at = typeof body?.at === 'number' && Number.isFinite(body.at) ? body.at - performance.timeOrigin : undefined
      startup.mark(step, at)
      return json({ ok: true })
    },

    /* Whether this host is up, for the desktop app that started it. */
    health: () => json({ ok: true, version: HOST_VERSION, bundled: BUNDLED }),

    /**
     * Why a module that loaded its page said nothing.
     *
     * Asked by the page, on the greeting deadline, because the page CANNOT ask
     * the module itself: a framed module is cross-origin and sets no CORS
     * headers, on purpose. This server has no such limit — it fetches every
     * module's manifest on every sweep — so the question comes here and the
     * looking happens with the same eyes `discover.ts` uses.
     *
     * The registration is the source of the address, never the caller. A page
     * that could name any origin and have this host fetch it would be a request
     * forgery door in a program whose whole job is talking to loopback ports.
     */
    quiet: async (_request, url) => {
      const id = url.searchParams.get('id') ?? ''
      const registration = registered.get(id)
      if (!registration) {
        return json({ ok: false, error: 'No module is registered under that id.' }, 404)
      }
      /* Asked now, whatever was kept: the page says its module went quiet. */
      const presence = await manifests.read(registration, { fresh: true })
      if (!presence.reached) {
        /* A page reported that its module stopped answering, and nothing is
           listening there: the container must not wait for the watch to say so. */
        void sweep()
          .then((view) => govern(view.presences))
          .catch(() => null)
          .finally(() => wakes.registryChanged())
      }
      if (presence.condition !== 'ready' || !presence.module) {
        /* It is not answering at all any more, which `discover.ts` already has
           a careful sentence for. Hand that back rather than inventing a second
           reading of the same fact. */
        return json({ ok: true, kind: 'gone', line: presence.line })
      }
      /* The address the frame was given, held to the module's stable one or its own
         (`quietEntry`), and asked through the proxy when it is the stable one. */
      const stable = ADDRESSES ? frameOriginFor(id, PORT) : null
      const framed = url.searchParams.get('framed')
      /* The frame holds a page from before the module was started again elsewhere: fetching the
         module where it is NOW would find everything in order and blame it for a page it never
         served. Said as what it is, and the page loads the frame again from the new address. */
      const pinnedAt = versionRuns.all().filter((one) => one.id === id).map((one) => one.origin)
      const from = movedFrom(presence.module.entry, framed, stable, pinnedAt)
      if (from) return json({ ok: true, kind: 'moved', line: pageMovedLine(presence.module.name, from, presence.module.entry), checked: presence.module.entry })
      const checked = quietEntry(presence.module.entry, framed, stable)
      const via = checked === presence.module.entry ? fetch : framedFetch(frameRouteOf, (asked, route) => moduleProxy.answer(asked, route))
      const said = await whyQuiet(presence.module.name, checked, via)
      return json({ ok: true, kind: said.kind, line: said.line, checked })
    },

    /*
     * A page saying which kehikko it has open, or that it has gone away.
     *
     * The one fact this server deliberately does not store — see the essay at
     * the top of `canvases.ts` — and it is still not stored: this is held in
     * memory, per page, and dies with the process. What it is FOR is the MCP
     * door, which has to answer "which kehikko did you mean" without guessing.
     *
     * The page id is the page's own, minted per tab. It is not a credential and
     * there is nothing behind it: the worst a second program on this machine
     * can do by posting one is make the door refuse, by claiming a second
     * kehikko is open — which is a refusal with both ids in it and not a wrong
     * answer, and is exactly what the door does when two windows really are
     * open.
     */
    open: async (request) => {
      const body = (await request.json().catch(() => null)) as {
        page?: unknown
        kehikko?: unknown
      } | null
      const page = typeof body?.page === 'string' && body.page.length > 0 && body.page.length <= 64 ? body.page : null
      if (!page) return json({ ok: false, error: 'A report of what is open names the page making it.' }, 400)
      const kehikko =
        typeof body?.kehikko === 'number' && Number.isInteger(body.kehikko) && body.kehikko > 0
          ? body.kehikko
          : null
      openness.reported(page, kehikko)
      if (kehikko !== null) startup.mark('page reported its kehikko')
      /* A page on its way out has no frames left to have declared anything. */
      if (kehikko === null) {
        headerDesk.held.forget(page)
        arranging.forget(page)
      }
      /* A kehikko was just opened, so the set of modules anybody is looking at
         has just changed — which is the whole trigger this design runs on. The
         sweep reads the kept manifests (`manifests`), so this costs no request
         to a module that has not changed, and is awaited: the answer says
         whether anything was started, and the page sweeps after it only then
         (`arrive` in `src/host/looks.ts`). A withdrawal decides nothing new. */
      if (kehikko === null) return json({ ok: true, started: false })
      try {
        const view = await sweep()
        const started = toStart(standings(view.presences, Date.now())).length > 0
        govern(view.presences)
        return json({ ok: true, started })
      } catch {
        /* A sweep that failed is a decision not made, which is the safe one; the page looks. */
        return json({ ok: true, started: true })
      }
    },

    /*
     * The stream a page listens on to hear that a kehikko changed under it.
     *
     * Server-sent events, one id per message, and nothing else on it — see
     * `wake.ts` for why what travels is that there IS news rather than the news
     * itself.
     *
     * The comment sent on connect is not decoration: it flushes the headers, so
     * a proxy in the middle — Vite's, here — hands the stream to the page
     * immediately instead of holding it until the first real event, which might
     * be an hour away.
     *
     * ## It is also how a page stops saying it has a kehikko open
     *
     * `/host/open` is a page SAYING what it has open, and it has one hole: a
     * page that dies without running `pagehide` — a crashed tab, a force-quit
     * browser, a headless one closed abruptly — never withdraws, and `open.ts`
     * deliberately keeps believing it for half a day rather than make the page
     * poll. Nothing was harmed by that while only an agent read the report. Now
     * the lifecycle policy reads it too, and a report nobody is behind is a
     * kehikko's worth of modules kept running for a screen that stopped
     * existing.
     *
     * A socket is the honest answer, because it costs nothing per tick and it
     * ends exactly when the browser does. So this URL carries the same two
     * facts `/host/open` carries and is treated the same way: the report stands
     * while the stream is open and is withdrawn when it closes. The page puts
     * the kehikko on the url rather than sending it once, because `EventSource`
     * reconnects on its own and a reconnection that said nothing would withdraw
     * a report it then never restored.
     */
    watch: (request, url) => {
      /* No idle timeout on this one. Nothing is sent until something happens,
         so the server's thirty seconds closed every quiet stream, and a wake
         sent while the page was reconnecting was a wake nobody heard — a
         container left on what was true before a restart. */
      patient(request)
      const encoder = new TextEncoder()
      let stop: (() => void) | null = null
      const said = url.searchParams.get('page')
      const page = said && said.length > 0 && said.length <= 64 ? said : null
      const asked = Number(url.searchParams.get('kehikko'))
      const kehikko = Number.isInteger(asked) && asked > 0 ? asked : null
      /* This connection's own identity. A stream is evidence that a screen
         exists, and it is kept under the connection rather than the page
         because a page has several of these over its life — see the essay at
         the top of `open.ts`. */
      const connection = nextConnection()
      const stream = new ReadableStream({
        start(controller) {
          /* `retry` sets how soon the browser reconnects after this stream
             drops — a restart of this server, above all. Its own default is
             a few seconds, and a page that waits that long is a page the MCP
             door says has nothing open for that long. */
          controller.enqueue(encoder.encode(`: listening\nretry: ${WATCH_RETRY_MS}\n\n`))
          if (page && kehikko !== null) {
            openness.streamed(connection, page, kehikko)
            /* A report, so acted on like one: what that kehikko has is started
               now, whatever became of the page's own POST and sweep. A page
               that has made those makes nothing more until it is focused or
               pressed, and this stream is the one request it is sure to hold.
               The pages are told only when something was started — a wake
               makes every page sweep, and a stream opens on every switch. */
            void sweep()
              .then((view) => {
                const begins = toStart(standings(view.presences, Date.now())).length > 0
                govern(view.presences)
                if (begins) wakes.registryChanged()
              })
              .catch(() => {
                /* A sweep that failed is a decision not made, which is the safe one. */
              })
          }
          /* A screen is standing in a project: its `.kehikot/` is watched for
             as long as one is. See `ContentWatch`. */
          watchOpenProjects()
          /* The news is written as it was given. `Wakes` decides what shapes
             travel — see `News` there — and a server that rebuilt the object
             here would be a second place for the two ends to disagree. */
          stop = wakes.listen((news) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(news)}\n\n`))
          }, page)
        },
        cancel() {
          stop?.()
          /* This stream's own evidence, withdrawn rather than left to go stale
             — which is the whole reason the page identifies itself here. What
             any other connection or the page itself has said is untouched. */
          openness.closed(connection)
          watchOpenProjects()
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      })
    },
  })
}
