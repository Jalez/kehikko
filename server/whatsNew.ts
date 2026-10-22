import type { Database } from 'bun:sqlite'

import type { ModuleRelease } from '../src/host/moduleReleases.ts'
import { worksWithSaid, type WorksWith } from '../src/host/worksWith.ts'
import {
  acknowledged,
  afterRead,
  baselined,
  rangeFor,
  recordSchema,
  type InstalledModule,
  type Position,
  type WhatsNewEdit,
  type WhatsNewRecord,
} from '../src/host/whatsNew.ts'

/**
 * "What's new" after an update, kept: one row of `settings` in `frame.sqlite`
 * (`src/host/whatsNew.ts` has the shape and the rules) — the app version and
 * each installed module's position the person last acknowledged, and whether
 * they want the dialog after updates. Machine level: it is about this
 * computer's Kehikot, not a project.
 *
 * `GET /host/whats-new` reads it beside each installed module's position
 * (from its copy, nothing asked of the network); `POST` changes it and is in
 * `PAGE_ONLY` — no program but this host's page says the person read something.
 */

const KEY = 'whats-new'

export function ensureWhatsNew(db: Database): void {
  db.exec(`
    create table if not exists settings (
      key   text primary key,
      value text not null
    );
  `)
}

/** The record, or null when nothing was ever recorded (the very first run). */
export function readWhatsNew(db: Database): WhatsNewRecord | null {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    return row ? recordSchema.parse(JSON.parse(row.value)) : null
  } catch {
    return null
  }
}

function write(db: Database, record: WhatsNewRecord): WhatsNewRecord {
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify(record))
  return record
}

/**
 * One change. `here` is every installed module's position now, for the
 * baseline; a change to a record that does not exist yet starts from it.
 */
export function editWhatsNew(db: Database, edit: WhatsNewEdit, here: () => Promise<Record<string, Position>>): Promise<WhatsNewRecord> {
  return (async () => {
    const was = readWhatsNew(db)
    if ('baseline' in edit) {
      const next = baselined(was, edit.baseline.app, await here())
      return was && JSON.stringify(next) === JSON.stringify(was) ? was : write(db, next)
    }
    const base = was ?? baselined(null, null, await here())
    if ('acknowledge' in edit) return write(db, acknowledged(base, edit.acknowledge))
    if ('read' in edit) return write(db, afterRead(base, edit.read.module, edit.read.from, edit.read.to))
    return write(db, { ...base, show: edit.show })
  })()
}

/** Where an installed copy is, from what `readCheckout` found. */
export function positionOf(release: ModuleRelease | undefined, commit: string): Position {
  return { release: release?.installed ?? null, commit: release?.installed ? null : commit }
}

/** One installed module, as "What's new" needs it. `works` is read for the tags named. */
export async function installedModule(input: {
  id: string
  name: string
  release: ModuleRelease | undefined
  commit: string
  record: WhatsNewRecord | null
  /** The copy's own release tags (no network). */
  local(): Promise<string[]>
  works(tags: readonly string[]): Promise<Record<string, WorksWith>>
}): Promise<InstalledModule> {
  const position = positionOf(input.release, input.commit)
  const range = position.release ? rangeFor(input.record?.modules[input.id], position, await input.local()) : []
  const named = [...new Set([...range, ...(position.release ? [position.release] : [])])]
  const works: Record<string, string> = {}
  if (named.length) {
    for (const [tag, one] of Object.entries(await input.works(named).catch(() => ({}) as Record<string, WorksWith>))) works[tag] = worksWithSaid(one)
  }
  return {
    id: input.id,
    name: input.name,
    repo: input.release?.repo ?? null,
    follows: input.release?.follows ?? 'main',
    position,
    range,
    works,
  }
}
