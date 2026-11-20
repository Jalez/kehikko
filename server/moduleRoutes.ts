import type { Presence } from './discover.ts'
import type { Runnable, Startable } from './launch.ts'
import type { Pins } from './pins.ts'
import { readRegistrations, type Registration } from './registrations.ts'
import { json, moduleIn, routes, type Desk, type RouteTable } from './routes.ts'
import type { StartupTimeline } from './startupTimeline.ts'

/**
 * What is registered, and starting one:
 *
 *  - `GET  /host/modules` — every registered module and what the host made of it; a sweep, and what it starts.
 *  - `GET  /host/versions`, `POST /host/versions` — a module's versions for a container, and pinning one.
 *  - `POST /host/start` — Start, a person's press.
 */
export const MODULE_ROUTES = {
  modules: { method: 'GET', path: '/host/modules' },
  versions: { method: 'GET', path: '/host/versions' },
  pin: { method: 'POST', path: '/host/versions' },
  start: { method: 'POST', path: '/host/start' },
} as const satisfies RouteTable

/** What a pressed start came to (`startOnce`). */
type StartDone =
  | { ok: true; answered: boolean; detail: string[]; presence: unknown; moved?: { runnable: { command: string }; line: string } }
  | { ok: false; why: string; detail?: string[]; kept?: boolean }

export interface ModuleRouteDeps<View extends { presences: readonly Presence[] }> {
  startup: Pick<StartupTimeline, 'mark'>
  /** Sweep the registry and ask every registered program what it is; `true` asks every manifest again. */
  sweep(press: boolean): Promise<View>
  /** Act on a sweep: start a module on an open kehikko that nothing answers for. */
  govern(presences: readonly Presence[]): void
  /** What the page is answered about a sweep. */
  pageView(view: View, press: boolean): Promise<unknown>
  pins: Pick<Pins, 'list' | 'pin'>
  /** Whether a registration can be started, and with what. */
  startable(registration: Registration | null): Startable
  stoppedByPerson: { pressed(id: string): void }
  /** Stop a module if it is running, start it, and say what came of it. */
  startOnce(id: string, registration: Registration | null, runnable: Runnable, within: number): Promise<StartDone>
  /** How long a pressed start waits for an answer before saying it has not come yet. */
  answersWithinPressMs: number
}

