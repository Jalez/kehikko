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
   * Whether this container follows the height its module asks for.
   *
   * Off by default, and off is the honest default: a container is the size the
   * person dragged it to. When it is on they have said, for this container, that
   * they would rather it fitted its contents than stayed where they put it.
   *
   * Stored per placement rather than per module, because it is a property of
   * this container on this kehikko — the same module can be a fixed strip on one and
   * grow to fit on another.
   */
  grow: boolean
  /**
   * Whether this container has been pinned, and stops hearing about the canvas.
   *
   * Per placement rather than per module, unlike `state` and for the opposite
   * reason: a pin is a fact about one container on one kehikko. Holding a module
   * still here while another kehikko moves it around is the entire use — two
   * containers on two epics, side by side, to compare.
   *
   * The module is told, in `roadmap.context`. A host that pinned silently would
   * leave a module describing itself as showing the open epic while it showed a
   * remembered one, unable to tell a person's pin from the canvas not having
   * moved — which is why this host refused to pin at all until the protocol
   * grew a word for it.
   */
  pinned: boolean
  /**
   * What somebody wrote on this container for another module to work from.
   *
   * A container AUTHORS a prompt and aims it at a module; the module it is aimed at
   * RECEIVES the composition of everything aimed at it. Both halves are stored
   * here because both are facts about this container on this kehikko: the same
   * module can carry different instructions on two different canvases, which is
   * most of the point of writing them per canvas rather than per module.
   *
   * Empty means nothing was written. `promptFor` naming a module that is not on
   * this canvas is not an error — a container can be taken off and put back, and
   * throwing the prompt away in between would lose something a person typed.
   */
  prompt: string
  promptFor: string | null
  /**
   * Whether this container is collapsed to its header.
   *
   * Per placement, like `grow` and `pinned` and for the same reason: it is a
   * statement about this container on this kehikko. The same module can be a
   * full-height panel on one canvas and a folded title bar on another, and
   * which it is is the arrangement's business.
   *
   * The module is NOT told, and that is a decision rather than an omission —
   * see the essay on `onCollapse` in `App.tsx`.
   */
  collapsed: boolean
  /**
   * The height this container had before it was collapsed, in grid rows.
   *
   * Remembered rather than recomputed. A container that expanded to a default height
   * would be a container that rearranged somebody's canvas for them — everything
   * below it moves, and nothing they did asked for that. `null` for a container that
   * has never been collapsed, which is every container in every database written
   * before this existed.
   */
  openH: number | null
  /**
   * Whether this container has been picked out as a target on this kehikko.
   *
   * ## A third axis, and it is not either of the other two
   *
   * `Canvas.selection` below is REFS — `gh#105`, `!44` — somebody picked out of
   * a tracker, and a passage is a place inside a document. Neither is this.
   * This says which of the containers arranged here are the ones being aimed
   * at: "work on these two", said about the canvas rather than about the work.
   *
   * ## Why it is a field on the placement rather than a list on the canvas
   *
   * The selection of refs is a JSON column on `canvases` because a ref is a
   * name for something outside this host, and nothing here can check it. A
   * container is not like that: it is a row in this table, and the only
   * containers that can be selected are the ones on the canvas. Putting the
   * flag ON the row makes that a fact of the schema rather than a rule somebody
   * has to enforce — a module taken off a kehikko takes its selection with it,
   * because the row is deleted, and there is no second list left holding the
   * name of a container that is not there.
   *
   * ## Why it is stored at all, when a passage is not
   *
   * A passage is not written down because it is a claim about a mutable file
   * that nobody is left to renew — see the essay in `src/App.tsx`. Run the same
   * test here and it comes out the other way. This is a claim about the
   * canvas's OWN arrangement, and the arrangement is the thing this database
   * exists to remember. A person who ticks three containers, closes the tab and
   * comes back has not stopped meaning those three; the containers are still
   * there, still in the same places, and a selection that evaporated overnight
   * would be the one part of their arrangement that did not survive being
   * looked away from.
   *
   * Per placement for the reason `pinned` and `collapsed` are: the same module
   * can be the target on one kehikko and a bystander on another, and which it
   * is, is that kehikko's business.
   *
   * The module is NOT told, and that is a decision rather than an omission —
   * see the essay on `onSelect` in `src/App.tsx`.
   */
  selected: boolean
  /**
   * Which of the filters this module offers are chosen for this container.
   *
   * A record of group id to option id, as the module named them. The host does
   * not know what any of it means — see the essay on `filterOptionSchema` in
   * the protocol — and stores it the way it stores `module_state`: because
   * somebody has to, and not because it can read it.
   *
   * ## Why here, and not in `module_state` or in the module
   *
   * `module_state` is keyed by module and by nothing else, deliberately, and
   * that is exactly wrong for this. Two containers showing the same module on
   * two different kehikot are two things a person is looking at in two
   * different ways: one narrowed to this file, one showing everything. Keyed by
   * module they would share a value and fight over it, which is not a
   * hypothetical — the notifications module keeps its scope in `localStorage`
   * today, which is per BROWSER, and every notifications container in every
   * canvas already shares one choice for that reason.
   *
   * The module remembering it for itself has a second problem on top of that
   * one. A module that is not running remembers nothing, and this host stops
   * modules and starts them again; a choice that only exists while the program
   * is up is a choice that does not survive quitting the app, which is the one
   * thing it has to do. And it would only work for modules that hold state at
   * all — several of the ones with filters do not, and a facility that covered
   * two thirds of the population would not have been worth building.
   *
   * So it goes where `collapsed`, `pinned` and `selected` go: on the row, in
   * this database, as a fact about how this container on this kehikko is being
   * looked at. It survives a restart, a reaped module, and closing the laptop.
   *
   * ## What is NOT promised
   *
   * That any of it still means anything. A module that changes its options
   * between one run and the next leaves values here naming things it no longer
   * offers, and this table cannot know: it never knew what they meant. Deciding
   * what to do about that is the page's, at the moment it has the live offer in
   * front of it — see `src/host/filters.ts`. What is stored is what was pressed.
   */
  filters: Record<string, string>
}

