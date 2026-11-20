import type { Database } from 'bun:sqlite'
import { LIMITS } from 'kehikot-module-protocol'

import { hold, undeclaredLine } from '../src/host/grants.ts'
import type { PartsEdit } from '../src/host/parts.ts'
import { answerCall, type AnswerDeps } from './answers.ts'
import { keepFor, keepState } from './canvases.ts'
import { setDisposition } from './dispositions.ts'
import type { PartsEdited } from './holdings.ts'
import { known } from './known.ts'
import { listProjects, projectById } from './projects.ts'
import { projectsMine } from './projectsMine.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'
import { tag, type TrafficDoor } from './traffic.ts'

/**
 * `POST /host/call` — one question from one framed module, relayed by the page.
 */
export const CALL_ROUTES = {
  call: { method: 'POST', path: '/host/call' },
} as const satisfies RouteTable

export interface CallRouteDeps {
  db: Database
  /** The modules the registry names, by id. */
  callers: { has(id: string): boolean; readonly size: number }
  /** Sweep the registry and ask every registered program what it is. */
  sweep(): Promise<unknown>
  /** Whether a module's last manifest declared a capability. */
  declared(module: string, capability: string): boolean
  messageRoutes: { pageAnswer(module: string, method: 'messages.mine' | 'messages.post', params: unknown, project: number | null): unknown }
  wakes: { dispositionsChanged(project: number): void }
  trackers: AnswerDeps['trackers']
  contentWatch: { reported(root: string, module: string): void }
  contents: { announce(root: string, module: string, epic: string | null): void }
  /** One edit of an epic's parts, made and told. */
  partsEdited(root: string, slug: string, edit: PartsEdit): PartsEdited
  trafficReading: TrafficDoor
  /** Who provides a service here. */
  servicesHere: NonNullable<AnswerDeps['services']>
}

export function callDesk(deps: CallRouteDeps): Desk {
  const { db, callers, sweep, declared, messageRoutes, wakes, trackers, contentWatch, contents, partsEdited, trafficReading, servicesHere } = deps

  /** The open project's folder, when the call named a project this host has. */
  function rootOf(project: unknown): string | null {
    if (typeof project !== 'number' || !Number.isInteger(project)) return null
    return projectById(db, project)?.path ?? null
  }

  return routes(CALL_ROUTES, {
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
    call: async (request) => {
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
        /* Which kehikko the frame stands on, as an id, for a write kept per
           container (protocol 2.51.0). Supplied by the page for the reason
           `project` is; checked against the placements before anything is kept. */
        kehikko?: unknown
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
      const named = body.module
      /* Recorded under the module the page relays for, with the method as the
         reason; reading and noting traffic is not recorded (a loop). */
      tag(request, { by: named, via: 'page', reason: body.method, ...(body.method.startsWith('traffic.') ? { skip: true } : {}) })

      /* If nothing has swept yet — a module framed by a page that was already
         open when this server restarted — sweep once so the answer is about the
         registry rather than about the host having just started. */
      if (!callers.size) await sweep()

      /* A module's page reading its own mail and posting in its own name
         (protocol 2.50.0): held to the manifest like every call, then answered
         from the record. `messages.say` is NOT here: it is the person's, and
         goes only through `/host/messages/say` (`messageRoutes.ts`). */
      if ((body.method === 'messages.mine' || body.method === 'messages.post') && callers.has(named)) {
        const held = hold(body.method, (capability) => declared(named, capability))
        if (held.held) {
          return json(body.method === 'messages.post' ? { ok: true, data: { outcome: 'declined', id: null, why: held.why } } : { ok: false, reason: 'failed', error: held.why })
        }
        return json(messageRoutes.pageAnswer(named, body.method, body.params, typeof body.project === 'number' ? body.project : null))
      }

      return json(
        await answerCall(named, body.method, body.params, {
          knownModule: (id) => callers.has(id),
          /* Protocol 2.51.0: for the container — the module on the kehikko the
             module names, else the one its frame stands on (`kehikko`, from the
             page). Module-wide only when nothing says which. */
          keep: (module, state, kehikko) => {
            const at = kehikko ?? (typeof body.kehikko === 'number' && Number.isInteger(body.kehikko) ? body.kehikko : null)
            if (at === null) {
              keepState(db, module, state)
              return true
            }
            return keepFor(db, at, module, state)
          },
          root: rootOf(body.project),
          /* A mark from a frame is a person's press inside a module, so it is
             signed with the module's name — the one the registry last heard it
             give, or its id. Every page in the project is woken only when the
             file actually changed. */
          mark: (module, root, marking) => {
            const done = setDisposition(root, marking, known(db).get(module)?.name ?? module)
            if (done.ok && done.changed && typeof body.project === 'number') {
              wakes.dispositionsChanged(body.project)
            }
            return done
          },
          trackers,
          /* A module's report of its own write. Signed with the module that
             asked, and the watcher is told so the file event for the same
             write says nothing more. */
          report: (module, root, epic) => {
            contentWatch.reported(root, module)
            contents.announce(root, module, epic)
          },
          /* An edit of an epic's parts, for a module whose manifest asked for
             it. Read off the last sweep's manifest, which no module can write. */
          divide: {
            may: declared,
            edit: (root, epic, edit) => partsEdited(root, epic, edit).result,
          },
          /* Every other method, held to the same list the same way. */
          grants: {
            may: declared,
            undeclared: (module, method, capability) => console.warn(`[host] ${undeclaredLine(module, method, capability)}`),
          },
          traffic: { door: trafficReading, via: 'page' },
          /* The projects the module keeps its own folder in (protocol 2.76.0). */
          mine: (module) => projectsMine(listProjects(db), module),
          /* Who provides a service here (protocol 2.81.0). */
          services: servicesHere,
        }),
      )
    },
  })
}
