import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MODULE_ID } from 'roadmap-module-protocol'

/**
 * The canvases, which are the one thing this host does store.
 *
 * ## Why there is a database here at all
 *
 * There did not used to be. The arrangement lived in `localStorage`, and the
 * argument for that was good while it was true: a layout is a property of one
 * person looking at one screen, it is not a document, and putting it on the
 * server would make the host something that has a database — and then there
 * would be a question about what else belongs in it.
 *
 * What changed is that there is now more than one canvas. A canvas has a NAME
 * somebody typed, it is one of several, and a person moves between them. That
 * is no longer a view preference; it is a small amount of the person's own
 * work, and work that exists only in a browser profile is work a cleared cache
 * destroys without asking.
 *
 * The question about what else belongs in it has an answer, and it is the same
 * answer as before: nothing. This database holds canvases and the placements on
 * them. It holds nothing about a module beyond its id — no cached manifest, no
 * last-known condition, no name — because a module is a running program and the
 * only honest source for what it is, is it.
 *
 * ## What stays in the browser
 *
 * Which canvas is open. That genuinely is a property of one tab: two windows on
 * two screens showing two canvases is a reasonable thing to do, and a server
 * that stored "the current canvas" would make them fight over it.
 *
 * ## Placements are rows, not a blob
 *
 * A JSON column would have been fewer lines. Rows are here so that "which
 * canvases is this module on" is a question with an answer — which the canvas
 * needs, because a module placed on two of them is loaded once and shown twice.
 */

/** Where the file lives. `ROADMAP_FRAME_DB` overrides it, which is what makes this testable. */
export function databaseFile(env: Record<string, string | undefined> = process.env): string {
  return env.ROADMAP_FRAME_DB ?? join(homedir(), '.roadmap', 'frame.sqlite')
}

export interface Placement {
  i: string
  x: number
  y: number
  w: number
  h: number
}

export interface Canvas {
  id: number
  name: string
  /** What the canvas is about — see `src/host/context.ts`. Either may be null. */
  epic: string | null
  project: string | null
  placements: Placement[]
}

/** What a canvas may be changed to. Absent means unchanged; `null` means cleared. */
export interface CanvasEdit {
  name?: string
  epic?: string | null
  project?: string | null
  placements?: Placement[]
}

const NAME_MAX = 60
const PLACEMENTS_MAX = 64

/**
 * Open the store, creating it if it is not there.
 *
 * `busy_timeout` before `journal_mode`, and both before anything else: WAL is
 * itself a write, and a second process arriving at the same moment takes
 * `SQLITE_BUSY` from the pragma rather than from any statement anybody wrote.
 * Two windows of this host on one machine is an ordinary thing to do and it
 * must not be a race.
 */
export function open(file = databaseFile()): Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.exec('pragma busy_timeout = 5000')
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma foreign_keys = ON')
  db.exec(`
    create table if not exists canvases (
      id      integer primary key autoincrement,
      name    text    not null,
      rank    integer not null,
      epic    text,
      project text
    );
    create table if not exists placements (
      canvas integer not null references canvases(id) on delete cascade,
      module text    not null,
      x      integer not null,
      y      integer not null,
      w      integer not null,
      h      integer not null,
      primary key (canvas, module)
    );
    create index if not exists placements_by_module on placements (module);
  `)
  return db
}

/**
 * Every canvas, in the order they are shown.
 *
 * All of them, with their placements, in two queries rather than one per
 * canvas. There will never be enough canvases for that to matter and it is
 * still the right shape: the caller wants the whole list, and a list that
 * arrives in pieces is a list that can be half-read.
 */
export function listCanvases(db: Database): Canvas[] {
  const rows = db
    .query<{ id: number; name: string; epic: string | null; project: string | null }, []>(
      'select id, name, epic, project from canvases order by rank, id',
    )
    .all()

  const placements = db
    .query<{ canvas: number; i: string; x: number; y: number; w: number; h: number }, []>(
      'select canvas, module as i, x, y, w, h from placements order by canvas, module',
    )
    .all()

  const byCanvas = new Map<number, Placement[]>()
  for (const row of placements) {
    const { canvas, ...placement } = row
    const list = byCanvas.get(canvas)
    if (list) list.push(placement)
    else byCanvas.set(canvas, [placement])
  }

  return rows.map((row) => ({ ...row, placements: byCanvas.get(row.id) ?? [] }))
}

