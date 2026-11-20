import type { Database } from 'bun:sqlite'

import { connectionsSettingSchema } from '../src/host/connections.ts'
import { createCanvas, deleteCanvas, editCanvas, ensureCanvases, hintSubject, listCanvases, listSubjects, type CanvasEdit, type PlacementInput } from './canvases.ts'
import { keep, syncEvery } from './kehikot.ts'
import { readShelves, saveLayout } from './layouts.ts'
import { listProjects, projectById } from './projects.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'

/**
 * The kehikot themselves, and the layouts they can be made from:
 *
 *  - `GET  /host/canvases` — every kehikko, from every project, and what each project is about.
 *  - `POST /host/canvases` — a new kehikko, empty or from a suggested layout.
 *  - `PATCH | DELETE /host/canvases/<id>` — one kehikko changed, or removed (`canvasId`).
 *  - `GET  /host/layouts`, `POST /host/layouts` — suggested layouts, and "Save this kehikko as a layout…". The POST is the page's alone.
 *  - `POST /host/connections` — the person's switches of how a kehikko's modules affect each other. The page's alone.
 */
export const CANVAS_ROUTES = {
  canvases: { method: 'GET', path: '/host/canvases' },
  newCanvas: { method: 'POST', path: '/host/canvases' },
  layouts: { method: 'GET', path: '/host/layouts' },
  saveLayout: { method: 'POST', path: '/host/layouts', pageOnly: true },
  connections: { method: 'POST', path: '/host/connections', pageOnly: true },
} as const satisfies RouteTable

export interface CanvasRouteDeps {
  db: Database
  /** Our suggested layouts, as the published list has them (`official.layouts`). */
  official: { layouts(): Parameters<typeof readShelves>[1] }
}

/**
 * The canvas a path names, or `null` if it does not name one.
 *
 * Deliberately strict about digits. `Number('1e3')` is 1000 and `Number(' 2 ')`
 * is 2, so a path that is not a plain integer would still address a canvas —
 * which is fine here and is exactly the habit that is not fine somewhere else.
 */
export function canvasId(pathname: string): number | null {
  const match = /^\/host\/canvases\/(\d{1,15})$/.exec(pathname)
  return match ? Number(match[1]) : null
}

