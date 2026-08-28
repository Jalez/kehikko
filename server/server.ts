#!/usr/bin/env bun
import { LIMITS, PROTOCOL } from 'roadmap-module-protocol'
import { answer } from './answers.ts'
import {
  createCanvas,
  databaseFile,
  deleteCanvas,
  editCanvas,
  ensureCanvases,
  open,
  type CanvasEdit,
} from './canvases.ts'
import { look, type Presence } from './discover.ts'
import { readRegistrations, registryDir, type RegistrationSweep } from './registrations.ts'

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
async function sweep(): Promise<{ presences: Presence[]; sweep: RegistrationSweep; protocol: number }> {
  const found = await readRegistrations(registryDir())
  const presences = await Promise.all(found.registrations.map((registration) => look(registration)))

  callers.clear()
  for (const registration of found.registrations) callers.set(registration.id, registration.url)

  return { presences, sweep: found, protocol: PROTOCOL }
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

      return json(answer(body.module, body.method, body.params, (id) => callers.has(id)))
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
      return json({ canvases: ensureCanvases(db) })
    }

    if (url.pathname === '/host/canvases' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { name?: unknown } | null
      const name = typeof body?.name === 'string' ? body.name : undefined
      return json({ canvas: createCanvas(db, name) }, 201)
    }

    const canvas = canvasId(url.pathname)
    if (canvas !== null) {
      if (request.method === 'PATCH') {
        const body = (await request.json().catch(() => null)) as CanvasEdit | null
        if (!body || typeof body !== 'object') {
          return json({ error: 'A change to a canvas is an object.' }, 400)
        }
        /* Only the four fields, picked out by name. Handing the parsed body
           straight to the store would make every future column writable by
           anything that can POST — which is how an id becomes editable. */
        const edited = editCanvas(db, canvas, {
          ...(body.name !== undefined ? { name: String(body.name) } : {}),
          ...(body.epic !== undefined ? { epic: body.epic === null ? null : String(body.epic) } : {}),
          ...(body.project !== undefined
            ? { project: body.project === null ? null : String(body.project) }
            : {}),
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
