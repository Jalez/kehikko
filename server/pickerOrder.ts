import type { Database } from 'bun:sqlite'

import {
  DEFAULT_SORTS,
  epicVisitKey,
  kehikkoVisitKey,
  projectVisitKey,
  sortsFrom,
  type PickerSorts,
  type Visit,
  type Visits,
} from '../src/host/pickerOrder.ts'

/**
 * How the project, epic and kehikko pickers are ordered, and when each place was
 * last visited (`src/host/pickerOrder.ts` has the rules).
 *
 * Both live in `frame.sqlite`, this machine's alone, so they survive a restart
 * and are the same in every window: the choices are one row of `settings`
 * (changed through `POST /host/settings`, `{ picker: { epics: 'recent' } }`),
 * the visits are rows of `visits`, written by `POST /host/visits` (`PAGE_ONLY`).
 * Never in a project's `.kehikot/`, and no MCP tool writes either.
 */

const KEY = 'picker-sort'

export function ensurePickerOrder(db: Database): void {
  db.exec(`
    create table if not exists settings (key text primary key, value text not null);
    create table if not exists visits (
      kind text    not null,
      key  text    not null,
      at   integer not null,
      primary key (kind, key)
    );
  `)
}

export function readSorts(db: Database): PickerSorts {
  try {
    ensurePickerOrder(db)
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    return row ? sortsFrom(JSON.parse(row.value)) : DEFAULT_SORTS
  } catch {
    return DEFAULT_SORTS
  }
}

export function writeSorts(db: Database, sorts: PickerSorts): void {
  ensurePickerOrder(db)
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify(sorts))
}

export function readVisits(db: Database): Visits {
  ensurePickerOrder(db)
  const out = { projects: {} as Record<string, number>, epics: {} as Record<string, number>, kehikot: {} as Record<string, number> }
  for (const row of db.query<{ kind: string; key: string; at: number }, []>('select kind, key, at from visits').all()) {
    if (row.kind === 'project') out.projects[row.key] = row.at
    else if (row.kind === 'epic') out.epics[row.key] = row.at
    else if (row.kind === 'kehikko') out.kehikot[row.key] = row.at
  }
  return out
}

/** Records a visit at `now`: the project, and its epic and kehikko when named. */
export function recordVisit(db: Database, visit: Visit, now = Date.now()): void {
  ensurePickerOrder(db)
  if (visit.left) recordVisit(db, visit.left, now - 1)
  const put = db.query('insert into visits (kind, key, at) values (?, ?, ?) on conflict (kind, key) do update set at = excluded.at')
  put.run('project', projectVisitKey(visit.project), now)
  if (visit.epic !== undefined) put.run('epic', epicVisitKey(visit.project, visit.epic), now)
  if (visit.kehikko !== undefined) put.run('kehikko', kehikkoVisitKey(visit.project, visit.kehikko), now)
}

/** What a POST body names as a visit, or null for anything else. */
export function visitOf(body: unknown): Visit | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { project, epic, kehikko, left } = body as { project?: unknown; epic?: unknown; kehikko?: unknown; left?: unknown }
  if (typeof project !== 'number' || !Number.isInteger(project) || project < 0) return null
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200
  if (epic !== undefined && epic !== null && !text(epic)) return null
  if (kehikko !== undefined && kehikko !== null && !text(kehikko)) return null
  const before = left === undefined || left === null ? null : visitOf(left)
  if (left !== undefined && left !== null && (!before || before.left)) return null
  return {
    project,
    ...(typeof epic === 'string' ? { epic } : {}),
    ...(typeof kehikko === 'string' ? { kehikko } : {}),
    ...(before ? { left: before } : {}),
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** `GET /host/visits` (when each place was last visited) and `POST /host/visits` (a visit, at the host's clock). */
export function visitsRoute(deps: { db: Database; now?: () => number }) {
  return async (request: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== '/host/visits') return null
    if (request.method === 'GET') return json({ ok: true, visits: readVisits(deps.db) })
    if (request.method !== 'POST') return json({ ok: false, why: 'GET or POST.' }, 405)
    const raw = await request.text()
    if (raw.length > 2000) return json({ ok: false, why: 'That request is too large.' }, 413)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ ok: false, why: 'The body is not JSON.' }, 400)
    }
    const visit = visitOf(body)
    if (!visit) return json({ ok: false, why: 'A visit names a project id, and may name an epic and a kehikko.' }, 400)
    recordVisit(deps.db, visit, deps.now?.())
    return json({ ok: true, visits: readVisits(deps.db) })
  }
}
