#!/usr/bin/env bun
import { LIMITS, PROTOCOL, WELL_KNOWN } from 'roadmap-module-protocol'
import { answer } from './answers.ts'
import { ensureKnown, forgetUnregistered, known, remember } from './known.ts'
import {
  createCanvas,
  databaseFile,
  deleteCanvas,
  editCanvas,
  ensureCanvases,
  keepState,
  listCanvases,
  open,
  readState,
  type CanvasEdit,
} from './canvases.ts'
import { addProject, adopt, forgetProject, listProjects, projectById, shareKehikot } from './projects.ts'
import { browse, rootsFor } from './folders.ts'
import { epicsIn, listEpics } from './holdings.ts'
import { agentKnows, awarenessOf, scopeOf, type AgentAwareness } from './agents.ts'
import { look, type Presence } from './discover.ts'
import { answered, gone, Nursery, start, startable } from './launch.ts'
import {
  asleepLine,
  Idleness,
  startingLine,
  STARTING_FOR_MS,
  toStart,
  toStop,
  type Lifecycle,
  type Standing,
} from './lifecycle.ts'
import { readRegistrations, registryDir, type RegistrationSweep } from './registrations.ts'
import { addArgs, connect, disconnect, doorFor, repoint, SCOPE } from './register.ts'
import { toolsAt } from './tools.ts'
import { mcp } from './mcp.ts'
import { whyQuiet } from './quiet.ts'
import { nextConnection, Openness } from './open.ts'
import { Wakes } from './wake.ts'

/**
 * The whole of the host's server. Four jobs and no fifth.
 *
 *   1. Say which modules are registered and what the host concluded about each.
 *   2. Answer the questions a framed module asks.
 *   3. Keep the canvases: their names, and what is arranged on each.
 *   4. Tell a browser pointed at this port where the page actually is.
 *
 * The database is the one piece of state and it is deliberately small — see the
 * essay at the top of `canvases.ts` for what is in it and, more usefully, for
 * what is not. Nothing about a module is stored: every fact about a program
 * comes from asking the program, on every sweep.
 */

const PORT = Number(process.env.PORT ?? 4180)

/** What this host calls itself at its own MCP door. See `server/mcp.ts`. */
const HOST_ID = 'kehikko'
const HOST_VERSION = '0.1.0'

/**
 * The canvases, opened once for the life of the process.
 *
 * Opened eagerly rather than on the first request that needs it, so that a
 * database this host cannot open is a startup failure with a stack trace and
 * not a page that loads, looks fine, and cannot save anything.
 */
const db = open()

/**
 * The projects, settled before a single request is served.
 *
 * Once, at startup, and never again on demand: `adopt` seeds the first project
 * from `KEHIKKO_ROADMAP_DIR` and files every kehikko written before projects
 * existed into it. Doing that lazily, on the first request that noticed, would
 * mean two requests arriving together both deciding to migrate, and the whole
 * point of a migration is that it happens once and is then simply true.
 */
const settled = adopt(db)
ensureKnown(db)

/**
 * Which kehikko each open page has, so the MCP door can answer a call that
 * named none. In memory, and it dies with this process — see `open.ts` for why
 * that is right rather than a shortcut.
 */
const openness = new Openness()

/**
 * The pages listening for a kehikko that changed under them.
 *
 * An agent's tool call changes what somebody is looking at, and the existing
 * sweep-on-focus in `App.tsx` cannot catch it: the tab stays focused the whole
 * time, so no event fires. See `wake.ts`.
 */
const wakes = new Wakes()

/** The open project's folder, when the call named a project this host has. */
function rootOf(project: unknown): string | null {
  if (typeof project !== 'number' || !Number.isInteger(project)) return null
  return projectById(db, project)?.path ?? null
}

/**
 * Who may currently call. A `Map`, and the reason is the protocol package's.
 *
 * A module id is a string that arrived from somebody else's program, and
 * `constructor`, `toString` and `prototype` all match `MODULE_ID` — they are
 * ordinary lowercase letters and no rule about the shape of a name can exclude
 * them. On a plain object, `callers['constructor']` answers with a function:
 * truthy, so an unregistered module would pass the check and the lie would
 * surface somewhere else entirely. A Map has no prototype to fall through.
 */
const callers = new Map<string, string>()

/**
 * The last sweep's registrations, kept so a Start can find a module's directory.
 *
 * Rebuilt on every sweep rather than accumulated, for the same reason `callers`
 * is: a registration somebody deleted must stop being startable, and a map that
 * only ever grew would keep offering to run a program whose registration is
 * gone.
 */
const registered = new Map<string, import('./registrations.ts').Registration>()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/**
 * Sweep the registry and ask every registered program what it is.
 *
 * In parallel, because the slow case is a module that is not running and the
 * host waits `MANIFEST_TIMEOUT_MS` for each of those. Serially, five stopped
 * modules would be twelve seconds of a person watching an empty canvas, and the
 * one thing this host must not do is make "not running" look like "broken".
 */
