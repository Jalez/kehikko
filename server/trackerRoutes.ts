import { trackerEditSchema } from '../src/host/trackerSources.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'
import type { StartupTimeline } from './startupTimeline.ts'
import { spell } from './trackers/edit.ts'
import type { Trackers } from './trackers/reading.ts'

/**
 * A project's tracker reading and its sources, for the page:
 *
 *  - `GET  /host/tracker?project=N` — the reading, as the bar shows it.
 *  - `POST /host/trackers` — one edit of the sources, or a "Check" of one. The page's alone.
 *  - `POST /host/tracker/refresh` — the person's Refresh all. The page's alone.
 */
export const TRACKER_ROUTES = {
  tracker: { method: 'GET', path: '/host/tracker' },
  trackers: { method: 'POST', path: '/host/trackers', pageOnly: true },
  refresh: { method: 'POST', path: '/host/tracker/refresh', pageOnly: true },
} as const satisfies RouteTable

export interface TrackerRouteDeps {
  trackers: Pick<Trackers, 'signal' | 'get' | 'describe' | 'check' | 'edit' | 'refresh'>
  /** The project with this id, or null. */
  projectById(id: number): { path: string } | null
  startup: Pick<StartupTimeline, 'mark'>
}

export function trackerDesk(deps: TrackerRouteDeps): Desk {
  const { trackers, projectById, startup } = deps
  return routes(TRACKER_ROUTES, {
    /*
     * The open project's tracker reading, as the bar shows it: when it last
     * changed, whether a read is running, and how each source fared. Asking
     * is somebody looking, so the first ask for a project starts its first
     * read and keeps its schedule running — see `Trackers.signal`.
     */
    tracker: async (_request, url) => {
      const asked = Number(url.searchParams.get('project') ?? '')
      const project = Number.isInteger(asked) ? projectById(asked) : null
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      startup.mark('page asked for the tracker')
      const signal = trackers.signal(project.path)
      const reading = trackers.get(project.path, { refs: [] })
      const listing = await trackers.describe(project.path)
      return json({ ...signal, sources: 'refused' in reading ? [] : reading.sources, listing })
    },

    /*
     * One edit of the project's tracker sources — add, remove, switch a flag,
     * the schedule, the remotes switch — or a one-off "Check" of a source
     * before it is added. The page's alone (`PAGE_ONLY`): it writes
     * `.kehikot/host/trackers.json` and spends the person's rate limit.
     * Answered with the sources as they now stand; a write has the host read
     * again, and every container is told as for any read.
     */
    trackers: async (request) => {
      const body = (await request.json().catch(() => null)) as { project?: unknown; edit?: unknown } | null
      const project = typeof body?.project === 'number' ? projectById(body.project) : null
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      const asked = trackerEditSchema.safeParse(body?.edit)
      if (!asked.success) return json({ error: 'That is not an edit of the tracker sources.' }, 400)
      const edit = asked.data
      if (edit.kind === 'check') {
        const spelled = spell(edit.input, edit.tracker, edit.host)
        if (!spelled.ok) return json({ outcome: 'declined', why: spelled.why, needs: spelled.needs ?? null, said: '' })
        const found = await trackers.check(project.path, { tracker: spelled.tracker, host: spelled.host, repo: spelled.repo, default: false, listed: false })
        return json(
          found.ok
            ? { outcome: 'read', why: '', said: `${spelled.repo} on ${spelled.host}: ${found.issues}${found.capped ? '+' : ''} issue${found.issues === 1 && !found.capped ? '' : 's'}, ${found.changes}${found.capped ? '+' : ''} change${found.changes === 1 && !found.capped ? '' : 's'} found.`, issues: found.issues, changes: found.changes, source: spelled }
            : { outcome: 'failed', why: found.why, said: '', source: spelled },
        )
      }
      return json(await trackers.edit(project.path, edit))
    },

    /*
     * "Refresh all": read every source of the project again, and answer when
     * it lands. Every page standing in the project hears it start and land
     * through `/host/watch`, and every module through `context.tracker`.
     */
    refresh: async (request) => {
      const body = (await request.json().catch(() => null)) as { project?: unknown } | null
      const project = typeof body?.project === 'number' ? projectById(body.project) : null
      if (!project) return json({ error: 'There is no project with that id.' }, 404)
      return json(await trackers.refresh(project.path, { project: true }, 'press'))
    },
  })
}
