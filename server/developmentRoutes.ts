import type { developmentDesk } from './development.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'
import type { uninstallDesk } from './uninstall.ts'
import { folderSize, inspect as inspectUnused, moveToTrash, runGit, trashUnused as trashUnusedFolders, type UnusedDeps } from './unusedFolders.ts'

/**
 * Taking modules and their folders off this machine, and where the official modules run from:
 *
 *  - `GET  /host/uninstall`, `POST /host/uninstall` — what an uninstall takes, and doing it. The POST is the page's alone.
 *  - `GET  /host/development`, `POST /host/development` — "Kehikko development". The POST is the page's alone.
 *  - `GET  /host/unused-folders`, `POST /host/unused-folders` — "Move unused folders to the Trash". The POST is the page's alone.
 */
export const DEVELOPMENT_ROUTES = {
  uninstallPreview: { method: 'GET', path: '/host/uninstall' },
  uninstall: { method: 'POST', path: '/host/uninstall', pageOnly: true },
  development: { method: 'GET', path: '/host/development' },
  editDevelopment: { method: 'POST', path: '/host/development', pageOnly: true },
  unusedFolders: { method: 'GET', path: '/host/unused-folders' },
  trashUnused: { method: 'POST', path: '/host/unused-folders', pageOnly: true },
} as const satisfies RouteTable

export interface DevelopmentRouteDeps {
  uninstalling: Pick<ReturnType<typeof uninstallDesk>, 'preview' | 'uninstall'>
  development: Pick<ReturnType<typeof developmentDesk>, 'state' | 'setOn' | 'setModule' | 'unusedCandidates' | 'usedBy' | 'cleared'>
}

export function developmentRouteDesk(deps: DevelopmentRouteDeps): Desk {
  const { uninstalling, development } = deps

  /* What "Move unused folders to the Trash" reads and moves with. */
  const unusedDeps = (): UnusedDeps => ({
    candidates: () => development.unusedCandidates(),
    usedBy: (dir) => development.usedBy(dir),
    git: runGit,
    size: folderSize,
    trash: moveToTrash,
  })

  return routes(DEVELOPMENT_ROUTES, {
    /* Uninstall: `GET` is what the confirmation shows (what goes, the person's own folder, the projects
       with saved data and their sizes); `POST { module, projects? }` does it and answers the summary. */
    uninstallPreview: async (_request, url) => {
      const module = url.searchParams.get('module') ?? ''
      const seen = await uninstalling.preview(module)
      return seen.ok ? json(seen) : json({ error: seen.why }, seen.status)
    },
    uninstall: async (request) => {
      const body = (await request.json().catch(() => null)) as { module?: unknown; projects?: unknown } | null
      if (!body || typeof body.module !== 'string' || body.module.length > 64) return json({ error: 'An uninstall names one module.' }, 400)
      const done = await uninstalling.uninstall(body.module, { projects: body.projects === true })
      return done.ok ? json(done) : json({ error: done.why }, done.status)
    },

    /* "Kehikko development": the switch, a module's folder, and moving modules. `development.ts`. */
    development: async () => json(await development.state()),
    editDevelopment: async (request) => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (body && typeof body.on === 'boolean') {
        await development.setOn(body.on)
        return json(await development.state())
      }
      if (body && typeof body.module === 'string' && body.module.length <= 64) {
        const change = {
          ...(body.folder === null || (typeof body.folder === 'string' && body.folder.length <= 1024) ? { folder: body.folder as string | null } : {}),
          ...(typeof body.release === 'boolean' ? { release: body.release } : {}),
          ...(body.move === true ? { move: true as const } : {}),
          ...(body.move === true && body.now === true ? { now: true as const } : {}),
        }
        const done = await development.setModule(body.module, change)
        return done.ok ? json(await development.state()) : json({ error: done.why }, done.status)
      }
      return json({ error: 'A change of Kehikko development is { on } or { module, folder | release | move }.' }, 400)
    },

    /* "Move unused folders to the Trash": the folders Kehikot no longer uses, checked and listed (a read), and moved on a press. `unusedFolders.ts`. */
    unusedFolders: async () => {
      const folders = await inspectUnused(unusedDeps())
      return json({ folders, freedBytes: folders.filter((one) => one.trash).reduce((sum, one) => sum + one.bytes, 0) })
    },
    trashUnused: async (request) => {
      const body = (await request.json().catch(() => null)) as { trash?: unknown } | null
      if (!body || !Array.isArray(body.trash) || body.trash.length > 400 || !body.trash.every((dir) => typeof dir === 'string' && dir.length <= 1024)) return json({ error: 'Moving folders to the Trash names the folders, as { trash: [path, …] }.' }, 400)
      const { done, freed } = await trashUnusedFolders(body.trash as string[], unusedDeps())
      development.cleared(freed)
      console.log(`kehikko: ${done.moved.length} unused folder${done.moved.length === 1 ? '' : 's'} moved to the Trash, ${done.kept.length} kept`)
      return json(done)
    },
  })
}
