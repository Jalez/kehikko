import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LIMITS, MODULE_ID } from 'roadmap-module-protocol'

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
  /**
   * Whether this pane follows the height its module asks for.
   *
   * Off by default, and off is the honest default: a pane is the size the
   * person dragged it to. When it is on they have said, for this pane, that
   * they would rather it fitted its contents than stayed where they put it.
   *
   * Stored per placement rather than per module, because it is a property of
   * this pane on this kehikko — the same module can be a fixed strip on one and
   * grow to fit on another.
   */
  grow: boolean
  /**
   * Whether this pane has been pinned, and stops hearing about the canvas.
   *
   * Per placement rather than per module, unlike `state` and for the opposite
   * reason: a pin is a fact about one pane on one kehikko. Holding a module
   * still here while another kehikko moves it around is the entire use — two
   * panes on two epics, side by side, to compare.
   *
   * The module is told, in `roadmap.context`. A host that pinned silently would
   * leave a module describing itself as showing the open epic while it showed a
   * remembered one, unable to tell a person's pin from the canvas not having
   * moved — which is why this host refused to pin at all until the protocol
   * grew a word for it.
   */
  pinned: boolean
}

export interface Canvas {
  id: number
  name: string
  /** What the canvas is about — see `src/host/context.ts`. Either may be null. */
  epic: string | null
  project: string | null
  /**
   * What has been picked out on this canvas, as refs.
   *
   * Stored as one JSON column rather than as rows, which is the opposite of the
   * decision made for placements — and the difference is the reason. Placements
   * are rows so that "which canvases hold this module" has an answer, and the
   * canvas layer genuinely asks it. Nothing will ever ask which canvases have
   * `gh#131` selected; a selection is read whole, written whole, and never
   * queried across. A table for it would be schema for its own sake.
   */
  selection: string[]
  placements: Placement[]
}

/**
 * A placement as it ARRIVES, which is not quite a placement.
 *
 * Everything in it came over HTTP from a page and is checked before it is
 * written; the type says so by making the one field that has a sensible default
 * optional. A canvas sent by an older page, or by anything hand-written, has no
 * `grow` in it, and that is not an error — it is off.
 */
export type PlacementInput = Omit<Placement, 'grow' | 'pinned'> & { grow?: boolean; pinned?: boolean }

/** What a canvas may be changed to. Absent means unchanged; `null` means cleared. */
export interface CanvasEdit {
  name?: string
  epic?: string | null
  project?: string | null
  selection?: string[]
  placements?: PlacementInput[]
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

