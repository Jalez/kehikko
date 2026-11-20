import type { Database } from 'bun:sqlite'

import { baseBranchOf, setBaseBranch } from './baseBranch.ts'
import { setSubject } from './canvases.ts'
import { browse, rootsFor } from './folders.ts'
import { keep, syncProject } from './kehikot.ts'
import { addProject, followedSaid, forgetProject, isProjectAnswer, listProjects, locateProject, projectAt, projectById, shareKehikot } from './projects.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'

/**
 * The projects, and what each is about:
 *
 *  - `GET | POST | PATCH | DELETE /host/projects` — the list, one more, shared or not, and forgotten.
 *  - `POST /host/projects/followed` — the page told the person a project was followed. The page's alone.
 *  - `POST /host/projects/locate` — "Locate…" for a project whose folder is gone. The page's alone.
 *  - `GET  /host/is-project` — whether one folder is a project here, for a module's server.
 *  - `GET | POST /host/base-branch` — one project's base branch. The POST is the page's alone.
 *  - `PATCH /host/subject` — what one project is about.
 *  - `GET  /host/folders` — the folders under one folder, to pick a project from.
 */
export const PROJECT_ROUTES = {
  projects: { method: 'GET', path: '/host/projects' },
  followed: { method: 'POST', path: '/host/projects/followed', pageOnly: true },
  isProject: { method: 'GET', path: '/host/is-project' },
  baseBranch: { method: 'GET', path: '/host/base-branch' },
  setBaseBranch: { method: 'POST', path: '/host/base-branch', pageOnly: true },
  share: { method: 'PATCH', path: '/host/projects' },
  forget: { method: 'DELETE', path: '/host/projects' },
  subject: { method: 'PATCH', path: '/host/subject' },
  add: { method: 'POST', path: '/host/projects' },
  locate: { method: 'POST', path: '/host/projects/locate', pageOnly: true },
  folders: { method: 'GET', path: '/host/folders' },
} as const satisfies RouteTable

export interface ProjectRouteDeps {
  db: Database
  wakes: { projectsChanged(): void }
  trackers: { forget(root: string): void }
  /** Follow a project folder renamed or moved while this host runs (`followProjects`). */
  followMoved(): void
  /** Watch the projects that have a screen, and stop watching the ones that lost theirs. */
  watchOpenProjects(): void
}

