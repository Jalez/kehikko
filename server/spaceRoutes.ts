import type { Database } from 'bun:sqlite'
import { methodParams } from 'kehikot-module-protocol'

import { editIn, type PartsEdit } from '../src/host/parts.ts'
import { readSubject, setSubject } from './canvases.ts'
import { marksOf } from './dispositions.ts'
import { createEpic, deleteEpic, epicsIn, retitleEpic, type PartsEdited } from './holdings.ts'
import { keep } from './kehikot.ts'
import { projectById } from './projects.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'
import { spaceEditIn, spaceTree, type SpaceEdit, type SpaceEdited } from './spaces.ts'

/**
 * One project's epics, its tree of spaces and the parts of an epic, and the marks on its refs:
 *
 *  - `GET  /host/epics` — the epics and the spaces they make, for the host's own header.
 *  - `PATCH | POST | DELETE /host/epics` — an epic retitled, made, or deleted.
 *  - `POST /host/spaces` — one edit of the project's spaces.
 *  - `POST /host/parts` — one edit of an epic's parts.
 *  - `GET  /host/dispositions` — the marks people have put on the project's refs.
 */
export const SPACE_ROUTES = {
  epics: { method: 'GET', path: '/host/epics' },
  spaces: { method: 'POST', path: '/host/spaces' },
  dispositions: { method: 'GET', path: '/host/dispositions' },
  retitle: { method: 'PATCH', path: '/host/epics' },
  create: { method: 'POST', path: '/host/epics' },
  parts: { method: 'POST', path: '/host/parts' },
  remove: { method: 'DELETE', path: '/host/epics' },
} as const satisfies RouteTable

export interface SpaceRouteDeps {
  db: Database
  wakes: { epicsChanged(project: number): void }
  /** The epics in one epics directory (`listEpics`, the one reader's). */
  listEpics(dir: string): Parameters<typeof spaceTree>[1]
  /** The host wrote an epic itself: every container showing it is told. */
  epicWritten(root: string, slug: string): void
  /** One edit of an epic's parts, made and told. */
  partsEdited(root: string, slug: string, edit: PartsEdit): PartsEdited
  /** One edit of a project's spaces, made and told. */
  spacesEdited(project: { id: number; path: string }, edit: SpaceEdit): SpaceEdited
}