    /*
     * What a module asked the host to keep for it.
     *
     * Keyed by module and by nothing else — not by canvas. A module's page is
     * loaded once and shown on whichever canvas asks for it, so one module is
     * one document with one set of preferences; state per canvas would need the
     * document to be told it had moved, which is a message the protocol does
     * not have and should not grow.
     *
     * The host never reads the value. It is a string in, the same string out,
     * and keeping it that way is what stops this table becoming a settings
     * store whose schema the host would then have to know.
     */
    create table if not exists module_state (
      module text primary key,
      state  text not null
    );
  `)
  add(db, 'placements', 'grow', 'integer not null default 0')
  add(db, 'placements', 'pinned', 'integer not null default 0')
  add(db, 'canvases', 'selection', 'text')
  return db
}

/**
 * Add a column that a database made by an older version will not have.
 *
 * `create table if not exists` only builds tables that are absent; it does
 * nothing to one that already exists with fewer columns, and there are
 * databases on people's machines from before this column was thought of. So
 * every column added after the first release is added here, guarded by what the
 * database actually reports rather than by a version number this would also
 * have to keep.
 *
 * `alter table add column` with a default is cheap and rewrites nothing, and
 * asking `pragma table_info` first means running it twice is not an error.
 */
function add(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query<{ name: string }, []>(`pragma table_info(${table})`).all()
  if (columns.some((c) => c.name === column)) return
  db.exec(`alter table ${table} add column ${column} ${definition}`)
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
    .query<
      { id: number; name: string; epic: string | null; project: string | null; selection: string | null },
      []
    >('select id, name, epic, project, selection from canvases order by rank, id')
    .all()

  const placements = db
    .query<
      {
        canvas: number
        i: string
        x: number
        y: number
        w: number
        h: number
        grow: number
        pinned: number
      },
      []
    >('select canvas, module as i, x, y, w, h, grow, pinned from placements order by canvas, module')
    .all()

  const byCanvas = new Map<number, Placement[]>()
  for (const row of placements) {
    const { canvas, grow, pinned, ...rest } = row
    /* SQLite has no boolean. It comes back as 0 or 1 and is turned into one
       here, at the edge, so nothing above this line has to remember. */
    const placement: Placement = { ...rest, grow: grow === 1, pinned: pinned === 1 }
    const list = byCanvas.get(canvas)
    if (list) list.push(placement)
    else byCanvas.set(canvas, [placement])
  }

  return rows.map(({ selection, ...row }) => ({
    ...row,
    selection: refsFrom(selection),
    placements: byCanvas.get(row.id) ?? [],
  }))
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
  return { id: row.id, name: clean, epic: null, project: null, selection: [], placements: [] }
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
    if (edit.selection !== undefined) {
      db.query('update canvases set selection = ? where id = ?').run(
        JSON.stringify(refsIn(edit.selection)),
        id,
      )
    }
    if (edit.placements !== undefined) {
      db.query('delete from placements where canvas = ?').run(id)
      const insert = db.query(
        'insert or replace into placements (canvas, module, x, y, w, h, grow, pinned) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      for (const p of cleaned(edit.placements)) {
        insert.run(id, p.i, p.x, p.y, p.w, p.h, p.grow ? 1 : 0, p.pinned ? 1 : 0)
      }
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

/**
 * A selection read back out of its column.
 *
 * Anything that is not a list of plausible refs is no selection at all. The
 * column is JSON this host wrote, so in practice it parses — but a database on
 * somebody's own disk can be edited, restored from an older version, or
 * corrupted, and a selection that failed to read must not take the canvas down
 * with it. Nothing selected is a state the whole design already handles.
 */
function refsFrom(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? refsIn(parsed) : []
  } catch {
    return []
  }
}

/**
 * Refs, bounded before they are written.
 *
 * These arrived from a framed module. `LIMITS.REF` and `LIMITS.REFS` are the
 * protocol's own numbers and they are applied here as well as at the wire,
 * because this function is also what a hand-edited column goes through on the
 * way back out.
 */
function refsIn(values: readonly unknown[]): string[] {
  const kept: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (kept.length >= LIMITS.REFS) break
    if (typeof value !== 'string') continue
    const ref = value.trim()
    /* A duplicate is not a second selection of the same thing; it is the same
       one, and letting it through would make "how many are selected" a number
       that disagrees with what is on screen. */
    if (!ref || ref.length > LIMITS.REF || seen.has(ref)) continue
    seen.add(ref)
    kept.push(ref)
  }
  return kept
}

/**
 * What this module last asked the host to keep, or null.
 *
 * Null rather than an empty string, because a module has to tell "nothing kept"
 * from "kept, and it was empty" — only one of those means it should draw its
 * defaults.
 */
export function readState(db: Database, module: string): string | null {
  const row = db
    .query<{ state: string }, [string]>('select state from module_state where module = ?')
    .get(module)
  return row?.state ?? null
}

/** Keep a string for a module. The host does not read it; see `state.set`. */
export function keepState(db: Database, module: string, state: string): void {
  db.query('insert or replace into module_state (module, state) values (?, ?)').run(
    module,
    state.slice(0, LIMITS.MODULE_STATE),
  )
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
function cleaned(placements: PlacementInput[]): Placement[] {
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
      /* Anything but a literal `true` is off. A flag arriving from a page as a
         string, a number or nothing at all should not switch on a behaviour
         that resizes somebody's pane. */
      grow: p.grow === true,
      /* Same rule as `grow`: anything but a literal `true` is off. This one
         decides whether a module stops hearing about the canvas, which is not a
         behaviour to switch on because a string arrived. */
      pinned: p.pinned === true,
    })
  }
  return kept
}

function bounded(value: unknown, low: number, high: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return low
  return Math.min(high, Math.max(low, n))
}
