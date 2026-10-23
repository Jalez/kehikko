import type { Database } from 'bun:sqlite'

/**
 * "Keep this project's modules running" (Settings › Module tools).
 *
 * On, a module on any kehikko of a project a page has open is started in the
 * background and kept running while that project stays open, so switching
 * kehikko inside the project finds it up (`toWarm` in `lifecycle.ts`). Off,
 * only the open kehikko's modules run, as before. On by default: switching is
 * what people do all day, and the price — each module's dev server holds
 * roughly 100–300 MB resident (measured: 200–280 MB just after its page first
 * loaded, nearer 80 MB long after) — is said beside the switch.
 *
 * One row of `settings` in `frame.sqlite`, this machine's alone, changed only
 * through `POST /host/settings` (`{ modules: { keep } }`), which is `PAGE_ONLY`.
 */

const KEY = 'keep-project-modules'

export const KEEP_RUNNING_DEFAULT = true

export function ensureKeepRunning(db: Database): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
}

export function readKeepRunning(db: Database): boolean {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    if (!row) return KEEP_RUNNING_DEFAULT
    const stored = JSON.parse(row.value) as unknown
    return typeof stored === 'object' && stored !== null && typeof (stored as { keep?: unknown }).keep === 'boolean'
      ? (stored as { keep: boolean }).keep
      : KEEP_RUNNING_DEFAULT
  } catch {
    return KEEP_RUNNING_DEFAULT
  }
}

export function writeKeepRunning(db: Database, keep: boolean): void {
  ensureKeepRunning(db)
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(
    KEY,
    JSON.stringify({ keep }),
  )
}

/** A change the route takes: `{ keep: boolean }`, or null for anything else. */
export function keepRunningChange(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const keep = (body as { keep?: unknown }).keep
  return typeof keep === 'boolean' ? keep : null
}