async function survey(): Promise<{
  presences: (Presence & { state: string | null; agent: AgentAwareness })[]
  sweep: RegistrationSweep
  protocol: number
}> {
  const found = await readRegistrations(registryDir())
  const presences = await Promise.all(found.registrations.map((registration) => look(registration)))
  const knows = agentKnows()

  callers.clear()
  registered.clear()
  for (const registration of found.registrations) {
    callers.set(registration.id, registration.url)
    registered.set(registration.id, registration)
  }

  /*
   * A name for the ones that could not give one.
   *
   * A module's name comes from the manifest it serves, so a module that is
   * asleep has none, and the page falls back to the id — a canvas labelled
   * `roadmap.checklist` and `roadmap.paper`. That was invisible until modules
   * started sleeping; now it is most of them.
   *
   * Only the NAME is remembered, and only for a presence that has none. What a
   * module currently offers — its summary, its tools, its protocol range — is a
   * claim about a running program, and the host does not make those on behalf
   * of something that is not answering. See `known.ts`.
   */
  const remembered = known(db)
  for (const presence of presences) {
    if (presence.name) remember(db, presence.id, presence.name)
    else {
      const was = remembered.get(presence.id)
      if (was) presence.name = was
    }
  }
  forgetUnregistered(db, found.registrations.map((r) => r.id))

  return {
    /*
     * Each module's kept state travels with its presence, because the page is
     * what greets a module and the greeting is where state has to be — a module
     * that had to ask for it afterwards would draw its defaults first and
     * correct them, which is the visible-flicker failure wearing a different
     * hat. This is the one thing the page carries that it does not read.
     */
    /* Whether the AGENT has been told about each module's MCP door, read from
       the agent's own configuration once per sweep. A module can be running
       perfectly and offering tools that no agent has been told exist; nothing
       errors, the tools are simply absent from the conversation. See
       `agents.ts`. */
    presences: presences.map((presence) => ({
      ...presence,
      state: readState(db, presence.id),
      agent: awarenessOf(presence.module?.mcp?.url ?? null, presence.id, knows),
    })),
    sweep: found,
    protocol: PROTOCOL,
  }
}

type Swept = Awaited<ReturnType<typeof survey>>

/**
 * The sweep, with two of them never running at once.
 *
 * A sweep is one HTTP request to every registered program. Two overlapping ones
 * are twice that for one answer, and there are now three things that can ask
 * for a sweep at nearly the same moment: the page on load, the page on focus,
 * and a person switching kehikko — which reports what is open and then wants to
 * know what is running there. Whoever asks second gets the answer the first is
 * already waiting for.
 *
 * Safe to share because a sweep is a question about the disk and the ports and
 * about nothing the caller brought with it. What each caller does with the
 * answer differs; the answer does not.
 */
let sweeping: Promise<Swept> | null = null
function sweep(): Promise<Swept> {
  if (sweeping) return sweeping
  const running = survey().finally(() => {
    sweeping = null
    seen = running
  })
  sweeping = running
  return running
}

/**
 * The last sweep, kept so that stopping does not need a new one.
 *
 * The reaper runs on a timer and the whole point of it is to run when NOBODY is
 * looking — so it must not sweep, because a sweep is thirteen requests, and a
 * host making thirteen requests a minute forever to save memory would be
 * spending the saving on the saving. What it needs from a sweep is one bit per
 * module: is anything there. That bit going stale costs at most one tick of
 * delay in either direction, and `Nursery` refuses anything whose process has
 * since died, so a stale belief cannot become a wrong signal.
 */
let seen: Promise<Swept> | null = null

/**
 * The programs the host started, and when.
 *
 * The only thing in this process that can name a process. See the essay on
 * `Nursery` in `launch.ts` for why stopping is a lookup in a map this file
 * writes exactly once, and not a rule about ports.
 */
const nursery = new Nursery()

/** When each module was last on a kehikko somebody had open. */
const idleness = new Idleness()

/** When the host last ran a module's script, for as long as that is news. */
const starting = new Map<string, number>()

/** When the host stopped a module, until something starts it again. */
const sleeping = new Map<string, number>()

/**
 * Which modules are on a kehikko that a live page says it has open.
 *
 * The whole activation rule, and it is one sentence: a module is needed when
 * somebody is looking at a canvas that has it. Two windows on two kehikot need
 * the union — `open.ts` refuses to collapse those into one answer for an agent
 * and hands them over uncollapsed here, because two screens is not an ambiguity
 * when the question is "is anybody looking at this".
 *
 * Local: a sqlite read and a map in memory, no network at all. That is what
 * lets the reaper run on a timer without the timer costing anything.
 */
function neededNow(now = Date.now()): Set<string> {
  const openIds = new Set(openness.every(now))
  const needed = new Set<string>()
  for (const canvas of listCanvases(db)) {
    if (!openIds.has(canvas.id)) continue
    for (const placement of canvas.placements) needed.add(placement.i)
  }
  return needed
}

/** Whether a start the host asked for is still recent enough to be called one. */
function isStarting(id: string, now: number): boolean {
  const at = starting.get(id)
  if (at === undefined) return false
  if (now - at < STARTING_FOR_MS) return true
  starting.delete(id)
  return false
}

