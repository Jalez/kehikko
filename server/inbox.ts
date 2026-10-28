import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import {
  activityItemsSchema,
  moduleFile,
  within,
  type ActivityItem,
  type ActivityState,
} from 'kehikot-module-protocol'
import { z } from 'zod'

import {
  ENTRIES_MAX,
  applyList,
  inScope,
  isDismissed,
  isOpen,
  isSeen,
  logRows,
  noticeEntry,
  placeGone,
  retire,
  rowKey,
  type Closing,
  type Entry,
  type LogRow,
  type Move,
  type NoticeLine,
  type Origin,
  type Place,
  type Present,
  type Priority,
  type Scope,
} from '../src/host/inbox.ts'
import type { Where } from '../src/host/activity.ts'

/**
 * The Inbox's record, on this machine and not in the project.
 *
 * ## Where it lives, and why there
 *
 * In the host's own database (`frame.sqlite`, the machine directory), per
 * project id, beside the kehikot and the pins. What a module said it was
 * doing, and what a person has seen of it, is a fact about THIS machine and
 * THIS person's attention: it must not travel with the repository the way
 * `kehikot.json` does, and a teammate's `git pull` must not mark your things
 * seen. The rows go with the project when the project is removed
 * (`on delete cascade`).
 *
 * ## What it holds
 *
 * One `inbox_items` row per (project, module, item id) — the item and its
 * life, see `src/host/inbox.ts` — and one `inbox_moves` row for each state it
 * has entered. The server is the authority for the timeline: the page POSTs
 * each module's list, the same pure `applyList` runs here, and what happened
 * while nobody was looking is answerable (`read_inbox`).
 *
 * Bounded: `ENTRIES_MAX` entries per project; past it the oldest CLOSED go
 * first, then the oldest of what is left that is not live.
 */

const PENDING_MAX = 400

interface ItemRow {
  project: number
  module: string
  id: string
  name: string
  state: string
  label: string
  detail: string | null
  place: string | null
  priority: string
  refs: string
  grp: string | null
  entered: number
  opened: number
  closed: number | null
  how: string | null
  seen: number | null
  dismissed: number | null
  origin: string
}

const STATES = new Set<string>(['working', 'attention', 'done'])
const PRIORITIES = new Set<string>(['urgent', 'normal', 'low'])
const HOWS = new Set<string>(['listed', 'silent', 'unreported', 'gone', 'notice', 'imported'])
const ORIGINS = new Set<string>(['activity', 'notice', 'imported'])

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function toEntry(row: ItemRow): Entry {
  const place = parseJson<Place | null>(row.place, null)
  const refs = parseJson<unknown>(row.refs, [])
  return {
    module: row.module,
    name: row.name,
    id: row.id,
    state: (STATES.has(row.state) ? row.state : 'done') as ActivityState,
    label: row.label,
    ...(row.detail ? { detail: row.detail } : {}),
    ...(place ? { place } : {}),
    priority: (PRIORITIES.has(row.priority) ? row.priority : 'normal') as Priority,
    refs: Array.isArray(refs) ? refs.filter((one): one is string => typeof one === 'string') : [],
    ...(row.grp ? { group: row.grp } : {}),
    entered: row.entered,
    opened: row.opened,
    closed: row.closed,
    how: row.how !== null && HOWS.has(row.how) ? (row.how as Closing) : null,
    seen: row.seen,
    dismissed: row.dismissed,
    origin: (ORIGINS.has(row.origin) ? row.origin : 'activity') as Origin,
  }
}

/** The scope a call narrows by: the same inputs the page's panel has. */
export interface Narrowing {
  scope: Scope
  at: Pick<Where, 'epic' | 'kehikko'>
}

export interface Snapshot {
  /** Changes with every write; a page keeps the latest it has seen. */
  rev: number
  /** Every open entry, dismissed and seen included: the page decides what to draw. */
  open: Entry[]
  /** How many entries are closed: whether there is an Earlier to open. */
  earlier: number
}

export interface Reported {
  rev: number
  open: Entry[]
  earlier: number
  /** Entries that entered attention or done as news, for the line a notices consumer is told. */
  news: Entry[]
}

