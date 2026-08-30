#!/usr/bin/env bun
import { LIMITS, PROTOCOL, WELL_KNOWN } from 'roadmap-module-protocol'
import { answer } from './answers.ts'
import {
  createCanvas,
  databaseFile,
  deleteCanvas,
  editCanvas,
  ensureCanvases,
  keepState,
  open,
  readState,
  type CanvasEdit,
} from './canvases.ts'
import { adopt, addProject, listProjects, projectById } from './projects.ts'
import { browse, rootsFor } from './folders.ts'
import { epicsIn, listEpics } from './holdings.ts'
import { agentKnows, awarenessOf, scopeOf, type AgentAwareness } from './agents.ts'
import { look, type Presence } from './discover.ts'
import { answered, start, startable } from './launch.ts'
import { readRegistrations, registryDir, type RegistrationSweep } from './registrations.ts'
import { addArgs, connect, disconnect, doorFor, repoint, SCOPE } from './register.ts'
import { toolsAt } from './tools.ts'

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
async function sweep(): Promise<{
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
      return json(await sweep())
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
      const can = startable(now.registrations.find((r) => r.id === body.module) ?? null)
      if (!can.ok) return json({ ok: false, why: can.why }, 409)

      const ran = start(can.run)
      /* Started is not running, so the module is given a moment to come up and
         is then asked. Sweeping immediately reported every successful start as
         a failure: the spawn worked, the module answered a second later, and
         the sweep had already run before the dev server bound its port. */
      if (ran.ok) await answered(can.run.url, WELL_KNOWN)
      const after = ran.ok ? await sweep() : null
      return json({
        ...ran,
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

    if (url.pathname.startsWith('/host/')) {
      return json({ ok: false, reason: 'unknown-method', error: 'No such endpoint.' }, 404)
    }

    return elsewhere()
  },
})

console.log(`the canvas is at http://127.0.0.1:${server.port}`)
console.log(`registrations are read from ${registryDir()}`)
console.log(`canvases are kept in ${databaseFile()}`)
console.log(`this host speaks protocol ${PROTOCOL}`)
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