/**
 * Every fact the policy is allowed to consider, gathered in one place.
 *
 * Gathering and deciding are deliberately separate functions in separate files.
 * Everything here reads a map, a database or a directory; everything in
 * `lifecycle.ts` is arithmetic over what this returns. That is what lets the
 * policy — which module may be stopped, when, and what is exempt — be tested
 * exhaustively without a process ever being created.
 */
function standings(presences: readonly Presence[], now: number): Standing[] {
  const needed = neededNow(now)
  idleness.noted(needed, now)

  /* A module whose registration is gone stops being remembered anywhere here.
     Not housekeeping for its own sake: an entry left in `sleeping` would keep
     the host saying "asleep" about a program nobody has registered any more,
     and one left in the nursery would have it holding a pid for a name it can
     no longer look up a directory for. The registry is the list of what exists
     — see `readRegistrations` — so it is also the list of what these may hold. */
  const here = new Set(presences.map((presence) => presence.id))
  idleness.forgetAllBut(here)
  for (const id of [...starting.keys()]) if (!here.has(id)) starting.delete(id)
  for (const id of [...sleeping.keys()]) if (!here.has(id)) sleeping.delete(id)
  for (const id of nursery.ids) if (!here.has(id)) nursery.forget(id)

  return presences.map((presence) => {
    const registration = registered.get(presence.id) ?? null
    /* `startedAt` is null for every module this host did not start, and asking
       the nursery is also what drops a pid whose process has died — so a module
       somebody restarted by hand stops being ours at the moment we look. */
    const startedAt = nursery.startedAt(presence.id)
    return {
      id: presence.id,
      needed: needed.has(presence.id),
      answering: presence.reached,
      startable: startable(registration).ok,
      ours: startedAt !== null,
      keep: registration?.keep === true,
      idleSince: idleness.since(presence.id, startedAt),
      starting: isStarting(presence.id, now),
    }
  })
}

/**
 * Run one module's script because a kehikko somebody has open needs it.
 *
 * The one place in this program that starts something nobody pressed a button
 * for, and it is worth saying exactly why that is not the autostart `launch.ts`
 * refuses. That essay's objection is to a host that runs programs on a guess —
 * everything registered, at boot, because it might be wanted. This runs one
 * named program because a person is at this moment looking at a container for
 * it, on a canvas they arranged, from a registration they wrote naming a
 * directory they chose. The press has not disappeared; it has moved from a
 * button on the container to the act of opening the kehikko the container is on.
 *
 * Nothing is started that is not on an open kehikko. There is no warming, no
 * prediction and no retry loop: a start that does not take is a container that
 * says so, with the button on it, which is where this began.
 */
function begin(id: string): void {
  const can = startable(registered.get(id) ?? null)
  if (!can.ok) return
  const ran = start(can.run)
  if (!ran.ok || !ran.child) return
  const at = Date.now()
  nursery.keep(id, { child: ran.child, at, url: can.run.url })
  starting.set(id, at)
  sleeping.delete(id)
  console.log(`kehikko: started ${id} at ${can.run.url} — an open kehikko has it (pid ${ran.child.pid})`)
}

/**
 * Decide and act, from a sweep already in hand.
 *
 * Never sweeps: the caller has just done that, or is deliberately working from
 * the last one. Never awaits either — a start is a spawn and the moment after
 * it the module is `starting`, which is a thing the container can say straight
 * away. Waiting here would make every canvas switch pause for a dev server.
 */
function govern(presences: readonly Presence[], mayStart = true): void {
  const now = Date.now()
  const standing = standings(presences, now)

  if (mayStart) for (const id of toStart(standing)) begin(id)

  for (const id of toStop(standing, now)) {
    const was = nursery.stop(id)
    if (was !== 'stopped') continue
    sleeping.set(id, now)
    starting.delete(id)
    console.log(`kehikko: stopped ${id} — no open kehikko has had it for the grace period`)
  }
}

/**
 * What the host has done to a module lately, for the container to say.
 *
 * Only ever attached to a module that is not answering, because that is the
 * only time it changes what a person should read: a module that is up needs no
 * explanation, and one that is down needs the right one. A module that has come
 * back — however it came back — stops being described as asleep here, which is
 * how a module the other agent restarted by hand loses the word.
 */
function lifecycleOf(presence: Presence, now: number): Lifecycle | undefined {
  if (presence.condition !== 'silent') {
    starting.delete(presence.id)
    sleeping.delete(presence.id)
    return undefined
  }
  if (isStarting(presence.id, now)) return 'starting'
  return sleeping.has(presence.id) ? 'asleep' : undefined
}

