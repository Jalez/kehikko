import type { Database } from 'bun:sqlite'

import {
  normalTarget,
  PINNED_MAX,
  resolvePin,
  sameTarget,
  type PinEdit,
  type PinFacts,
  type PinNames,
  type PinnedPlace,
  type PinTarget,
  type StoredPin,
} from '../src/host/pinnedPlaces.ts'
import { listCanvases } from './canvases.ts'
import { epicsIn, listEpics, readParts } from './holdings.ts'
import { listProjects, type Project } from './projects.ts'

/**
 * The person's pinned places (`src/host/pinnedPlaces.ts` has the shape and
 * every rule): one table in `frame.sqlite`, this machine's alone, because a
 * pin spans projects and is the person's, never a project's. `GET
 * /host/pinned-places` reads them, resolved against what is there now; `POST`
 * makes one change and is in `PAGE_ONLY`. The door's `my_place` lists them
 * read-only; no door tool writes here.
 *
 * A pin keeps its project by the row id and the project's permanent id, so a
 * project forgotten and added again is still found; and the names it was made
 * with, so one whose project, kehikko, epic or parts are gone still says what
 * it was.
 */

export function ensurePinnedPlaces(db: Database): void {
  db.exec(`
    create table if not exists pinned_places (
      id          integer primary key autoincrement,
      project     integer not null,
      project_uid text,
      kehikko     text,
      epic        text,
      scope       text not null default 'epic',
      parts       text not null default '[]',
      names       text not null default '{}',
      position    integer not null,
      made_at     integer not null
    );
  `)
}

type Row = {
  id: number
  project: number
  project_uid: string | null
  kehikko: string | null
  epic: string | null
  scope: string
  parts: string
  names: string
}

function parsed<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function stored(row: Row): StoredPin & { uid: string | null } {
  const parts = parsed<unknown>(row.parts, [])
  const names = parsed<Partial<PinNames>>(row.names, {})
  return {
    id: row.id,
    uid: row.project_uid,
    target: normalTarget({
      project: row.project,
      kehikko: row.kehikko,
      epic: row.epic,
      scope: row.scope === 'project' ? 'project' : 'epic',
      parts: Array.isArray(parts) ? parts.filter((one): one is string => typeof one === 'string') : [],
    }),
    names: {
      project: typeof names.project === 'string' ? names.project : `project ${row.project}`,
      kehikko: typeof names.kehikko === 'string' ? names.kehikko : null,
      epic: typeof names.epic === 'string' ? names.epic : null,
      parts: names.parts && typeof names.parts === 'object' ? names.parts : {},
    },
  }
}

function rows(db: Database): Row[] {
  return db
    .query<Row, []>('select id, project, project_uid, kehikko, epic, scope, parts, names from pinned_places order by position, id')
    .all()
}

/** What is there now for one target, read from the database and the project's folder. */
function factsFor(db: Database, target: PinTarget, uid: string | null, projects: readonly Project[]): PinFacts {
  const project = projects.find((one) => one.id === target.project) ?? (uid ? projects.find((one) => one.uid === uid) : undefined)
  if (!project) return { project: null, kehikot: new Map(), epics: null, parts: null }
  const kehikot = new Map(
    listCanvases(db).flatMap((one) => (one.project === project.id && one.key ? [[one.key, one.name] as [string, string]] : [])),
  )
  const dir = project.missing ? null : epicsIn(project.path)
  const epics = dir ? new Map(listEpics(dir).map((one) => [one.slug, one.title || one.slug] as [string, string])) : project.missing ? null : new Map<string, string>()
  const held = dir && target.epic !== null ? readParts(dir, target.epic) : null
  const parts = held ? new Map(held.map((one) => [one.id, one.heading || one.id] as [string, string])) : null
  return { project: { id: project.id, name: project.name, missing: Boolean(project.missing) }, kehikot, epics, parts }
}

/** Every pin, first first, as it resolves now. */
export function readPinnedPlaces(db: Database): PinnedPlace[] {
  const projects = listProjects(db)
  return rows(db).map((row) => {
    const pin = stored(row)
    return resolvePin(pin, factsFor(db, pin.target, pin.uid, projects))
  })
}

export type PinEdited = { ok: true; pinned: PinnedPlace[] } | { ok: false; why: string; status: number }

/** One change: pin (newest first; the same place twice is one pin), unpin, or order. */
export function editPinnedPlaces(db: Database, edit: PinEdit, now: number = Date.now()): PinEdited {
  if ('pin' in edit) {
    const target = normalTarget(edit.pin)
    const all = rows(db).map(stored)
    if (!all.some((one) => sameTarget(one.target, target))) {
      if (all.length >= PINNED_MAX) return { ok: false, why: `At most ${PINNED_MAX} places can be pinned. Unpin one first.`, status: 409 }
      const projects = listProjects(db)
      const facts = factsFor(db, target, null, projects)
      if (!facts.project) return { ok: false, why: 'This host has no such project, so nothing was pinned.', status: 404 }
      const names: PinNames = {
        project: facts.project.name,
        kehikko: target.kehikko === null ? null : (facts.kehikot.get(target.kehikko) ?? null),
        epic: target.epic === null ? null : (facts.epics?.get(target.epic) ?? null),
        parts: Object.fromEntries(target.parts.map((id) => [id, facts.parts?.get(id) ?? id])),
      }
      const uid = projects.find((one) => one.id === target.project)?.uid ?? null
      const first = db.query<{ least: number | null }, []>('select min(position) as least from pinned_places').get()?.least ?? 0
      db.query(
        'insert into pinned_places (project, project_uid, kehikko, epic, scope, parts, names, position, made_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(target.project, uid, target.kehikko, target.epic, target.scope, JSON.stringify(target.parts), JSON.stringify(names), first - 1, now)
    }
  } else if ('unpin' in edit) {
    db.query('delete from pinned_places where id = ?').run(edit.unpin)
  } else {
    const held = rows(db).map((row) => row.id)
    const asked = [...new Set(edit.order)].filter((id) => held.includes(id))
    const order = [...asked, ...held.filter((id) => !asked.includes(id))]
    const move = db.query('update pinned_places set position = ? where id = ?')
    db.transaction(() => order.forEach((id, i) => move.run(i, id)))()
  }
  return { ok: true, pinned: readPinnedPlaces(db) }
}
