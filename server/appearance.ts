import type { Database } from 'bun:sqlite'

import { appearanceIn, type Appearance, type AppearanceAnswer } from '../src/host/appearance.ts'

/**
 * Settings › Appearance (`src/host/appearance.ts`): when every container's
 * header and footer show, how far a fold goes, the theme, the containers'
 * borders and background. The person's, on this machine: one row of
 * `settings` in `frame.sqlite`, changed only through `POST /host/settings`
 * (`{ appearance: { … } }`), which is `PAGE_ONLY`. No MCP tool reads or
 * changes it, and no module is told.
 */

const KEY = 'appearance'

export function readAppearance(db: Database): AppearanceAnswer {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    if (!row) return { ...appearanceIn(null), stored: false }
    return { ...appearanceIn(JSON.parse(row.value)), stored: true }
  } catch {
    return { ...appearanceIn(null), stored: false }
  }
}

export function writeAppearance(db: Database, appearance: Appearance): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  const { rows, foldRows, theme, border, background } = appearance
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(
    KEY,
    JSON.stringify({ rows, foldRows, theme, border, background }),
  )
}