/** Make one. It goes at the end, because that is where a person looks for a thing they just made. */
export function createCanvas(db: Database, name?: string): Canvas {
  const clean = tidyName(name) ?? 'canvas'
  const row = db
    .query<{ id: number }, [string]>(
      'insert into canvases (name, rank) values (?, (select coalesce(max(rank), 0) + 1 from canvases)) returning id',
    )
    .get(clean)
  if (!row) throw new Error('the canvas was not written')
  return { id: row.id, name: clean, epic: null, project: null, placements: [] }
}

/**
 * Change one, and say whether there was one to change.
 *
 * In a transaction, because a rename and a rearrangement arriving together must
 * not half-happen — and because replacing the placements is a delete and then
 * an insert, which is exactly the shape that leaves a canvas empty if it stops
 * in the middle.
 */
export function editCanvas(db: Database, id: number, edit: CanvasEdit): Canvas | null {
  const write = db.transaction(() => {
    const exists = db.query<{ id: number }, [number]>('select id from canvases where id = ?').get(id)
    if (!exists) return false

    if (edit.name !== undefined) {
      const name = tidyName(edit.name)
      /* A name that is only spaces is not a rename, it is a slip of the hand.
         The previous name is kept rather than replaced with an empty label,
         because a canvas with no name in the switcher is one nobody can pick
         out of a list. */
      if (name) db.query('update canvases set name = ? where id = ?').run(name, id)
    }
    if (edit.epic !== undefined) {
      db.query('update canvases set epic = ? where id = ?').run(subject(edit.epic), id)
    }
    if (edit.project !== undefined) {
      db.query('update canvases set project = ? where id = ?').run(subject(edit.project), id)
    }
    if (edit.placements !== undefined) {
      db.query('delete from placements where canvas = ?').run(id)
      const insert = db.query(
        'insert or replace into placements (canvas, module, x, y, w, h) values (?, ?, ?, ?, ?, ?)',
      )
      for (const p of cleaned(edit.placements)) insert.run(id, p.i, p.x, p.y, p.w, p.h)
    }
    return true
  })

  if (!write()) return null
  return listCanvases(db).find((canvas) => canvas.id === id) ?? null
}

/**
 * Remove one, and say whether there was one to remove.
 *
 * The last canvas cannot be deleted, and that is less a safety rail than an
 * admission: this host with no canvas has no state to be in. Some screen would
 * have to explain that there is nothing and offer the one button that makes a
 * canvas — which is the empty canvas, spelled worse.
 */
export function deleteCanvas(db: Database, id: number): 'deleted' | 'no-such-canvas' | 'the-last-one' {
  const total = db.query<{ n: number }, []>('select count(*) as n from canvases').get()?.n ?? 0
  const exists = db.query<{ id: number }, [number]>('select id from canvases where id = ?').get(id)
  if (!exists) return 'no-such-canvas'
  if (total <= 1) return 'the-last-one'
  db.query('delete from canvases where id = ?').run(id)
  return 'deleted'
}

/**
 * The canvases, with a guarantee that there is at least one.
 *
 * A first run has no rows, and a host whose first screen reads "you have no
 * canvases, make one" has asked a person to do something the program could have
 * done itself.
 */
export function ensureCanvases(db: Database): Canvas[] {
  const canvases = listCanvases(db)
  if (canvases.length) return canvases
  return [createCanvas(db, 'canvas')]
}

/** Which canvases hold a module. The reason placements are rows. */
export function canvasesHolding(db: Database, module: string): number[] {
  return db
    .query<{ canvas: number }, [string]>('select canvas from placements where module = ? order by canvas')
    .all(module)
    .map((row) => row.canvas)
}

function tidyName(name: string | undefined): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim().slice(0, NAME_MAX)
  return trimmed || null
}

function subject(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, 80)
  return trimmed || null
}

/**
 * Placements, made safe to write.
 *
 * Every one of these arrived over HTTP from a page, and the page got them from
 * a grid library reacting to a mouse. Neither is malicious and neither is a
 * reason to skip this: the bounds are what stop a stored arrangement from being
 * one no version of this host can lay out, and the id shape is what stops a row
 * keyed by something that is not a module.
 */
function cleaned(placements: Placement[]): Placement[] {
  const seen = new Set<string>()
  const kept: Placement[] = []
  for (const p of placements) {
    if (kept.length >= PLACEMENTS_MAX) break
    if (typeof p?.i !== 'string' || !MODULE_ID.test(p.i) || seen.has(p.i)) continue
    seen.add(p.i)
    kept.push({
      i: p.i,
      x: bounded(p.x, 0, 200),
      y: bounded(p.y, 0, 10_000),
      w: bounded(p.w, 1, 200),
      h: bounded(p.h, 1, 400),
    })
  }
  return kept
}

function bounded(value: unknown, low: number, high: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return low
  return Math.min(high, Math.max(low, n))
}
