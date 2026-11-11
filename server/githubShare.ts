import type { Database } from 'bun:sqlite'

import { SHARE_PERCENT, sharePercentOf } from '../src/host/githubShare.ts'

/**
 * Kehikot's share of the person's GitHub hourly limit, as a whole percent:
 * machine-wide, one row of `settings` in `frame.sqlite` (like
 * `autoUpdates.ts`). The rule that spends it is `decide` in `githubAccount.ts`.
 */
const KEY = 'github-share'

export function readGithubShare(db: Database): number {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    if (!row) return SHARE_PERCENT.default
    const stored = JSON.parse(row.value) as { percent?: unknown } | null
    return sharePercentOf(stored?.percent) ?? SHARE_PERCENT.default
  } catch {
    return SHARE_PERCENT.default
  }
}

export function writeGithubShare(db: Database, percent: number): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify({ percent }))
}