export interface Canvas {
  id: number
  name: string
  /** Which epic this kehikko is about — see `src/host/context.ts`. Null when none is picked. */
  epic: string | null
  /**
   * Which project this kehikko belongs to, as a project id.
   *
   * ## This used to be a name, and the name was the bug
   *
   * The column was `project text`, holding a project's name as a property of
   * one canvas. It was NULL on every canvas that has ever existed here, and
   * that is not because nobody filled it in — it is because it was the wrong
   * way round. A project is not a thing a canvas HAS; it is the thing a canvas
   * is IN. Three kehikot on this machine all showed epics out of
   * `~/Projects/roadmap` and not one of them said so, because saying so was a
   * label somebody had to remember to type rather than a fact about where they
   * were standing.
   *
   * So a project is a row of its own — a name and a folder — and this is a
   * foreign key into it. The hierarchy the user asked for is the one VS Code
   * has: a project is a folder you open, and a kehikko is a saved layout
   * inside it. One project, many kehikot, one per purpose.
   *
   * Nullable at the type level and, after `adopt()` has run, never null in
   * practice: a kehikko belonging to no project is a kehikko no project's
   * dropdown lists, which is work a person cannot reach. See `projects.ts`.
   */
  project: number | null
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
export type PlacementInput = Omit<
  Placement,
  'grow' | 'pinned' | 'prompt' | 'promptFor' | 'collapsed' | 'openH' | 'selected' | 'filters'
> & {
  grow?: boolean
  pinned?: boolean
  prompt?: string
  promptFor?: string | null
  collapsed?: boolean
  openH?: number | null
  selected?: boolean
  filters?: Record<string, string>
}

/** What a canvas may be changed to. Absent means unchanged; `null` means cleared. */
export interface CanvasEdit {
  name?: string
  epic?: string | null
  /** Which project this kehikko is in, as an id. Moving one between projects is a real edit. */
  project?: number | null
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
    /*
     * The projects, which are the containers everything else sits in.
     *
     * A project is a NAME and a FOLDER, and that is the whole of it. The user's
     * own framing: "a project can have one or many kehikkos — one kehikko can
     * focus on writing documentation, another on design, another on coding."
     * So the folder is the identity and the name is what goes on screen.
     *
     * The path is unique, because two rows pointing at the same folder are two
     * names for one project and every list that showed both would be lying
     * about how many there are. The name is NOT unique: two folders may
     * reasonably be called "roadmap", and refusing the second would be this
     * host having an opinion about somebody's disk.
     *
     * A git worktree gets no special column and needs none. A worktree is a
     * folder; opening one is opening a folder; the browser in folders.ts says
     * which folders are worktrees so a person can tell them apart, and nothing
     * downstream has to know.
     */
    create table if not exists projects (
      id   integer primary key autoincrement,
      name text    not null,
      path text    not null unique,
      rank integer not null
    );
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
  add(db, 'placements', 'prompt', "text not null default ''")
  add(db, 'placements', 'prompt_for', 'text')
  add(db, 'placements', 'collapsed', 'integer not null default 0')
  add(db, 'placements', 'open_h', 'integer')
  /* Whether a container is picked out as a target. Added to every database
     written before there was such a thing, where nothing is selected — which is
     what every container in them has been all along. */
  add(db, 'placements', 'selected', 'integer not null default 0')
  /* Which filter values a container is on, as JSON. Text rather than a table of
     its own for the reason `selection` on a canvas is text: it is read whole,
     written whole, and never queried by its contents — the host has no query it
     could write, since it does not know what any of the words mean. Empty
     object for every container written before this existed, which is what all
     of them were doing. */
  add(db, 'placements', 'filters', "text not null default '{}'")
  add(db, 'canvases', 'selection', 'text')
  /*
   * Which project a kehikko is in, added to databases written before projects
   * existed. Every canvas in one of those has NULL here until `adopt()` files
   * it — see `projects.ts`, and the essay on `project` above for why the text
   * column it replaces was the wrong shape rather than an unfilled one.
   *
   * `on delete cascade`, which SQLite honours because `foreign_keys` is on
   * above: removing a project removes its kehikot, because a kehikko in a
   * project that is gone is a layout of containers over a folder that is not there.
   */
  add(db, 'canvases', 'project_id', 'integer references projects(id) on delete cascade')
  /*
   * And the text column it replaces, taken out.
   *
   * Dropping is not this file's habit — every other schema change here is an
   * `add`, because a database on somebody's machine must open — and this one
   * earns the exception. Leaving `project text` in place would leave two
   * columns called nearly the same thing, one of which is a name and one of
   * which is an id, in a table two programs both write to. The next person to
   * type `project` in a query would get the dead one, which still contains
   * NULL on every row, and nothing would fail.
   *
   * Nothing is lost by dropping it: it is NULL on every canvas that has ever
   * been written, which is the whole reason this change is happening.
   */
  drop(db, 'canvases', 'project')
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
export function add(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query<{ name: string }, []>(`pragma table_info(${table})`).all()
  if (columns.some((c) => c.name === column)) return
  db.exec(`alter table ${table} add column ${column} ${definition}`)
}

/**
 * Take a column out, when the database is one that can.
 *
 * `alter table drop column` arrived in SQLite 3.35 and every Bun in use here is
 * far past it. The `try` is not scepticism about the version — it is about the
 * one thing SQLite refuses to drop, a column named in an index or a constraint,
 * which is a shape somebody could add later without thinking about this line.
 *
 * A drop that does not happen is harmless HERE and only here, because the
 * column being removed is dead: nothing reads it, nothing writes it, and it
 * holds NULL on every row. That is the condition under which this helper may be
 * used at all, and it is not a general licence to drop things quietly.
 */
export function drop(db: Database, table: string, column: string): void {
  const columns = db.query<{ name: string }, []>(`pragma table_info(${table})`).all()
  if (!columns.some((c) => c.name === column)) return
  try {
    db.exec(`alter table ${table} drop column ${column}`)
  } catch {
    /* Left in place, unread. See above for why that is survivable. */
  }
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
  /*
   * All of them, from every project, and the page filters.
   *
   * This is deliberate and it is what makes switching project free. The canvas
   * layer loads a module's page ONCE and keeps it for as long as the module is
   * on ANY kehikko — see `everyPlaced` and `Frames.tsx`. If this answered with
   * one project's kehikot, then switching project would shrink that union, and
   * every frame not on the new project's canvases would be unmounted: a
   * terminal mid-command killed, a half-typed line gone, every scroll position
   * lost. The user chose re-pointing over reloading precisely to avoid that, so
   * the server hands over everything and the header shows one project's worth.
   */
  const rows = db
    .query<
      { id: number; name: string; epic: string | null; project: number | null; selection: string | null },
      []
    >('select id, name, epic, project_id as project, selection from canvases order by rank, id')
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
        prompt: string
        prompt_for: string | null
        collapsed: number
        open_h: number | null
        selected: number
        filters: string
      },
      []
    >(
      'select canvas, module as i, x, y, w, h, grow, pinned, prompt, prompt_for, collapsed, open_h, selected, filters from placements order by canvas, module',
    )
    .all()