export function canvasDesk(deps: CanvasRouteDeps): Desk {
  const { db, official } = deps

  const table = routes(CANVAS_ROUTES, {
    /* The canvases.
     *
     * Read on load and written on every rearrangement, which is a lot of small
     * writes — the page debounces them, and this end is cheap enough that it
     * would not matter if it did not.
     *
     * There is no authentication here and there is nothing to authenticate. The
     * server listens on loopback only, holds nothing but names and rectangles,
     * and belongs to the same person as everything it talks to. */
    canvases: (_request, url) => {
      /* Every kehikko, from every project, and the page shows one project's
         worth. See `listCanvases`: the union is what keeps a module's page
         alive across a project switch, which is the whole reason switching
         re-points modules instead of reloading them. */
      const projects = listProjects(db)
      /* The files first, because they are the record and a `git pull` since
         the last load may have changed them. Then the guarantee of at least
         one kehikko, and the file told about the one it made, if it made one.
         `trouble` is the files that would not read, as sentences for the
         footer — see `kehikot.ts`. */
      const trouble = syncEvery(db)
      const first = projects[0]?.id ?? null
      const canvases = ensureCanvases(db, first)
      keep(db, first)
      /* Which kehikko this browser remembers having open, said once by the page
         so the one-time move of the epic off the kehikot can prefer the one the
         person was last on. See `hintSubject`; after the first load it is a
         no-op. */
      const remembered = Number(url.searchParams.get('open'))
      if (Number.isInteger(remembered) && remembered > 0) {
        const moved = hintSubject(db, remembered)
        if (moved !== null) keep(db, moved)
      }
      /* What each project is about — its epic and selection — beside the
         kehikot rather than inside them, because it belongs to no kehikko. */
      return json({ projects, canvases, trouble, subjects: listSubjects(db) })
    },

    newCanvas: async (request) => {
      const body = (await request.json().catch(() => null)) as { name?: unknown; project?: unknown; placements?: unknown } | null
      const name = typeof body?.name === 'string' ? body.name : undefined
      /* Which project it goes in. A new kehikko belongs where the person was
         standing when they pressed new; a kehikko in no project is one no
         dropdown lists. */
      const project =
        typeof body?.project === 'number' && Number.isInteger(body.project) ? body.project : null
      if (project !== null && !projectById(db, project)) {
        return json({ error: 'There is no project with that id.' }, 404)
      }
      const made = createCanvas(db, name, project)
      /* Made from a suggested layout: its containers, checked by `editCanvas`
         exactly as a page's rearrangement is. */
      const canvas = Array.isArray(body?.placements)
        ? (editCanvas(db, made.id, { placements: body.placements as PlacementInput[] }) ?? made)
        : made
      keep(db, project)
      return json({ canvas }, 201)
    },

    /* Suggested layouts: ours, the open project's and the person's own — see
       `src/host/layouts.ts`. Read on every ask, so a layout a teammate
       committed is there after a pull. */
    layouts: (_request, url) => {
      const id = Number(url.searchParams.get('project'))
      const project = Number.isInteger(id) && id > 0 ? projectById(db, id) : null
      /* Ours as the published list has them (`official.layouts`), then the project's and the person's. */
      return json(readShelves(project?.path ?? null, official.layouts()))
    },

    /* "Save this kehikko as a layout…": the project's shelf or the person's.
       The page's alone (`PAGE_ONLY`): it writes into the project and the
       machine directory. */
    saveLayout: async (request) => {
      const body = (await request.json().catch(() => null)) as
        | { kehikko?: unknown; name?: unknown; summary?: unknown; where?: unknown }
        | null
      const canvas = listCanvases(db).find((one) => one.id === body?.kehikko)
      if (!body || !canvas) return json({ error: 'There is no kehikko with that id.' }, 404)
      const project = canvas.project === null ? null : projectById(db, canvas.project)
      const saved = saveLayout(canvas, project?.path ?? null, body)
      if (!saved.ok) return json({ error: saved.why }, saved.status)
      return json({ layout: saved.layout }, 201)
    },

    /*
     * The person's switches of the connections between a kehikko's modules (`src/host/connections.ts`):
     * the whole setting, held to its schema, written with the kehikko into `kehikot.json`. In
     * `PAGE_ONLY`: the person decides how their modules affect each other, and no program — no agent,
     * no module — may change it. A PATCH of the canvas does not carry it.
     */
    connections: async (request) => {
      const body = (await request.json().catch(() => null)) as { kehikko?: unknown; connections?: unknown } | null
      const read = connectionsSettingSchema.safeParse(body?.connections)
      if (!body || typeof body.kehikko !== 'number' || !read.success) {
        return json({ error: 'A change of connections names one kehikko and the whole setting: { off, only }.' }, 400)
      }
      const edited = editCanvas(db, body.kehikko, { connections: read.data })
      if (!edited) return json({ error: 'There is no canvas with that id.' }, 404)
      keep(db, edited.project)
      return json({ canvas: edited })
    },
  })

  /** One kehikko by the id in its path: a PATCH changes it, a DELETE removes it; any other method is not answered here. */
  async function byId(request: Request, url: URL): Promise<Response | null> {
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
          /* A project id, or nothing. It used to be `String(body.project)` —
             a name typed onto a canvas — and that is the field this whole
             change replaces; see the essay on `project` in `canvases.ts`. */
          ...(body.project !== undefined
            ? { project: typeof body.project === 'number' ? body.project : null }
            : {}),
          ...(Array.isArray(body.placements) ? { placements: body.placements } : {}),
        })
        if (!edited) return json({ error: 'There is no canvas with that id.' }, 404)
        keep(db, edited.project)
        return json({ canvas: edited })
      }

      if (request.method === 'DELETE') {
        /* Read before the delete, because afterwards there is no row to say
           which project's file has to lose a kehikko. */
        const project = listCanvases(db).find((one) => one.id === canvas)?.project ?? null
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
        keep(db, project)
        return json({ deleted: canvas })
      }
    }
    return null
  }

  return {
    async route(request, url) {
      return (await table.route(request, url)) ?? byId(request, url)
    },
  }
}
