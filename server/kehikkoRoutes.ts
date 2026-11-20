import type { Database } from 'bun:sqlite'

import { listCanvases, type Canvas } from './canvases.ts'
import { copiedSaid, copyKehikko, elsewhere as kehikotElsewhere } from './fromProject.ts'
import { editKehikkoSettings } from './kehikkoSettings.ts'
import { listKehikkoSkills, removeKehikkoSkill, saveKehikkoSkill, skillsRel } from './kehikkoSkills.ts'
import { projectById } from './projects.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'

/**
 * One kehikko's own things, for the page:
 *
 *  - `GET  /host/kehikot/elsewhere`, `POST /host/kehikot/copy` — "From another project" in the New kehikko dialog. The copy is the page's alone.
 *  - `GET  /host/kehikko-skills`, `POST /host/kehikko-skills` — its skills. The POST is the page's alone.
 *  - `GET  /host/kehikko-settings`, `POST /host/kehikko-settings` — its settings. The POST is the page's alone.
 */
export const KEHIKKO_ROUTES = {
  elsewhere: { method: 'GET', path: '/host/kehikot/elsewhere' },
  copy: { method: 'POST', path: '/host/kehikot/copy', pageOnly: true },
  skills: { method: 'GET', path: '/host/kehikko-skills' },
  editSkills: { method: 'POST', path: '/host/kehikko-skills', pageOnly: true },
  settings: { method: 'GET', path: '/host/kehikko-settings' },
  editSettings: { method: 'POST', path: '/host/kehikko-settings', pageOnly: true },
} as const satisfies RouteTable

export interface KehikkoRouteDeps {
  db: Database
  wakes: { woke(canvas: number): void }
  /** The agent modules placed on one kehikko, in the order they are placed. */
  agentModulesOfCanvas(canvas: Canvas): string[]
  /** What `GET /host/kehikko-settings` answers for one kehikko. */
  kehikkoSettingsAnswer(canvas: Canvas, project: number): unknown
}

export function kehikkoDesk(deps: KehikkoRouteDeps): Desk {
  const { db, wakes, agentModulesOfCanvas, kehikkoSettingsAnswer } = deps
  return routes(KEHIKKO_ROUTES, {
    /* "From another project" in the New kehikko dialog (`server/fromProject.ts`): every other
       project, recent first, with its kehikot — the frame's rows and each kehikko's skill names,
       nothing of the project's data. The copy itself is the page's alone (`PAGE_ONLY`); an agent
       makes one through the door's `create_kehikko`. */
    elsewhere: (_request, url) => {
      const id = Number(url.searchParams.get('project'))
      return json({ projects: kehikotElsewhere(db, Number.isInteger(id) && id > 0 ? id : null) })
    },
    copy: async (request) => {
      const body = (await request.json().catch(() => null)) as { from?: unknown; into?: unknown; name?: unknown; take?: unknown } | null
      if (!body) return json({ error: 'Say which kehikko to copy and into which project.' }, 400)
      const copied = copyKehikko(db, body)
      if (!copied.ok) return json({ error: copied.why }, copied.status)
      wakes.woke(copied.canvas.id)
      return json({ canvas: copied.canvas, said: copiedSaid(copied, []) }, 201)
    },

    /* A kehikko's own skills (`server/kehikkoSkills.ts`, protocol 2.53.0):
       the person's, for every agent session on that kehikko. The GET is the
       page's list; the POST — save, rename, remove — is in `PAGE_ONLY`, and no
       MCP tool writes one. */
    skills: (_request, url) => {
      const canvas = listCanvases(db).find((one) => one.id === Number(url.searchParams.get('kehikko')))
      if (!canvas) return json({ error: 'There is no kehikko with that id.' }, 404)
      const project = canvas.project === null ? null : projectById(db, canvas.project)
      return json({ skills: listKehikkoSkills(project?.path ?? null, canvas.key), folder: project ? skillsRel(canvas.key) : null })
    },
    editSkills: async (request) => {
      const body = (await request.json().catch(() => null)) as
        | { kehikko?: unknown; act?: unknown; name?: unknown; description?: unknown; body?: unknown; was?: unknown }
        | null
      const canvas = listCanvases(db).find((one) => one.id === body?.kehikko)
      if (!body || !canvas) return json({ error: 'There is no kehikko with that id.' }, 404)
      const project = canvas.project === null ? null : projectById(db, canvas.project)
      if (body.act === 'remove') {
        const done = removeKehikkoSkill(project?.path ?? null, canvas.key, body.name)
        return done.ok ? json({ said: done.said }) : json({ error: done.why }, done.status)
      }
      if (body.act !== 'save') return json({ error: 'act is save or remove.' }, 400)
      const done = saveKehikkoSkill(project?.path ?? null, canvas.key, body)
      return done.ok ? json({ skill: done.skill, said: done.said }) : json({ error: done.why }, done.status)
    },

    /* A kehikko's own settings (`server/kehikkoSettings.ts`): which agent module is primary. The
       GET is the page's; the POST is in `PAGE_ONLY`, and no MCP tool reads or changes them. */
    settings: (_request, url) => {
      const canvas = listCanvases(db).find((one) => one.id === Number(url.searchParams.get('kehikko')))
      if (!canvas) return json({ error: 'There is no kehikko with that id.' }, 404)
      if (canvas.project === null) return json({ settings: { primary: null, later: [] }, agents: [], primary: null, due: false })
      return json(kehikkoSettingsAnswer(canvas, canvas.project))
    },
    editSettings: async (request) => {
      const body = (await request.json().catch(() => null)) as { kehikko?: unknown; primary?: unknown; later?: unknown } | null
      const canvas = listCanvases(db).find((one) => one.id === body?.kehikko)
      if (!body || !canvas) return json({ error: 'There is no kehikko with that id.' }, 404)
      if (canvas.project === null) return json({ error: 'That kehikko stands in no project.' }, 409)
      const agents = agentModulesOfCanvas(canvas)
      const edit =
        body.later === true ? { later: agents }
        : body.primary === null || typeof body.primary === 'string' ? { primary: body.primary as string | null }
        : null
      if (!edit) return json({ error: 'Say primary (a module id or null) or later: true.' }, 400)
      const done = editKehikkoSettings(db, canvas.project, canvas.key, edit, agents)
      if (!done.ok) return json({ error: done.why }, done.status)
      return json(kehikkoSettingsAnswer(canvas, canvas.project))
    },
  })
}