  const byCanvas = new Map<number, Placement[]>()
  for (const row of placements) {
    const {
      canvas,
      grow,
      pinned,
      prompt,
      prompt_for: promptFor,
      collapsed,
      open_h: openH,
      selected,
      filters,
      ...rest
    } = row
    /* SQLite has no boolean. It comes back as 0 or 1 and is turned into one
       here, at the edge, so nothing above this line has to remember. */
    const placement: Placement = {
      ...rest,
      grow: grow === 1,
      pinned: pinned === 1,
      prompt,
      promptFor,
      collapsed: collapsed === 1,
      openH,
      selected: selected === 1,
      filters: filtersFrom(filters),
    }
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
export function createCanvas(db: Database, name?: string, project: number | null = null): Canvas {
  const clean = tidyName(name) ?? 'canvas'
  const row = db
    .query<{ id: number }, [string, number | null]>(
      'insert into canvases (name, rank, project_id) values (?, (select coalesce(max(rank), 0) + 1 from canvases), ?) returning id',
    )
    .get(clean, project)
  if (!row) throw new Error('the canvas was not written')
  return { id: row.id, name: clean, epic: null, project, selection: [], placements: [] }
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
      /* An id or nothing. A project id that names no project is refused by the
         foreign key rather than by a check written here, which is the point of
         having turned this from a name into a key. */
      db.query('update canvases set project_id = ? where id = ?').run(
        typeof edit.project === 'number' && Number.isInteger(edit.project) ? edit.project : null,
        id,
      )
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
        'insert or replace into placements (canvas, module, x, y, w, h, grow, pinned, prompt, prompt_for, collapsed, open_h, selected, filters) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      for (const p of cleaned(edit.placements)) {
        insert.run(
          id,
          p.i,
          p.x,
          p.y,
          p.w,
          p.h,
          p.grow ? 1 : 0,
          p.pinned ? 1 : 0,
          p.prompt,
          p.promptFor,
          p.collapsed ? 1 : 0,
          p.openH,
          p.selected ? 1 : 0,
          JSON.stringify(p.filters),
        )
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
  const exists = db
    .query<{ project: number | null }, [number]>('select project_id as project from canvases where id = ?')
    .get(id)
  if (!exists) return 'no-such-canvas'

  /*
   * The last one IN ITS PROJECT, which is a narrower rule than the one this
   * used to have and a truer one.
   *
   * It used to count every canvas on the machine, and that was right when there
   * was one list of them. Now that a project shows its own kehikot and no
   * others, a project emptied of them is a project whose header has nothing to
   * open — the same nothing-to-be-in state the old rule was protecting, one
   * level down. Counting globally would let somebody empty the project they are
   * standing in as long as another project still had one, and they would be
   * looking at a header with no kehikko in it and no explanation.
   */
  const siblings =
    exists.project === null
      ? (db.query<{ n: number }, []>('select count(*) as n from canvases where project_id is null').get()?.n ?? 0)
      : (db
          .query<{ n: number }, [number]>('select count(*) as n from canvases where project_id = ?')
          .get(exists.project)?.n ?? 0)
  if (siblings <= 1) return 'the-last-one'
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
export function ensureCanvases(db: Database, project: number | null = null): Canvas[] {
  const canvases = listCanvases(db)
  const here = project === null ? canvases : canvases.filter((canvas) => canvas.project === project)
  if (here.length) return canvases
  createCanvas(db, 'kehikko', project)
  return listCanvases(db)
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
 * A container's filter choice, read back out of its column.
 *
 * The same shape of function as `refsFrom` above and for the same reason: the
 * column is JSON this host wrote, so in practice it parses, and a database on
 * somebody's own disk can still be hand-edited, restored from an older version,
 * or corrupted. Nothing chosen is a state the whole design already handles —
 * every group falls back to whatever the module says its resting option is — so
 * a column that will not read costs a person their filter and never a canvas.
 */
function filtersFrom(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return filtersIn(parsed)
  } catch {
    return {}
  }
}

/**
 * A filter choice, bounded before it is written.
 *
 * Every string here was invented by a framed module and passed through a page,
 * and the host has never known what any of it means. `LIMITS.FILTER_ID` and
 * `LIMITS.FILTER_GROUPS` are the protocol's own numbers, applied here as well
 * as at the wire because this is also what a hand-edited column goes through on
 * the way back out.
 *
 * `Object.hasOwn` rather than `in`, and the three reserved names refused
 * outright: a record is a plain object, and `__proto__` as a key does not store
 * anything — it re-parents the object. The protocol refuses these ids at the
 * wire; this is the second half of the same defence, at the other door, because
 * a value in this column did not necessarily come through that one.
 */
function filtersIn(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const kept: Record<string, string> = {}
  let count = 0
  for (const group of Object.keys(value as Record<string, unknown>)) {
    if (count >= LIMITS.FILTER_GROUPS) break
    if (group === '__proto__' || group === 'constructor' || group === 'prototype') continue
    if (!group || group.length > LIMITS.FILTER_ID) continue
    const chosen = (value as Record<string, unknown>)[group]
    if (typeof chosen !== 'string' || !chosen || chosen.length > LIMITS.FILTER_ID) continue
    kept[group] = chosen
    count += 1
  }
  return kept
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

/** An epic slug as it arrives, trimmed and bounded. Nothing else uses this now. */
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
         that resizes somebody's container. */
      grow: p.grow === true,
      /* Same rule as `grow`: anything but a literal `true` is off. This one
         decides whether a module stops hearing about the canvas, which is not a
         behaviour to switch on because a string arrived. */
      pinned: p.pinned === true,
      /* Clipped rather than refused, unlike a ref. A clipped ref is a DIFFERENT
         ref filed against work nobody meant; a clipped prompt is the person's
         own text, and they are the one who will notice it ends mid-sentence. */
      prompt: typeof p.prompt === 'string' ? p.prompt.slice(0, LIMITS.PROMPT) : '',
      promptFor:
        typeof p.promptFor === 'string' && MODULE_ID.test(p.promptFor) ? p.promptFor : null,
      /* Same rule again: anything but a literal `true` is off. */
      collapsed: p.collapsed === true,
      /* Bounded exactly like `h`, because it BECOMES `h` the moment somebody
         expands the container. A remembered height that no version of this host
         could lay out is the same stored-unlayoutable-arrangement problem one
         press later. */
      openH: p.openH === null || p.openH === undefined ? null : bounded(p.openH, 1, 400),
      /* Same rule again: anything but a literal `true` is off. This one is what
         an agent reads to decide which containers it was pointed at, and a flag
         that switched on because the string "false" arrived would aim it at
         something nobody picked. */
      selected: p.selected === true,
      /* Bounded here as well as at the wire, and the bounds are the protocol's
         own. This is the door a page posts through, and a page is a program on
         somebody's machine like any other — the fact that this host ships the
         one that normally posts here is not a reason to trust what arrives. */
      filters: filtersIn(p.filters),
    })
  }
  return kept
}

function bounded(value: unknown, low: number, high: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return low
  return Math.min(high, Math.max(low, n))
}