export interface Imported {
  imported: number
  /** True when this project had been imported before, or had no notifications file. */
  already: boolean
}

export class Inbox {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensureInbox(db)
  }

  /* ---- reading ---- */

  rev(project: number): number {
    const row = this.db
      .query<{ value: string }, [number]>("select value from inbox_meta where project = ? and key = 'rev'")
      .get(project)
    return row ? Number(row.value) || 0 : 0
  }

  #bump(project: number): number {
    const next = this.rev(project) + 1
    this.db
      .query(
        `insert into inbox_meta (project, key, value) values (?, 'rev', ?)
         on conflict (project, key) do update set value = excluded.value`,
      )
      .run(project, String(next))
    return next
  }

  /** What the host knows modules as (`known.ts`), for entries that arrived without a name (imported ones). */
  #names(): Map<string, string> {
    try {
      return new Map(
        this.db.query<{ id: string; name: string }, []>('select id, name from known_modules').all().map((row) => [row.id, row.name]),
      )
    } catch {
      return new Map()
    }
  }

  #named(list: Entry[]): Entry[] {
    if (!list.some((one) => !one.name)) return list
    const names = this.#names()
    return list.map((one) => (one.name ? one : { ...one, name: names.get(one.module) ?? '' }))
  }

  #entries(project: number, module?: string): Entry[] {
    const rows = module === undefined
      ? this.db.query<ItemRow, [number]>('select * from inbox_items where project = ? order by module, id').all(project)
      : this.db.query<ItemRow, [number, string]>('select * from inbox_items where project = ? and module = ? order by id').all(project, module)
    return rows.map(toEntry)
  }

  /** Every entry of a project, open and closed. For the log and for tests. */
  all(project: number): Entry[] {
    return this.#named(this.#entries(project))
  }

  open(project: number): Entry[] {
    return this.#named(
      this.db
        .query<ItemRow, [number]>('select * from inbox_items where project = ? and closed is null')
        .all(project)
        .map(toEntry),
    )
  }

  snapshot(project: number): Snapshot {
    const earlier = this.db
      .query<{ n: number }, [number]>('select count(*) as n from inbox_items where project = ? and closed is not null')
      .get(project)!.n
    return { rev: this.rev(project), open: this.open(project), earlier }
  }

  moves(project: number): Move[] {
    return this.db
      .query<{ module: string; id: string; state: string; at: number; label: string }, [number]>(
        'select module, id, state, at, label from inbox_moves where project = ? order by seq',
      )
      .all(project)
      .map((row) => ({ ...row, state: row.state as ActivityState }))
  }

  /** The log: closed entries and past states, newest first, narrowed by scope, a page of it. */
  log(project: number, narrowing: Narrowing | null, offset: number, limit: number): { rows: LogRow[]; more: boolean; total: number } {
    const rows = logRows(this.all(project), this.moves(project)).filter(
      (row) => narrowing === null || inScope(row.place, narrowing.scope, narrowing.at),
    )
    return { rows: rows.slice(offset, offset + limit), more: rows.length > offset + limit, total: rows.length }
  }

  /* ---- writing ---- */

  /** What the person was told, before this host held it: carried over from the page's storage once. */
  #pending(project: number, key: 'pending-seen' | 'pending-told'): Record<string, number> {
    const row = this.db
      .query<{ value: string }, [number, string]>('select value from inbox_meta where project = ? and key = ?')
      .get(project, key)
    const value = parseJson<unknown>(row?.value ?? null, {})
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
    ) as Record<string, number>
  }

  #setPending(project: number, key: string, value: Record<string, number>): void {
    const entries = Object.entries(value)
    const kept = entries.length > PENDING_MAX
      ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, PENDING_MAX))
      : value
    if (!Object.keys(kept).length) {
      this.db.query('delete from inbox_meta where project = ? and key = ?').run(project, key)
      return
    }
    this.db
      .query(
        `insert into inbox_meta (project, key, value) values (?, ?, ?)
         on conflict (project, key) do update set value = excluded.value`,
      )
      .run(project, key, JSON.stringify(kept))
  }

  #write(project: number, entry: Entry): void {
    this.db
      .query(
        `insert into inbox_items
           (project, module, id, name, state, label, detail, place, priority, refs, grp,
            entered, opened, closed, how, seen, dismissed, origin, touched)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (project, module, id) do update set
           name = excluded.name, state = excluded.state, label = excluded.label, detail = excluded.detail,
           place = excluded.place, priority = excluded.priority, refs = excluded.refs, grp = excluded.grp,
           entered = excluded.entered, closed = excluded.closed, how = excluded.how,
           seen = excluded.seen, dismissed = excluded.dismissed, touched = excluded.touched`,
      )
      .run(
        project,
        entry.module,
        entry.id,
        entry.name,
        entry.state,
        entry.label,
        entry.detail ?? null,
        entry.place ? JSON.stringify(entry.place) : null,
        entry.priority,
        JSON.stringify(entry.refs),
        entry.group ?? null,
        entry.entered,
        entry.opened,
        entry.closed,
        entry.how,
        entry.seen,
        entry.dismissed,
        entry.origin,
        this.clock(),
      )
  }

  #move(project: number, move: Move): void {
    this.db
      .query('insert into inbox_moves (project, module, id, state, at, label) values (?, ?, ?, ?, ?, ?)')
      .run(project, move.module, move.id, move.state, move.at, move.label)
  }

  /**
   * One module's whole list, as it is now.
   *
   * `silent` is a module that stopped answering: whatever it had open closes,
   * as `how: 'silent'`. `unreported` is a module whose new page did not say
   * its list again in its grace: the same, as `how: 'unreported'`. An empty
   * list is the same thing said in the module's own words (`how: 'listed'`).
   *
   * `present` is what is still in the project: an item naming a kehikko or an
   * epic that is gone is not held, and one held for it closes as `gone`.
   */
  report(
    project: number,
    module: string,
    name: string,
    items: readonly ActivityItem[],
    options: { silent?: boolean; unreported?: boolean; loadedAt?: number; present?: Present | null } = {},
  ): Reported {
    const id = module
    const now = this.clock()
    const run = this.db.transaction((): Reported => {
      const have = this.#entries(project, id)
      const seen = this.#pending(project, 'pending-seen')
      const told = this.#pending(project, 'pending-told')
      const quiet = options.silent || options.unreported
      const present = options.present ?? null
      const applied = applyList(have, id, name, quiet ? [] : items, {
        now,
        how: options.silent ? 'silent' : options.unreported ? 'unreported' : 'listed',
        ...(present ? { gone: (place: Place | undefined) => placeGone(place, present) } : {}),
        ...(options.loadedAt !== undefined ? { loadedAt: options.loadedAt } : {}),
        told: (module, itemId, state) => told[`${module}\u0000${itemId}\u0000${state}`],
      })
      let usedSeen = false
      for (const entry of applied.puts) {
        /* A seen set the page held before this store: honoured once, for the
           `entered` it was kept against. */
        const kept = seen[rowKey(entry)]
        if (kept !== undefined && entry.state === 'done' && kept === entry.entered && entry.seen !== kept) {
          entry.seen = kept
          usedSeen = true
        }
        this.#write(project, entry)
      }
      for (const move of applied.moves) this.#move(project, move)
      if (usedSeen) {
        const rest = { ...seen }
        for (const entry of applied.puts) if (entry.seen === rest[rowKey(entry)]) delete rest[rowKey(entry)]
        this.#setPending(project, 'pending-seen', rest)
      }
      if (applied.puts.length) this.#trim(project)
      const rev = applied.puts.length ? this.#bump(project) : this.rev(project)
      return { rev, open: this.open(project), earlier: this.snapshot(project).earlier, news: applied.news }
    })
    return run()
  }

  /**
   * Close what nothing will ever report again: the open entries of a module
   * that is no longer installed, and of a kehikko or an epic the project no
   * longer has (`retire` in `src/host/inbox.ts`), as `how: 'gone'`. Kept in the
   * log like any closing. Answers how many closed.
   */
  retire(project: number, present: Present): { retired: number; rev: number } {
    const run = this.db.transaction(() => {
      const closing = retire(this.open(project), present, this.clock())
      for (const entry of closing) this.#write(project, entry)
      return { retired: closing.length, rev: closing.length ? this.#bump(project) : this.rev(project) }
    })
    return run()
  }

  /** One `events.emit` line of `kehikot.notifications@1`, as an entry born closed. */
  notice(
    project: number,
    module: string,
    name: string,
    line: NoticeLine,
    kehikko?: string,
  ): Reported {
    const id = module
    const now = this.clock()
    const run = this.db.transaction((): Reported => {
      const made = noticeEntry(id, name, line, `notice:${now.toString(36)}:${crypto.randomUUID().slice(0, 8)}`, now, kehikko)
      this.#write(project, made.entry)
      this.#move(project, made.move)
      this.#trim(project)
      return { rev: this.#bump(project), open: this.open(project), earlier: this.snapshot(project).earlier, news: [] }
    })
    return run()
  }

  #trim(project: number): void {
    const count = this.db
      .query<{ n: number }, [number]>('select count(*) as n from inbox_items where project = ?')
      .get(project)!.n
    if (count <= ENTRIES_MAX) return
    const surplus = count - ENTRIES_MAX
    /* Closed first, oldest first; then whatever is open but not live. */
    const doomed = this.db
      .query<{ module: string; id: string }, [number, number]>(
        `select module, id from inbox_items where project = ?
         order by (closed is null) asc, coalesce(closed, touched) asc limit ?`,
      )
      .all(project, surplus)
    for (const one of doomed) this.#drop(project, one.module, one.id)
  }

  #drop(project: number, module: string, id: string): void {
    this.db.query('delete from inbox_moves where project = ? and module = ? and id = ?').run(project, module, id)
    this.db.query('delete from inbox_items where project = ? and module = ? and id = ?').run(project, module, id)
  }

  /** The person was told of these `done` entries (pressed, or arrived at their place). */
  see(project: number, keys: readonly { module: string; id: string }[]): { changed: number; rev: number } {
    return this.#mark(project, keys, (entry) => (entry.state === 'done' && !isSeen(entry) ? { seen: entry.entered } : null))
  }

  /** Put these open entries away without telling the module; they return if their state changes. */
  dismiss(project: number, keys: readonly { module: string; id: string }[]): { changed: number; rev: number } {
    return this.#mark(project, keys, (entry) =>
      isOpen(entry) && entry.state !== 'working' && !isDismissed(entry) ? { dismissed: entry.entered } : null,
    )
  }

  #mark(
    project: number,
    keys: readonly { module: string; id: string }[],
    change: (entry: Entry) => Partial<Pick<Entry, 'seen' | 'dismissed'>> | null,
  ): { changed: number; rev: number } {
    const run = this.db.transaction(() => {
      let changed = 0
      for (const key of keys) {
        const row = this.db
          .query<ItemRow, [number, string, string]>('select * from inbox_items where project = ? and module = ? and id = ?')
          .get(project, key.module, key.id)
        if (!row) continue
        const entry = toEntry(row)
        const next = change(entry)
        if (!next) continue
        this.#write(project, { ...entry, ...next })
        changed += 1
      }
      return { changed, rev: changed ? this.#bump(project) : this.rev(project) }
    })
    return run()
  }

  /** Every unseen `done` the narrowing shows, as seen. */
  seeAll(project: number, narrowing: Narrowing | null): { changed: number; rev: number } {
    const keys = this.open(project).filter(
      (one) => one.state === 'done' && !isSeen(one) && !isDismissed(one)
        && (narrowing === null || inScope(one.place, narrowing.scope, narrowing.at)),
    )
    return this.see(project, keys)
  }

  /**
   * Forget from the log: named closed entries, or everything the narrowing
   * shows. A `done` that was seen and is still reported is put away (it would
   * only come back as itself); a past state of an open entry is removed from
   * its timeline. Never touches what is live.
   */
  forget(
    project: number,
    keys: readonly { module: string; id: string }[] | null,
    narrowing: Narrowing | null,
  ): { forgotten: number; rev: number } {
    const run = this.db.transaction(() => {
      const named = keys ? new Set(keys.map((one) => rowKey({ module: one.module, id: one.id }))) : null
      let forgotten = 0
      for (const entry of this.all(project)) {
        if (named && !named.has(rowKey(entry))) continue
        if (narrowing && !inScope(entry.place, narrowing.scope, narrowing.at)) continue
        if (entry.closed !== null) {
          this.#drop(project, entry.module, entry.id)
          forgotten += 1
          continue
        }
        if (isSeen(entry)) {
          this.#write(project, { ...entry, dismissed: entry.entered })
          forgotten += 1
        }
        /* The states it has left: everything but the latest move. */
        const moves = this.db
          .query<{ seq: number }, [number, string, string]>(
            'select seq from inbox_moves where project = ? and module = ? and id = ? order by at desc, seq desc',
          )
          .all(project, entry.module, entry.id)
        for (const old of moves.slice(1)) {
          this.db.query('delete from inbox_moves where seq = ?').run(old.seq)
          forgotten += 1
        }
      }
      return { forgotten, rev: forgotten ? this.#bump(project) : this.rev(project) }
    })
    return run()
  }

  /* ---- what came before this store ---- */

  /**
   * What the page kept in its own storage before the host held it: the seen
   * set and the told set, taken once. Honoured as entries arrive.
   */
  migrate(project: number, seen: unknown, told: unknown): { rev: number } {
    const numbers = (value: unknown): Record<string, number> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([key, v]) => typeof v === 'number' && Number.isFinite(v) && key.length <= 400)
              .slice(0, PENDING_MAX),
          ) as Record<string, number>)
        : {}
    const run = this.db.transaction(() => {
      const migrated = this.db
        .query<{ value: string }, [number]>("select value from inbox_meta where project = ? and key = 'migrated-storage'")
        .get(project)
      if (migrated) return { rev: this.rev(project) }
      const seenNow = numbers(seen)
      const toldNow = numbers(told)
      /* Whatever the store already holds is applied now; the rest waits. */
      const rest: Record<string, number> = {}
      for (const [key, entered] of Object.entries(seenNow)) {
        const [module, id] = key.split('\u0000')
        const row = module && id
          ? this.db.query<ItemRow, [number, string, string]>('select * from inbox_items where project = ? and module = ? and id = ?').get(project, module, id)
          : null
        if (row && row.state === 'done' && row.entered === entered) {
          this.db.query('update inbox_items set seen = ? where project = ? and module = ? and id = ?').run(entered, project, row.module, row.id)
        } else rest[key] = entered
      }
      this.#setPending(project, 'pending-seen', rest)
      this.#setPending(project, 'pending-told', toldNow)
      this.db
        .query("insert into inbox_meta (project, key, value) values (?, 'migrated-storage', ?)")
        .run(project, String(this.clock()))
      return { rev: this.#bump(project) }
    })
    return run()
  }

  /**
   * The Notifications module's rows in this project, taken in once as closed
   * entries. The file is read and never changed or removed. Recorded in the
   * database, so a project that is opened again, or whose file is later
   * deleted and re-made, does not import twice; and each row's id is its own
   * `seq`, so even a repeated import cannot duplicate one.
   */
  importNotifications(
    project: number,
    projectPath: string | null,
    /** The project's kehikot, so a row that named its kehikko only by name is filed under the key. */
    kehikot: readonly { key: string; name: string }[] = [],
  ): Imported {
    const done = this.db
      .query<{ value: string }, [number]>("select value from inbox_meta where project = ? and key = 'imported-notifications'")
      .get(project)
    if (done) return { imported: 0, already: true }
    if (!projectPath) return { imported: 0, already: false }
    const rows = readNotificationRows(projectPath)
    const run = this.db.transaction(() => {
      let imported = 0
      const now = this.clock()
      for (const row of rows ?? []) {
        const id = `imported:${row.seq}`
        const module = row.from
        const exists = this.db
          .query('select 1 from inbox_items where project = ? and module = ? and id = ?')
          .get(project, module, id)
        if (exists) continue
        const at = Date.parse(row.at)
        const when = Number.isFinite(at) ? at : now
        const line: NoticeLine = {
          epic: row.payload.epic,
          message: row.payload.message,
          level: row.payload.level,
          refs: row.payload.refs,
          ...(row.payload.place && (row.payload.place.epic || row.payload.place.parts?.length || row.payload.place.kehikko)
            ? { place: row.payload.place as Place }
            : {}),
        }
        /* The key when the row had one; else the one kehikko of that name,
           when exactly one has it. */
        const named = row.kehikko?.name ? kehikot.filter((one) => one.name === row.kehikko?.name) : []
        const key = row.kehikko?.key ?? (named.length === 1 ? named[0]!.key : undefined)
        const made = noticeEntry(module, '', line, id, when, key)
        made.entry.origin = 'imported'
        made.entry.how = 'imported'
        this.#write(project, made.entry)
        this.#move(project, made.move)
        imported += 1
      }
      this.db
        .query("insert into inbox_meta (project, key, value) values (?, 'imported-notifications', ?)")
        .run(project, String(now))
      if (imported) {
        this.#trim(project)
        this.#bump(project)
      }
      return { imported, already: false }
    })
    return run()
  }
}