export function spaceDesk(deps: SpaceRouteDeps): Desk {
  const { db, wakes, listEpics, epicWritten, partsEdited, spacesEdited } = deps
  return routes(SPACE_ROUTES, {
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
     * A project with no `.kehikot/host/epics` and a project whose `.kehikot/host/epics` is empty
     * both answer with no epics, and only one of those should make the header
     * say "this project has none". See `Epics.tsx`.
     */
    epics: (_request, url) => {
      const asked = Number(url.searchParams.get('project') ?? '')
      const project = Number.isInteger(asked) ? projectById(db, asked) : null
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      const dir = epicsIn(project.path)
      const epics = dir ? listEpics(dir) : []
      /* The tree of spaces beside the epics it is made from (`server/spaces.ts`), read off the same listing. */
      return json({ holds: dir !== null, epics, spaces: dir ? spaceTree(project.path, epics) : [] })
    },

    /*
     * One edit of the project's spaces, from the space picker in the bar: `{ project, create | rename |
     * move | remove }` (`spaceEditIn`). The one writer is `editSpaces`; the door's space tools come to
     * the same function. A remove without `confirm` is answered `confirm` with what would go.
     */
    spaces: async (request) => {
      const body = (await request.json().catch(() => null)) as ({ project?: unknown } & Record<string, unknown>) | null
      if (!body || typeof body.project !== 'number') return json({ error: 'An edit of the spaces names one project and one change.' }, 400)
      const project = projectById(db, body.project)
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      const edit = spaceEditIn(body)
      if (!edit) return json({ error: 'One change at a time: create, rename, move or remove, each with its path.' }, 400)
      return json(spacesEdited(project, edit))
    },

    /*
     * The marks people have put on this project's refs, for `context.dispositions`.
     *
     * Read by the page on a project switch and whenever it is told one changed;
     * the page composes them into the context every framed module is sent. A
     * file that will not read is answered as no marks — the context is what
     * modules draw from, and a broken file is not a reason to draw nothing —
     * and a write to it is refused instead, in `setDisposition`.
     */
    dispositions: (_request, url) => {
      const asked = Number(url.searchParams.get('project') ?? '')
      const project = Number.isInteger(asked) ? projectById(db, asked) : null
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      return json({ dispositions: marksOf(project.path) })
    },

    /*
     * What one epic is CALLED, changed. What it IS does not move.
     *
     * The one write this host makes into a project’s `.kehikot/host/`, and the only one
     * it will: `.kehikot/host/epics/<slug>.json` is a document somebody wrote, under
     * their name in that repository's history, and this changes one field of it
     * and leaves every other byte alone. `retitleEpic` has the essay on why the
     * OTHER rename — the slug — is a migration across six programs rather than
     * a control in a dropdown, and is not here.
     *
     * Every check on what arrived is in that function, the way `addProject`
     * holds its own. This end reads a project id and turns it into a folder,
     * which is the one thing the function cannot do for itself.
     */
    retitle: async (request) => {
      const body = (await request.json().catch(() => null)) as
        | { project?: unknown; slug?: unknown; title?: unknown }
        | null
      if (!body || typeof body.project !== 'number') {
        return json({ error: 'A retitle names one project, one epic, and what it is to be called.' }, 400)
      }
      const project = projectById(db, body.project)
      if (!project) return json({ error: 'There is no project with that id.' }, 404)

      const said = retitleEpic(project.path, body.slug as string, body.title as string)
      if (!said.ok) return json({ error: said.why }, said.status)
      /* The title is part of what `epic.get` answers, so a container showing
         this epic reads it again. */
      epicWritten(project.path, said.epic.slug)
      return json({ epic: said.epic })
    },

    /*
     * A new epic, from the `+` beside the epic select.
     *
     * The second write this host makes into a project’s `.kehikot/host/` — the first
     * was the retitle above — and it is a file that did not exist rather than
     * a field of one that did. `createEpic` decides everything: the slug rule,
     * the title rule, the refusal to overwrite, and that a project with no
     * `.kehikot/host/epics` gets one made. This end turns a project id into a folder,
     * as the retitle does, and says so to every page standing in that
     * project — `epicsChanged` in `wake.ts` — because a second window's
     * dropdown would otherwise not have the new row until it switched project
     * and back. The door's `create_epic` in `mcp.ts` is the same function and
     * the same wake; the page's own re-read after this answer is the one
     * redundant read, and it is redundant rather than racing.
     */
    create: async (request) => {
      const body = (await request.json().catch(() => null)) as
        | { project?: unknown; slug?: unknown; title?: unknown }
        | null
      if (!body || typeof body.project !== 'number') {
        return json({ error: 'A new epic names one project and what it is to be called.' }, 400)
      }
      const project = projectById(db, body.project)
      if (!project) return json({ error: 'There is no project with that id.' }, 404)

      const made = createEpic(project.path, { slug: body.slug, title: body.title })
      if (!made.ok) return json({ error: made.why }, made.status)
      wakes.epicsChanged(project.id)
      epicWritten(project.path, made.epic.slug)
      return json({ epic: made.epic, madeDirectory: made.madeDirectory }, 201)
    },

    /*
     * One edit of an epic's list of parts, from the picker in the bar.
     *
     * The body is the protocol's own `parts.set` — `{ epic, add | rename |
     * move | remove }` — and is parsed by the protocol's schema, so the page
     * and a module are refused for the same things. `editParts` decides and
     * writes; the answer is the protocol's result and the epic's row as it
     * now reads, so the page that pressed replaces its row rather than
     * waiting to be told what it just did.
     */
    parts: async (request) => {
      const body = (await request.json().catch(() => null)) as ({ project?: unknown } & Record<string, unknown>) | null
      if (!body || typeof body.project !== 'number') {
        return json({ error: 'An edit of an epic’s parts names one project, one epic and one change.' }, 400)
      }
      const project = projectById(db, body.project)
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      const { project: _project, ...asked } = body
      const parsed = methodParams['parts.set'].safeParse(asked)
      const edit = parsed.success ? editIn(parsed.data) : null
      if (!parsed.success || !edit) {
        return json({ error: parsed.success ? 'One change at a time.' : (parsed.error.issues[0]?.message ?? 'That is not an edit of an epic’s parts.') }, 400)
      }
      const done = partsEdited(project.path, parsed.data.epic, edit)
      return json({ result: done.result, epic: done.epic })
    },

    /*
     * An epic, deleted, from the armed X on its row in the epic menu.
     *
     * `deleteEpic` removes the one file and nothing a module filed under the
     * slug. Every page standing in the project is told, as for a create.
     */
    remove: async (request) => {
      const body = (await request.json().catch(() => null)) as { project?: unknown; slug?: unknown } | null
      if (!body || typeof body.project !== 'number') {
        return json({ error: 'A delete names one project and one epic.' }, 400)
      }
      const project = projectById(db, body.project)
      if (!project) return json({ error: 'There is no project with that id.' }, 404)

      const gone = deleteEpic(project.path, body.slug as string)
      if (!gone.ok) return json({ error: gone.why }, gone.status)
      /* A project about a file that is gone is about nothing. Said here, by the
         owner of the subject, rather than left to whichever page pressed it. */
      if (readSubject(db, project.id)?.epic === body.slug) {
        setSubject(db, project.id, { epic: null })
        keep(db, project.id)
      }
      wakes.epicsChanged(project.id)
      epicWritten(project.path, body.slug as string)
      return json({ deleted: body.slug })
    },
  })
}