/** A sweep as the page receives it, with the host's own lifecycle words on it. */
function told(view: Swept): Swept {
  const now = Date.now()
  return {
    ...view,
    presences: view.presences.map((presence) => {
      const lifecycle = lifecycleOf(presence, now)
      if (!lifecycle) return presence
      /* The line is replaced, not appended to. `discover.ts` wrote a good
         sentence about a program that is not running and does not know why;
         this host DOES know why, and showing both would be the container saying
         two things about one fact. See `lifecycle.ts` for the two sentences. */
      return {
        ...presence,
        lifecycle,
        line:
          lifecycle === 'starting'
            ? startingLine(presence.id, presence.at)
            : asleepLine(presence.id, presence.at),
      }
    }),
  }
}

/**
 * The reaper: stop what nothing has needed for long enough.
 *
 * On a timer and not on a request, because the moment worth reclaiming memory
 * is the moment nobody is looking — a canvas closed for the night makes no
 * requests at all, and a policy that only ran when the page asked would save
 * exactly nothing overnight, which is most of the day.
 *
 * It costs a sqlite read and some arithmetic. No sweep, no manifest, no
 * network — see `seen` above. Every thirty seconds, so the effective grace is
 * five minutes and a bit, and the "and a bit" does not matter to anything.
 */
const REAP_EVERY_MS = 30_000
setInterval(() => {
  void (async () => {
    try {
      /* No sweep has happened yet, so the host knows nothing about what is
         running — and a host that knows nothing must not decide anything. It
         also cannot have started anything, so there is nothing to stop. */
      if (!seen) return
      govern((await seen).presences, false)
    } catch {
      /* A failed sweep is not a reason to kill anything. */
    }
  })()
}, REAP_EVERY_MS).unref()

/**
 * Where the page is, which is not here.
 *
 * This server answers `/host/*` and nothing else. Vite serves the page, on its
 * own port, proxying `/host` back here — see `run.sh` for why, and for the
 * afternoon that taught us. Anything else arriving at this port is somebody
 * pointing a browser at the API rather than at the canvas, so it is told where
 * the canvas is rather than given a blank page or a 404 that reads like the
 * host is broken.
 */