/* ---- the Notifications module's own file, read and never written ---- */

const rowSchema = z.object({
  seq: z.number(),
  from: z.string().min(1).max(64),
  at: z.string(),
  kehikko: z.object({ id: z.number().optional(), name: z.string().optional(), key: z.string().optional() }).nullable().default(null),
  payload: z
    .object({
      epic: z.string().default(''),
      message: z.string().default(''),
      level: z.string().default('info'),
      refs: z.array(z.string()).default([]),
      place: z
        .object({ epic: z.string().optional(), parts: z.array(z.string()).optional(), kehikko: z.string().optional() })
        .optional(),
    })
    .passthrough(),
})
type NotificationRow = z.infer<typeof rowSchema>

const FILE_MAX = 8 * 1024 * 1024

/** The rows of `<project>/.kehikot/notifications/notifications.json`, or `null` when there are none to read. */
export function readNotificationRows(projectPath: string): NotificationRow[] | null {
  let path: string | null
  try {
    path = moduleFile(projectPath, 'kehikot.notifications', 'notifications')
  } catch {
    return null
  }
  if (!path || !existsSync(path)) return null
  try {
    /* The fence the module itself had: what it reads is really under the project. */
    const real = realpathSync(path)
    if (!within(realpathSync(projectPath), real)) return null
    if (statSync(real).size > FILE_MAX) return null
    const parsed: unknown = JSON.parse(readFileSync(real, 'utf8'))
    const rows = (parsed as { rows?: unknown })?.rows
    if (!Array.isArray(rows)) return null
    const out: NotificationRow[] = []
    for (const one of rows) {
      const row = rowSchema.safeParse(one)
      if (row.success && row.data.payload.message) out.push(row.data)
    }
    return out
  } catch {
    return null
  }
}

