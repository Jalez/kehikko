import type { Database } from 'bun:sqlite'

/**
 * "Keep this project's modules running" (Settings › Project).
 *
 * On, a module on any kehikko of THIS project, while a page has the project
 * open, is started in the background and kept running, so switching kehikko
 * inside the project finds it up (`toWarm` in `lifecycle.ts`). Off, only the
 * open kehikko's modules run for it, as before. On by default: switching is
 * what people do all day, and the price — each module's dev server holds
 * roughly 100–300 MB resident — is said beside the switch.
 *
 * ## Per project, and where it is kept
 *
 * The choice is about THIS computer's memory for one project, so it is not the
 * project's own file: `<project>/.kehikot/` is shared with everyone working on
 * the project (it may be committed), and one person's memory budget is not
 * theirs to set. It is machine state keyed by project id, in `frame.sqlite`
 * beside the tracker-news mute and the other per-project machine rows, never
 * in the project (`dev/storage-boundary.ts` allows `frame.sqlite`).
 *
 * A module on kehikot of several projects is kept while ANY of those projects
 * keeps its modules: it is warm if some kehikko of an open project that keeps
 * it holds it (`wanted`).
 *
 * ## The migration
 *
 * Until this existed the choice was one machine-wide row of `settings`
 * (`keep-project-modules`). The first time anything here runs on such a
 * database, that value is written as each known project's own and the old row
 * is removed, so a person who turned it off still has it off everywhere, and a
 * project made afterwards starts from the default.
 *
 * Changed only through `POST /host/settings`
 * (`{ modules: { project, keep } }`), which is `PAGE_ONLY`.
 */

const OLD_KEY = 'keep-project-modules'

export const KEEP_RUNNING_DEFAULT = true

const ready = new WeakSet<Database>()

/** The table, and the one-time move of the old machine-wide value onto every known project. */
export function ensureKeepRunning(db: Database): void {
  if (ready.has(db)) return
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.exec('create table if not exists project_keep_running (project integer primary key, keep integer not null)')
  try {
    const old = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(OLD_KEY)
    if (old) {
      let keep = KEEP_RUNNING_DEFAULT
      try {
        const stored = JSON.parse(old.value) as { keep?: unknown } | null
        if (typeof stored?.keep === 'boolean') keep = stored.keep
      } catch {
        /* An unreadable old value is the default. */
      }
      db.transaction(() => {
        db.query('insert or ignore into project_keep_running (project, keep) select id, ? from projects').run(keep ? 1 : 0)
        db.query('delete from settings where key = ?').run(OLD_KEY)
      })()
    }
  } catch {
    /* No settings or projects table yet: the old row waits, and the move is tried again. */
    return
  }
  ready.add(db)
}

/** Whether one project keeps its modules running. */
export function readKeepRunning(db: Database, project: number): boolean {
  ensureKeepRunning(db)
  const row = db.query<{ keep: number }, [number]>('select keep from project_keep_running where project = ?').get(project)
  return row ? row.keep !== 0 : KEEP_RUNNING_DEFAULT
}

/** Every project that has said, by id; a project not in it keeps the default. */
export function keepRunningProjects(db: Database): Record<number, boolean> {
  ensureKeepRunning(db)
  const out: Record<number, boolean> = {}
  for (const row of db.query<{ project: number; keep: number }, []>('select project, keep from project_keep_running').all()) out[row.project] = row.keep !== 0
  return out
}

/** The rule `wanted` takes: one snapshot, so a sweep does not ask the database per module. */
export function keepingOf(db: Database): (project: number) => boolean {
  const said = keepRunningProjects(db)
  return (project) => said[project] ?? KEEP_RUNNING_DEFAULT
}

export function writeKeepRunning(db: Database, project: number, keep: boolean): void {
  ensureKeepRunning(db)
  db.query('insert into project_keep_running (project, keep) values (?, ?) on conflict (project) do update set keep = excluded.keep').run(project, keep ? 1 : 0)
}

/** A change the route takes: `{ project: number, keep: boolean }`, or null for anything else. */
export function keepRunningChange(body: unknown): { project: number; keep: boolean } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { project, keep } = body as { project?: unknown; keep?: unknown }
  if (typeof keep !== 'boolean' || typeof project !== 'number' || !Number.isInteger(project)) return null
  return { project, keep }
}