export function moduleDesk<View extends { presences: readonly Presence[] }>(deps: ModuleRouteDeps<View>): Desk {
  const { startup, sweep, govern, pageView, pins, startable, stoppedByPerson, startOnce } = deps
  const ANSWERS_WITHIN_PRESS_MS = deps.answersWithinPressMs
  return routes(MODULE_ROUTES, {
    /* What is registered, and what the host made of each of them. The page asks
       for this on load and whenever the person asks it to look again; there is
       no polling, because a host that re-swept every second would be a host
       hammering somebody's own machine to tell them nothing changed. */
    modules: async (_request, url) => {
      /* `fresh=1`: a person pressed something (look again, Start, an install), so every
         manifest is asked again; otherwise what `manifests` keeps stands. */
      const press = url.searchParams.get('fresh') === '1'
      startup.mark('page asked for the modules')
      const view = await sweep(press)
      /* And then act on it. A sweep is the only moment the host knows both what
         is running and what is wanted, so it is where a module on the open
         kehikko that nothing answers for gets started. Synchronous — it spawns
         and returns — so the answer below already says `starting` about
         whatever was just run, and the container says so instead of sitting on
         a sentence about a program that is not running. */
      govern(view.presences)
      const answer = await pageView(view, press)
      startup.mark('page given the modules')
      return json(answer)
    },

    /* A module's versions, for the picker in a container's header: its own
       checkout first, then its tags, each marked for that kehikko's project. */
    versions: async (_request, url) => {
      const module = moduleIn(url.searchParams.get('module'))
      const kehikko = Number(url.searchParams.get('kehikko'))
      if (!module || !Number.isInteger(kehikko) || kehikko <= 0) {
        return json({ error: 'Name a module and a kehikko: /host/versions?module=…&kehikko=…' }, 400)
      }
      const listed = await pins.list(module, kehikko, url.searchParams.get('fresh') === '1')
      return 'why' in listed ? json({ error: listed.why }, listed.status) : json(listed)
    },

    /* Pin a container to a version, or back to latest with `version: null`. */
    pin: async (request) => {
      const body = (await request.json().catch(() => null)) as { module?: unknown; kehikko?: unknown; version?: unknown } | null
      const module = moduleIn(body?.module)
      const kehikko = body?.kehikko
      if (!module || typeof kehikko !== 'number' || !Number.isInteger(kehikko) || kehikko <= 0) {
        return json({ error: 'A pin names a module, a kehikko, and a version (null for latest).' }, 400)
      }
      const version = body?.version === null || body?.version === undefined ? null : body.version
      if (version !== null && typeof version !== 'string') return json({ error: 'version is a tag such as v1.2.0, or null.' }, 400)
      const pinned = await pins.pin(kehikko, module, version)
      if (!pinned.ok) return json({ error: pinned.why }, pinned.status)
      return json({ ok: true, text: pinned.text })
    },

    /*
     * Start a module that is not running.
     *
     * A press, never anything else. There is no autostart and no retry: see the
     * essay in `launch.ts` for why a host that ran programs when a canvas
     * loaded would be a host that runs programs.
     *
     * The module is looked up in the registry — a directory can only come from
     * a registration file somebody wrote, never from the request. What arrives
     * over the wire is one module id, and if it names nothing registered the
     * answer is a refusal.
     */
    start: async (request) => {
      const body = (await request.json().catch(() => null)) as { module?: unknown } | null
      if (!body || typeof body.module !== 'string' || body.module.length > 64) {
        return json({ ok: false, why: 'A start names one module.' }, 400)
      }
      const named = body.module

      /* Read the registrations now rather than trusting the last sweep, because
         the commonest reason to press Start is that somebody has just edited a
         registration — adding the `dir` that makes starting possible at all.
         Answering out of a cached map made that edit invisible until something
         else happened to sweep, which contradicted `launch.ts`'s own claim that
         the answer is about the disk as it is at the moment of the press. It is
         one small directory read; the honesty is worth more than the map. */
      const now = await readRegistrations()
      const registration = now.registrations.find((r) => r.id === named) ?? null
      const can = startable(registration)
      if (!can.ok) return json({ ok: false, why: can.why }, 409)

      /*
       * A module that is already answering must be RESTARTED, not started again.
       *
       * ## Start had quietly become a no-op
       *
       * Modules now claim their own port — see `kehikot-module-protocol/serve`
       * — and a module finding its own copy already there says so and exits 0.
       * That is right for a person typing `./run.sh`, and it turned this button
       * into a lie: the spawn succeeded, the child exited immediately having
       * done nothing, the sweep afterwards found the same broken module, and the
       * page reported exactly what it had before.
       *
       * The press that exposed it was somebody whose container was drawing
       * nothing because its page held addresses from before a dependency
       * rebuild. Start was the only control offered, they pressed it several
       * times, and it could not have worked on any of them. A restart WOULD have
       * fixed it — a Vite server coming back up pushes a reload to the page it
       * is framed in, and the module recovers in a few seconds unattended.
       *
       * ## Which is why this refuses rather than guesses when it cannot
       *
       * Stopping is only ever something this host may do to a program it
       * started, and `keep` is how somebody says not even then — see the essay
       * in `lifecycle.ts` for why stopping is not the mirror image of starting.
       * A module somebody is running in their own terminal is theirs, and the
       * honest answer names where it is rather than pretending the button did
       * something.
       *
       * The one widening: a module the nursery does not hold may still be
       * restarted when the program on its port is proven to be running from
       * the registered directory — the case of modules a previous host started
       * and this one inherited. The proof and its limits are in `takeover.ts`.
       */
      /* A person's press: what they stopped is theirs to start again. */
      stoppedByPerson.pressed(named)
      const done = await startOnce(named, registration, can.run, ANSWERS_WITHIN_PRESS_MS)
      if (!done.ok) return json({ ok: false, why: done.why, detail: done.detail ?? [], ...(done.kept ? { kept: true } : {}) }, 409)
      return json({
        ok: true,
        command: done.ok && done.moved ? done.moved.runnable.command : can.run.command,
        /* Said when the module was started on another port: the sentence, for the container to show. */
        ...(done.ok && done.moved ? { moved: done.moved.line } : {}),
        /* The last it printed, when it has not answered — so the page can say
           more than "run it yourself and see". */
        ...(done.answered ? {} : { detail: done.detail }),
        presence: done.presence,
      })
    },
  })
}