/* ---- the schema ---- */

export function ensureInbox(db: Database): void {
  db.exec(`
    create table if not exists inbox_items (
      project  integer not null references projects(id) on delete cascade,
      module   text    not null,
      id       text    not null,
      name     text    not null default '',
      state    text    not null,
      label    text    not null,
      detail   text,
      place    text,
      priority text    not null default 'normal',
      refs     text    not null default '[]',
      grp      text,
      entered  integer not null,
      opened   integer not null,
      closed   integer,
      how      text,
      seen     integer,
      dismissed integer,
      origin   text    not null default 'activity',
      touched  integer not null,
      primary key (project, module, id)
    );
    create index if not exists inbox_items_open on inbox_items (project, closed);
    create table if not exists inbox_moves (
      seq     integer primary key autoincrement,
      project integer not null references projects(id) on delete cascade,
      module  text    not null,
      id      text    not null,
      state   text    not null,
      at      integer not null,
      label   text    not null
    );
    create index if not exists inbox_moves_by_item on inbox_moves (project, module, id);
    create table if not exists inbox_meta (
      project integer not null references projects(id) on delete cascade,
      key     text    not null,
      value   text    not null,
      primary key (project, key)
    );
  `)
}

/** A list of items read off a request body: refused whole when the protocol would refuse it. */
export function itemsIn(raw: unknown): ActivityItem[] | null {
  const parsed = activityItemsSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
