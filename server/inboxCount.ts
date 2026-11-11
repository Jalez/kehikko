import type { Database } from 'bun:sqlite'

/**
 * "Show notification colour and number" (the bar's Inbox count, its popover's checkbox).
 *
 * On, the bar's count of what needs the person is a number beside the Inbox icon in the attention
 * colour; off, the plain icon with no number and no colour (`countLook` in `src/host/inboxBar.ts`).
 * On by default. The person's, on this machine: one row of `settings` in `frame.sqlite`, changed
 * only through `POST /host/settings` (`{ inbox: { colour } }`), which is `PAGE_ONLY`.
 */

const KEY = 'inbox-count-colour'

export const INBOX_COLOUR_DEFAULT = true

export function readInboxColour(db: Database): boolean {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    if (!row) return INBOX_COLOUR_DEFAULT
    const stored = JSON.parse(row.value) as unknown
    return typeof stored === 'object' && stored !== null && typeof (stored as { colour?: unknown }).colour === 'boolean'
      ? (stored as { colour: boolean }).colour
      : INBOX_COLOUR_DEFAULT
  } catch {
    return INBOX_COLOUR_DEFAULT
  }
}

export function writeInboxColour(db: Database, colour: boolean): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(
    KEY,
    JSON.stringify({ colour }),
  )
}

/** A change the route takes: `{ colour: boolean }`, or null for anything else. */
export function inboxColourChange(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const colour = (body as { colour?: unknown }).colour
  return typeof colour === 'boolean' ? colour : null
}