function elsewhere(): Response {
  return new Response(
    `This is the host's API and not its page. The canvas is on port ${PORT + 1}.\n` +
      'Both are started by ./run.sh — this one answers /host/modules and /host/call.\n',
    { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  )
}

/**
 * The canvas a path names, or `null` if it does not name one.
 *
 * Deliberately strict about digits. `Number('1e3')` is 1000 and `Number(' 2 ')`
 * is 2, so a path that is not a plain integer would still address a canvas —
 * which is fine here and is exactly the habit that is not fine somewhere else.
 */
function canvasId(pathname: string): number | null {
  const match = /^\/host\/canvases\/(\d{1,15})$/.exec(pathname)
  return match ? Number(match[1]) : null
}

/** The module id out of a request, bounded before it is looked at. */
function moduleIn(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  /* Long enough for a module that is slow to answer its manifest, short enough
     that a module that accepted a connection and went quiet does not hold one
     of the host's own sockets forever. */
  idleTimeout: 30,

  async fetch(request) {
    const url = new URL(request.url)

    /* What is registered, and what the host made of each of them. The page asks
       for this on load and whenever the person asks it to look again; there is
       no polling, because a host that re-swept every second would be a host
       hammering somebody's own machine to tell them nothing changed. */
    if (url.pathname === '/host/modules' && request.method === 'GET') {
      const view = await sweep()
      /* And then act on it. A sweep is the only moment the host knows both what
         is running and what is wanted, so it is where a module on the open
         kehikko that nothing answers for gets started. Synchronous — it spawns
         and returns — so the answer below already says `starting` about
         whatever was just run, and the container says so instead of sitting on
         a sentence about a program that is not running. */
      govern(view.presences)
      return json(told(view))
    }

    /* One question from one framed module.
     *
     * It arrives over HTTP rather than being answered in the page, and that is
     * the boundary worth being clear about: the page RELAYS, and every check is
     * on this side. The page cannot be the one deciding, because the page is a
     * document that a module's own frame is inside; the server is a process
     * that no module can reach except through this endpoint.
     *
     * There is no credential on this request and there is nothing to steal: the
     * host holds no token, the module holds no token, and the session id in the
     * greeting is explicitly not one. Every answer below is decided out of the
     * registry, which no module can write to. */
    if (url.pathname === '/host/call' && request.method === 'POST') {
      const length = Number(request.headers.get('content-length') ?? 0)
      if (length > LIMITS.MANIFEST_BYTES) {
        return json({ ok: false, reason: 'failed', error: 'That call is too large to read.' }, 413)
      }

      const body = (await request.json().catch(() => null)) as {
        module?: unknown
        method?: unknown
        params?: unknown
        /* Which project the frame that asked is standing in. Supplied by the
           page, which is the only thing that knows — a module's page is loaded
           once and shown on whichever kehikko asks for it, so the frame itself
           genuinely cannot say. It is an id and not a path: a path arriving
           here from a page would be a way to name any folder on the disk, and
           this is the endpoint every framed module can reach. */
        project?: unknown
      } | null

      if (!body || typeof body.module !== 'string' || typeof body.method !== 'string') {
        return json({ ok: false, reason: 'failed', error: 'A call names a module and a method.' }, 400)
      }
      /* Bounded before it is looked at, matching the protocol's own bound on a
         method name. A string this long has already stopped being a method
         name; letting it through would put it in a Map key and, eventually, in
         a log line somebody reads. */
      if (body.method.length > LIMITS.METHOD || body.module.length > 64) {
        return json({ ok: false, reason: 'failed', error: 'A call names a module and a method.' }, 400)
      }

      /* If nothing has swept yet — a module framed by a page that was already
         open when this server restarted — sweep once so the answer is about the
         registry rather than about the host having just started. */
      if (!callers.size) await sweep()

      return json(
        answer(
          body.module,
          body.method,
          body.params,
          (id) => callers.has(id),
          (module, state) => keepState(db, module, state),
          rootOf(body.project),
        ),
      )
    }

    /* The canvases.
     *
     * Read on load and written on every rearrangement, which is a lot of small
     * writes — the page debounces them, and this end is cheap enough that it
     * would not matter if it did not.
     *
     * There is no authentication here and there is nothing to authenticate. The
     * server listens on loopback only, holds nothing but names and rectangles,
     * and belongs to the same person as everything it talks to. */
    if (url.pathname === '/host/canvases' && request.method === 'GET') {
      /* Every kehikko, from every project, and the page shows one project's
         worth. See `listCanvases`: the union is what keeps a module's page
         alive across a project switch, which is the whole reason switching
         re-points modules instead of reloading them. */
      const projects = listProjects(db)
      return json({ projects, canvases: ensureCanvases(db, projects[0]?.id ?? null) })
    }

    if (url.pathname === '/host/canvases' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { name?: unknown; project?: unknown } | null
      const name = typeof body?.name === 'string' ? body.name : undefined
      /* Which project it goes in. A new kehikko belongs where the person was
         standing when they pressed new; a kehikko in no project is one no
         dropdown lists. */
      const project =
        typeof body?.project === 'number' && Number.isInteger(body.project) ? body.project : null
      if (project !== null && !projectById(db, project)) {
        return json({ error: 'There is no project with that id.' }, 404)
      }
      return json({ canvas: createCanvas(db, name, project) }, 201)
    }

    /* The projects: what is open, and one more.
     *
     * A project is a name and a folder. Adding one is the only write on this
     * host that turns a string from a page into a path files are later read
     * under, and every check on that string is in `addProject` rather than
     * here — one place, so a second endpoint cannot grow a weaker copy. */
    if (url.pathname === '/host/projects' && request.method === 'GET') {
      return json({ projects: listProjects(db) })
    }

    /*
     * Whether one project's `.kehikot/` goes into its history.
     *
     * A PATCH on the collection with the id in the body rather than a route per
     * project, because every other route on this host is a flat path and one
     * that parsed an id out of a pathname would be the only place an id arrives
     * by a different road. The check that it IS an id is in `shareKehikot`,
     * with the rest of what that decision refuses.
     *
     * The whole project comes back rather than an acknowledgement, and it is
     * re-read from disk on the way out. What the page draws is then what the
     * file says, which matters here more than usual: this is a write to a file
     * a person can also edit themselves, and a page that drew the value it had
     * just sent would agree with itself and possibly with nothing else.
     */
    /*
     * Stop holding a folder as a project.
     *
     * DELETE with the id in the body, for the reason the PATCH above gives: one
     * flat path, and ids arrive by one road. It deletes nothing on disk — see
     * `forgetProject`, and the paragraph there about why erasing `.kehikot/`
     * is deliberately not what this word does now that papers live in it.
     */
    if (url.pathname === '/host/projects' && request.method === 'DELETE') {
      const body = (await request.json().catch(() => null)) as { id?: unknown } | null
      if (!body || typeof body.id !== 'number') return json({ error: 'Which project.' }, 400)
      const said = forgetProject(db, body.id)
      if (!said.ok) return json({ error: said.why }, said.status)
      return json({ project: said.project, canvases: said.canvases })
    }

    if (url.pathname === '/host/projects' && request.method === 'PATCH') {
      const body = (await request.json().catch(() => null)) as { id?: unknown; shared?: unknown } | null
      if (!body || typeof body.id !== 'number' || typeof body.shared !== 'boolean') {
        return json({ error: 'Which project, and shared or not.' }, 400)
      }
      const said = shareKehikot(db, body.id, body.shared)
      if (!said.ok) return json({ error: said.why }, said.status)
      return json({ project: said.project })
    }

    if (url.pathname === '/host/projects' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { path?: unknown; name?: unknown } | null
      if (!body || typeof body.path !== 'string') {
        return json({ error: 'A project is added by naming one folder.' }, 400)
      }
      const added = addProject(db, body.path, typeof body.name === 'string' ? body.name : undefined)
      if (!added.ok) return json({ error: added.why }, added.status)
      return json({ project: added.project, already: added.already }, added.already ? 200 : 201)
    }

    /*
     * The folders under one folder, so a person can pick a project.
     *
     * A browser cannot hand a page a real path — `showDirectoryPicker` returns
     * an opaque handle — and a path is exactly what a module needs. So the
     * server lists and the page draws. Every refusal is in `folders.ts`, with
     * the four rules and what each one is for; this end only supplies the roots,
     * which are home plus the folders already opened as projects.
     */
    if (url.pathname === '/host/folders' && request.method === 'GET') {
      const roots = rootsFor(listProjects(db).map((project) => project.path))
      const browsed = browse(url.searchParams.get('path'), roots)
      if (!browsed.ok) return json({ error: browsed.why }, browsed.status)
      return json({ listing: browsed.listing, roots })
    }

    /*
     * One project's epics, for the host's own header.
     *
     * The same reading `epics.list` gives a framed module, asked for by the
     * page rather than through `/host/call` — because the page is the host and
     * is not a module: it has no registration, so `answer` would refuse it with
     * `unknown-module`, and inventing a registration for the host inside its
     * own host would be worse than a second route.
     *
     * `holds` is the field that matters and it is why this is not just a list.
     * A project with no `data/epics` and a project whose `data/epics` is empty
     * both answer with no epics, and only one of those should make the header
     * say "this project has none". See `Epics.tsx`.
     */
    if (url.pathname === '/host/epics' && request.method === 'GET') {
      const asked = Number(url.searchParams.get('project') ?? '')
      const project = Number.isInteger(asked) ? projectById(db, asked) : null
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      const dir = epicsIn(project.path)
      return json({ holds: dir !== null, epics: dir ? listEpics(dir) : [] })
    }

    const canvas = canvasId(url.pathname)
    if (canvas !== null) {
      if (request.method === 'PATCH') {
        const body = (await request.json().catch(() => null)) as CanvasEdit | null
        if (!body || typeof body !== 'object') {
          return json({ error: 'A change to a canvas is an object.' }, 400)
        }
        /* Only the fields named here, picked out one at a time. Handing the
           parsed body straight to the store would make every future column
           writable by anything that can POST — which is how an id becomes
           editable. */
        const edited = editCanvas(db, canvas, {
          ...(body.name !== undefined ? { name: String(body.name) } : {}),
          ...(body.epic !== undefined ? { epic: body.epic === null ? null : String(body.epic) } : {}),
          /* A project id, or nothing. It used to be `String(body.project)` —
             a name typed onto a canvas — and that is the field this whole
             change replaces; see the essay on `project` in `canvases.ts`. */
          ...(body.project !== undefined
            ? { project: typeof body.project === 'number' ? body.project : null }
            : {}),
          ...(Array.isArray(body.selection) ? { selection: body.selection as string[] } : {}),
          ...(Array.isArray(body.placements) ? { placements: body.placements } : {}),
        })
        if (!edited) return json({ error: 'There is no canvas with that id.' }, 404)
        return json({ canvas: edited })
      }

      if (request.method === 'DELETE') {
        const outcome = deleteCanvas(db, canvas)
        if (outcome === 'no-such-canvas') return json({ error: 'There is no canvas with that id.' }, 404)
        /* Refused, and said as a sentence rather than a status code, because
           the page shows this to a person who just pressed delete and is owed
           the reason. */
        if (outcome === 'the-last-one') {
          return json(
            { error: 'This is the only canvas. Make another one before removing this one.' },
            409,
          )
        }
        return json({ deleted: canvas })
      }
    }

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
    if (url.pathname === '/host/start' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { module?: unknown } | null
      if (!body || typeof body.module !== 'string' || body.module.length > 64) {
        return json({ ok: false, why: 'A start names one module.' }, 400)
      }

      /* Read the registrations now rather than trusting the last sweep, because
         the commonest reason to press Start is that somebody has just edited a
         registration — adding the `dir` that makes starting possible at all.
         Answering out of a cached map made that edit invisible until something
         else happened to sweep, which contradicted `launch.ts`'s own claim that
         the answer is about the disk as it is at the moment of the press. It is
         one small directory read; the honesty is worth more than the map. */
      const now = await readRegistrations(registryDir())
      const registration = now.registrations.find((r) => r.id === body.module) ?? null
      const can = startable(registration)
      if (!can.ok) return json({ ok: false, why: can.why }, 409)

      /*
       * A module that is already answering must be RESTARTED, not started again.
       *
       * ## Start had quietly become a no-op
       *
       * Modules now claim their own port — see `roadmap-module-protocol/serve`
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
       */
      const standing = registration ? await look(registration) : null
      if (standing?.reached) {
        if (registration?.keep === true) {
          return json({
            ok: false,
            why:
              `${body.module} is already running at ${can.run.url}, and its registration says to keep it. `
              + 'This host will not stop it — that flag exists so nothing reaps a program holding live work. '
              + 'Stop it where you started it if you want it restarted.',
          }, 409)
        }
        const stopped = nursery.stop(body.module)
        if (stopped === 'not-ours') {
          return json({
            ok: false,
            why:
              `${body.module} is already running at ${can.run.url} and this host did not start it, so it cannot `
              + 'restart it. Stop it where you started it and press this again — or reload this page, which is '
              + 'enough when the module is fine and this container is holding a stale copy of its page.',
          }, 409)
        }
        /* Its own port has to come free before the replacement asks for it, or
           the new process finds the old one still listening, decides a copy of
           itself is already running, and exits — which is the very thing this
           branch exists to get past. */
        await gone(can.run.url, WELL_KNOWN)
      }

      const ran = start(can.run)
      /* A press is a start like any other, so its child goes into the nursery
         beside the ones the policy asked for. Held to the same rule afterwards:
         the host started it, so the host may stop it when nothing has needed it
         for the grace period. The alternative — a pressed module living forever
         — would make the button a way to opt out of the whole policy by
         accident, and nobody pressing it is asking for that. */
      if (ran.ok && ran.child) {
        nursery.keep(body.module, { child: ran.child, at: Date.now(), url: can.run.url })
        starting.set(body.module, Date.now())
        sleeping.delete(body.module)
      }
      /* Started is not running, so the module is given a moment to come up and
         is then asked. Sweeping immediately reported every successful start as
         a failure: the spawn worked, the module answered a second later, and
         the sweep had already run before the dev server bound its port. */
      if (ran.ok) await answered(can.run.url, WELL_KNOWN)
      const after = ran.ok ? told(await sweep()) : null
      /* The child stays on this side. It is what makes the module stoppable —
         see `Nursery` — and the page has no use for it; a handle the answer
         carried only because the spawn produced it is not something to serialise
         into JSON and hand to a browser. */
      const { child: _held, ...outcome } = ran
      return json({
        ...outcome,
        presence: after?.presences.find((p) => p.id === body.module) ?? null,
      })
    }

    /*
     * What one module's door offers, and what the agent has been told about it.
     *
     * Asked when a modal opens and at no other time. See the essay in
     * `tools.ts`: a sweep that handshakes with eleven MCP servers is a host that
     * hangs whenever somebody asks it to look again, and the person pressing
     * "look again" would have no way to know that is what they were waiting for.
     *
     * Everything acted on here is derived from the id — see `doorFor`.
     */
    if (url.pathname === '/host/tools' && request.method === 'GET') {
      const id = moduleIn(url.searchParams.get('module'))
      if (!id) return json({ ok: false, why: 'A request for tools names one module.' }, 400)

      const found = await doorFor(id)
      if (!found.ok) return json({ ok: false, why: found.why }, found.status)
      const door = found.door

      const agent = awarenessOf(door.url, id, agentKnows())
      /* Which scope the EXISTING entry is in, when there is one. The name to ask
         about is the one that was found, not the one this host would write —
         a server pointing here may be called anything at all. */
      const existing = agent.kind === 'told' || agent.kind === 'elsewhere' ? agent.as : null

      return json({
        ok: true,
        module: id,
        as: door.as,
        url: door.url,
        transport: door.transport,
        agent,
        /* Named before anything is written, which is the whole reason it is in
           the answer rather than only in the code. */
        writesTo: SCOPE,
        configuredIn: existing ? scopeOf(existing) : null,
        command: `claude ${addArgs(door).join(' ')}`,
        tools: await toolsAt(door.url),
      })
    }

    /*
     * Tell the agent about a module's door, or stop telling it.
     *
     * The press `agents.ts` said would be a separate decision. It is a POST
     * because it changes something, and it changes something on the person's
     * own machine outside this host — so it happens on an explicit press, and
     * the answer says exactly what was run.
     *
     * The host does not edit `~/.claude.json`. It runs `claude mcp add` and
     * `claude mcp remove`, for the reasons set out in `register.ts`: the CLI
     * owns that file's format, it knows what a scope is, and that file holds
     * far more of a person's state than MCP servers.
     */
    if (url.pathname === '/host/agent' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        module?: unknown
        press?: unknown
      } | null

      const id = moduleIn(body?.module)
      const press = body?.press
      if (!id || (press !== 'connect' && press !== 'disconnect' && press !== 'repoint')) {
        return json({ ok: false, why: 'A press names one module and one of connect, disconnect or repoint.' }, 400)
      }

      const found = await doorFor(id)
      if (!found.ok) return json({ ok: false, why: found.why }, found.status)
      const door = found.door

      /* Read the configuration again at the moment of the press rather than
         trusting what the modal was shown. The window may have been open for a
         while, and `claude mcp add` in another terminal is exactly the sort of
         thing that happens in between. The NAME being removed comes from this
         read — never from the request. */
      const before = awarenessOf(door.url, id, agentKnows())

      let ran
      if (press === 'connect') {
        if (before.kind === 'told') {
          return json({ ok: false, why: `The agent has already been told about this door, as "${before.as}".` }, 409)
        }
        if (before.kind === 'elsewhere') {
          return json(
            {
              ok: false,
              why: `A server called "${before.as}" already exists and points at ${before.pointsAt}. Repointing it is a different press, because it rewrites an entry this host did not create.`,
            },
            409,
          )
        }
        ran = await connect(door)
      } else if (press === 'repoint') {
        if (before.kind !== 'elsewhere') {
          return json(
            { ok: false, why: 'There is no entry of that name pointing somewhere else, so there is nothing to repoint.' },
            409,
          )
        }
        ran = await repoint(before.as, door)
      } else {
        if (before.kind !== 'told' && before.kind !== 'elsewhere') {
          return json({ ok: false, why: 'The agent has not been told about this door, so there is nothing to remove.' }, 409)
        }
        ran = await disconnect(before.as)
      }

      /* Read back rather than assume. The CLI is the thing that decides whether
         it worked, and reporting the awareness this host can now READ is the
         only claim it is in a position to make. */
      return json({ ...ran, agent: awarenessOf(door.url, id, agentKnows()) })
    }

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
    if (url.pathname === '/host/hello' && request.method === 'GET') {
      return json({ ok: true, kehikko: true, version: HOST_VERSION, api: PORT, page: PORT + 1 })
    }

    if (url.pathname === '/host/quiet' && request.method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      const registration = registered.get(id)
      if (!registration) {
        return json({ ok: false, error: 'No module is registered under that id.' }, 404)
      }
      const presence = await look(registration)
      if (presence.condition !== 'ready' || !presence.module) {
        /* It is not answering at all any more, which `discover.ts` already has
           a careful sentence for. Hand that back rather than inventing a second
           reading of the same fact. */
        return json({ ok: true, kind: 'gone', line: presence.line })
      }
      const said = await whyQuiet(presence.module.name, presence.module.entry)
      return json({ ok: true, kind: said.kind, line: said.line })
    }

    if (url.pathname === '/host/open' && request.method === 'POST') {
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
      /* A kehikko was just opened, so the set of modules anybody is looking at
         has just changed — which is the whole trigger this design runs on. The
         page sweeps too, and the two coalesce into one (see `sweep`); this one
         exists so the decision does not depend on which of the two requests the
         browser happened to send first. Not awaited: the page asked to report
         what it has open and is owed nothing but an acknowledgement. */
      void sweep()
        .then((view) => govern(view.presences))
        .catch(() => {
          /* A sweep that failed is a decision not made, which is the safe one. */
        })
      return json({ ok: true })
    }

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
    if (url.pathname === '/host/watch' && request.method === 'GET') {
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
          controller.enqueue(encoder.encode(': listening\n\n'))
          if (page && kehikko !== null) openness.streamed(connection, page, kehikko)
          stop = wakes.listen((woken) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kehikko: woken })}\n\n`))
          })
        },
        cancel() {
          stop?.()
          /* This stream's own evidence, withdrawn rather than left to go stale
             — which is the whole reason the page identifies itself here. What
             any other connection or the page itself has said is untouched. */
          openness.closed(connection)
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        },
      })
    }

    if (url.pathname.startsWith('/host/')) {
      return json({ ok: false, reason: 'unknown-method', error: 'No such endpoint.' }, 404)
    }

    /*
     * The host's own door, for an agent.
     *
     * Not under `/host/` — that prefix is the page's own vocabulary, proxied by
     * Vite so the page talks to one origin. This is spoken to directly, on this
     * port, by something that is not a browser. `/mcp` is where every module in
     * this workspace puts its door and an agent's configuration is one line
     * shorter for the host's being in the same place.
     */
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'the MCP door takes POST' }, 405)
      }
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body.method !== 'string') {
        return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } }, 400)
      }
      const answered = await mcp(
        body,
        {
          db,
          which: () => openness.open(),
          wake: (kehikko) => wakes.woke(kehikko),
          /* A sweep, so that an agent reading a canvas is told which of the
             containers on it hold a program that is actually answering. It is
             the same sweep the page asks for on load — N requests to N
             localhost programs — and unlike `/host/tools` it handshakes with
             nobody's MCP server, so the objection in `tools.ts` does not
             apply. */
          seen: async () =>
            (await sweep()).presences.map((presence) => ({
              id: presence.id,
              name: presence.name ?? null,
              condition: presence.condition,
            })),
        },
        { name: HOST_ID, version: HOST_VERSION },
      )
      return answered.body === null
        ? new Response(null, { status: answered.status })
        : json(answered.body, answered.status)
    }

    return elsewhere()
  },
})

console.log(`the canvas is at http://127.0.0.1:${server.port}`)
console.log(`registrations are read from ${registryDir()}`)
console.log(`canvases are kept in ${databaseFile()}`)
console.log(`this host speaks protocol ${PROTOCOL}`)
console.log(`this host's own MCP door is at http://127.0.0.1:${server.port}/mcp`)
/* Said out loud at start, in the terminal somebody is looking at, for the same
   reason `run.sh` says where the epics come from: a host that migrated three
   kehikot into a project silently would be a host whose one irreversible-
   looking act left no trace anybody could find afterwards. */
if (settled.seeded) {
  console.log(
    `projects are folders; the first is ${settled.seeded.name} at ${settled.seeded.path}` +
      (settled.seeded.epics ? '' : ' (which holds no data/epics, so kehikot there have no epics to pick)'),
  )
}
if (settled.adopted) {
  console.log(`${settled.adopted} kehikko(t) written before projects existed were filed under it`)
}