export function projectDesk(deps: ProjectRouteDeps): Desk {
  const { db, wakes, trackers, followMoved, watchOpenProjects } = deps
  return routes(PROJECT_ROUTES, {
    /* The projects: what is open, and one more.
     *
     * A project is a name and a folder. Adding one is the only write on this
     * host that turns a string from a page into a path files are later read
     * under, and every check on that string is in `addProject` rather than
     * here — one place, so a second endpoint cannot grow a weaker copy. */
    projects: () => {
      followMoved()
      return json({ projects: listProjects(db) })
    },

    /*
     * The page has told the person that a project was followed to where its
     * folder went (`followed` on the project); it is not said again. The page's
     * alone (`PAGE_ONLY`).
     */
    followed: async (request) => {
      const body = (await request.json().catch(() => null)) as { id?: unknown } | null
      if (!body || typeof body.id !== 'number') return json({ error: 'Which project.' }, 400)
      if (followedSaid(db, body.id)) wakes.projectsChanged()
      return json({ ok: true })
    },

    /*
     * Whether one folder is a project a person added here. For a module's
     * server, which is told a path by its page and has no other way to know
     * the path is one this host handed out. One path in, one answer out: yes
     * with the project's id, or no — with where the project went when the path
     * is one a project had (`isProjectAnswer`). The list is not what a module
     * is given — see `isProject`. Answered to this
     * host's page and to programs on this machine, like every read here, and
     * to no other page (`guard.ts`): a module's PAGE cannot ask.
     */
    isProject: (_request, url) => {
      const asked = url.searchParams.get('path')
      return json(isProjectAnswer(db, asked))
    },

    /*
     * One project's base branch (`baseBranch.ts`): what its settings name,
     * origin's default, and the one in force. Asked by the page with
     * `project=<id>`, and by a module's server with the `path=` its page was
     * told, answered only for a folder that is a project here, as
     * `/host/is-project` is. Setting it is the page's alone (`PAGE_ONLY`): it
     * writes a file that travels with the repository.
     */
    baseBranch: (_request, url) => {
      const id = Number(url.searchParams.get('project') ?? '')
      const root = url.searchParams.has('project')
        ? (Number.isInteger(id) ? projectById(db, id) : null)?.path
        : projectAt(db, url.searchParams.get('path'))?.path
      if (!root) return json({ error: 'There is no project there.' }, 404)
      return json({ ok: true, ...baseBranchOf(root) })
    },

    setBaseBranch: async (request) => {
      const body = (await request.json().catch(() => null)) as { project?: unknown; branch?: unknown } | null
      const project = typeof body?.project === 'number' ? projectById(db, body.project) : null
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      if (body?.branch !== null && typeof body?.branch !== 'string') return json({ error: 'branch is a branch name, or null for origin’s default.' }, 400)
      const edited = await setBaseBranch(project.path, body.branch)
      if (edited.outcome === 'declined') return json({ ok: false, why: edited.why })
      if (edited.outcome === 'changed') wakes.projectsChanged()
      return json({ ok: true, outcome: edited.outcome, said: edited.said, ...edited.base })
    },

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
    share: async (request) => {
      const body = (await request.json().catch(() => null)) as { id?: unknown; shared?: unknown } | null
      if (!body || typeof body.id !== 'number' || typeof body.shared !== 'boolean') {
        return json({ error: 'Which project, and shared or not.' }, 400)
      }
      const said = shareKehikot(db, body.id, body.shared)
      if (!said.ok) return json({ error: said.why }, said.status)
      return json({ project: said.project })
    },

    /*
     * Stop holding a folder as a project.
     *
     * DELETE with the id in the body, for the reason the PATCH above gives: one
     * flat path, and ids arrive by one road. It deletes nothing on disk — see
     * `forgetProject`, and the paragraph there about why erasing `.kehikot/`
     * is deliberately not what this word does now that papers live in it.
     */
    forget: async (request) => {
      const body = (await request.json().catch(() => null)) as { id?: unknown } | null
      if (!body || typeof body.id !== 'number') return json({ error: 'Which project.' }, 400)
      const said = forgetProject(db, body.id)
      if (!said.ok) return json({ error: said.why }, said.status)
      /* Nothing more is read or written there: no tracker schedule, no watch of its `.kehikot/`. */
      trackers.forget(said.project.path)
      watchOpenProjects()
      return json({ project: said.project, canvases: said.canvases })
    },

    /*
     * What one project is about: its epic, the parts of it picked out, and the
     * refs picked out of it.
     *
     * Its own flat path rather than a field on the projects PATCH, because the
     * two are different kinds of write: sharing is a write to a `.gitignore`,
     * and this is a write to the database and the project's `kehikot.json`.
     * Only `scope`, `epic`, `parts` and `selection` are read off the body, one at a
     * time, for the reason the canvas PATCH gives. The rule that a new epic
     * clears the parts and the selection is in `setSubject`, not here. There
     * is no kehikko in this body and there must not be: what a project is
     * about is not a property of a layout.
     */
    subject: async (request) => {
      const body = (await request.json().catch(() => null)) as
        | { project?: unknown; scope?: unknown; epic?: unknown; parts?: unknown; selection?: unknown; space?: unknown }
        | null
      if (!body || typeof body.project !== 'number') {
        return json({ error: 'A change to what a project is about names the project.' }, 400)
      }
      const said = setSubject(db, body.project, {
        /* "All epics", or back to one epic. Any other word is not a scope and is not read. */
        ...(body.scope === 'project' || body.scope === 'epic' ? { scope: body.scope } : {}),
        ...(body.epic !== undefined ? { epic: typeof body.epic === 'string' ? body.epic : null } : {}),
        ...(Array.isArray(body.parts) ? { parts: body.parts as string[] } : {}),
        ...(Array.isArray(body.selection) ? { selection: body.selection as string[] } : {}),
        /* A space by its path of ids and the children picked in it; it says the epic and the parts too. */
        ...(body.space === null
          ? { space: null }
          : body.space && typeof body.space === 'object' && Array.isArray((body.space as { ids?: unknown }).ids)
            ? { space: { ids: (body.space as { ids: string[] }).ids, picked: Array.isArray((body.space as { picked?: unknown }).picked) ? ((body.space as { picked: string[] }).picked) : [] } }
            : {}),
      })
      if (!said) return json({ error: 'There is no project with that id.' }, 404)
      keep(db, body.project)
      return json({ subject: { project: body.project, ...said } })
    },

    add: async (request) => {
      const body = (await request.json().catch(() => null)) as { path?: unknown; name?: unknown } | null
      if (!body || typeof body.path !== 'string') {
        return json({ error: 'A project is added by naming one folder.' }, 400)
      }
      const added = addProject(db, body.path, typeof body.name === 'string' ? body.name : undefined)
      if (!added.ok) return json({ error: added.why }, added.status)
      /* This is the moment a kehikko arrives from another computer: the folder
         was cloned with `.kehikot/host/kehikot.json` in it, and reading it
         here is what makes adding the project enough. The file wins over the
         empty kehikko `addProject` just made, which is the point. A file that
         will not read is reported on the load the page does next. */
      if (!added.already) syncProject(db, added.project)
      /* The folder carried the id of a project whose folder had gone: that
         project is here now. Its file is read where it is, and every page is
         told the list changed. */
      if (added.relinked) {
        syncProject(db, added.project)
        wakes.projectsChanged()
      }
      return json({ project: added.project, already: added.already, relinked: added.relinked === true }, added.already ? 200 : 201)
    },

    /*
     * "Locate…": a project whose folder is gone, pointed at where it went.
     *
     * The page's alone (`PAGE_ONLY`): it is a person's answer to a question
     * the page asked. Every check — that the folder carries the project's own
     * id, and the second step for a project that never had one — is in
     * `locateProject`. On success the project's file is read where it is now,
     * and every page is told the list changed.
     */
    locate: async (request) => {
      const body = (await request.json().catch(() => null)) as { id?: unknown; path?: unknown; anyway?: unknown } | null
      if (!body || typeof body.id !== 'number' || typeof body.path !== 'string') {
        return json({ error: 'Which project, and which folder.' }, 400)
      }
      const found = locateProject(db, body.id, body.path, body.anyway === true)
      if (!found.ok) return json({ error: found.why, ...(found.anyway ? { anyway: true } : {}) }, found.status)
      syncProject(db, found.project)
      wakes.projectsChanged()
      return json({ project: found.project })
    },

    /*
     * The folders under one folder, so a person can pick a project.
     *
     * A browser cannot hand a page a real path — `showDirectoryPicker` returns
     * an opaque handle — and a path is exactly what a module needs. So the
     * server lists and the page draws. Every refusal is in `folders.ts`, with
     * the four rules and what each one is for; this end only supplies the roots,
     * which are home plus the folders already opened as projects.
     */
    folders: (_request, url) => {
      const roots = rootsFor(listProjects(db).map((project) => project.path))
      const browsed = browse(url.searchParams.get('path'), roots)
      if (!browsed.ok) return json({ error: browsed.why }, browsed.status)
      return json({ listing: browsed.listing, roots })
    },
  })
}
