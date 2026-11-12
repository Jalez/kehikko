import type { Database } from 'bun:sqlite'
import {
  activityItemsSchema,
  activityQuestionSchema,
  type ActivityItem,
  type ActivityState,
  type InboxEvent,
} from 'kehikot-module-protocol'

import {
  ENTRIES_MAX,
  applyList,
  isAskable,
  inScope,
  isDismissed,
  isOpen,
  isSeen,
  logRows,
  noticeEntry,
  offerEntry,
  offerId,
  isOffer,
  placeGone,
  retire,
  rowKey,
  type Closing,
  type Entry,
  type EntryAnswer,
  type EntryEvent,
  type EntryGo,
  type EntryQuestion,
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
  event: string | null
  question: string | null
  answered: string | null
  entered: number
  opened: number
  closed: number | null
  how: string | null
  seen: number | null
  dismissed: number | null
  origin: string
  go?: string | null
}

const STATES = new Set<string>(['working', 'attention', 'done'])
const PRIORITIES = new Set<string>(['urgent', 'normal', 'low'])
const HOWS = new Set<string>(['listed', 'silent', 'unreported', 'gone', 'notice', 'imported', 'taken', 'replaced'])
const ORIGINS = new Set<string>(['activity', 'notice', 'imported', 'offer'])

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** The stored event (protocol 2.31.0), read leniently: anything not an `{ id, says }` is no event. */
function eventOf(text: string | null): { named?: EntryEvent } {
  const value = parseJson<unknown>(text, null)
  if (typeof value !== 'object' || value === null) return {}
  const { id, says } = value as Record<string, unknown>
  return typeof id === 'string' && id && typeof says === 'string' && says ? { named: { id, says } } : {}
}

/** The stored question (protocol 2.55.0), read leniently: held to the protocol's shape again, else none. */
function questionOf(text: string | null): { question?: EntryQuestion } {
  const read = activityQuestionSchema.safeParse(parseJson<unknown>(text, null))
  if (!read.success) return {}
  const { text: said, choices, to, replyTo } = read.data
  return { question: { text: said, choices: choices ?? [], to: { module: to.module, session: to.session }, ...(replyTo !== undefined ? { replyTo } : {}) } }
}

/** The stored answer, read leniently: anything but `{ entered, at, text }` is no answer. */
function answeredOf(text: string | null): { answered?: EntryAnswer } {
  const value = parseJson<unknown>(text, null)
  if (typeof value !== 'object' || value === null) return {}
  const { entered, at, text: said } = value as Record<string, unknown>
  return typeof entered === 'number' && typeof at === 'number' && typeof said === 'string' && said
    ? { answered: { entered, at, text: said } }
    : {}
}

/** Where an offer goes beyond its place (protocol 2.87.0), read leniently: a whole step from 1, a title as text. */
function goOf(text: string | null | undefined): { go?: EntryGo } {
  const value = parseJson<unknown>(text ?? null, null)
  if (typeof value !== 'object' || value === null) return {}
  const { step, title } = value as Record<string, unknown>
  return {
    go: {
      ...(typeof step === 'number' && Number.isInteger(step) && step >= 1 ? { step } : {}),
      ...(typeof title === 'string' && title ? { title } : {}),
    },
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
    ...eventOf(row.event),
    ...questionOf(row.question ?? null),
    ...answeredOf(row.answered ?? null),
    ...(row.origin === 'offer' ? goOf(row.go) : {}),
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
  /** How many entries are closed, a muted module's left out: whether there is an Earlier to open. */
  earlier: number
  /**
   * The modules the person turned "Use inbox" off for, on this machine (`use`). Their entries are
   * still in `open`: the record is kept whole, and the page leaves them out of what it draws.
   */
  muted: string[]
}

export interface Reported {
  rev: number
  open: Entry[]
  earlier: number
  /** Entries that entered attention or done as news, for the chime and the toast. */
  news: Entry[]
}

export class Inbox {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensureInbox(db)
  }

  /**
   * Take every item of one module whose id starts with `prefix` out of the record, in every
   * project — the items and their moves — for a kind of item the host no longer files (the
   * old "which epic is this conversation for?" ask). Returns each project it changed, with its
   * new rev; nothing when there was nothing to take, so running it again does nothing.
   */
  forgetAll(module: string, prefix: string): { project: number; rev: number }[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const projects = this.db
      .query<{ project: number }, [string, string]>("select distinct project from inbox_items where module = ? and id like ? escape '\\'")
      .all(module, like)
      .map((row) => row.project)
    if (!projects.length) return []
    this.db.query("delete from inbox_moves where module = ? and id like ? escape '\\'").run(module, like)
    this.db.query("delete from inbox_items where module = ? and id like ? escape '\\'").run(module, like)
    return projects.map((project) => ({ project, rev: this.#bump(project) }))
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

  /** Whether any project's record holds an entry of this module and id, open or closed: what was told once. */
  holds(module: string, id: string): boolean {
    return this.db.query<{ n: number }, [string, string]>('select 1 as n from inbox_items where module = ? and id = ? limit 1').get(module, id) !== null
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
    const muted = this.muted()
    const earlier = this.db
      .query<{ n: number }, [number, string]>(
        `select count(*) as n from inbox_items where project = ? and closed is not null
         and module not in (select value from json_each(?))`,
      )
      .get(project, JSON.stringify(muted))!.n
    return { rev: this.rev(project), open: this.open(project), earlier, muted }
  }

  /* ---- "Use inbox": the person's switch per module ---- */

  /**
   * The modules the person turned "Use inbox" off for, sorted. Machine-wide, per module id, not per
   * project or kehikko: a module that runs across projects is one switch.
   */
  muted(): string[] {
    return this.db.query<{ module: string }, []>('select module from inbox_muted order by module').all().map((row) => row.module)
  }

  /**
   * Turn "Use inbox" on or off for one module: the person's act, and nothing else's.
   *
   * Nothing in the record is dropped or closed. A muted module's reports are still kept — its items,
   * their moves, what was seen — so turning it back on shows what it says now, not what it said the
   * moment it was muted, and an agent reading the inbox still learns of them (marked muted). What
   * the switch changes is what the page draws, sounds and counts.
   *
   * Every project's revision moves when the switch does, so every page re-reads and every project's
   * Inbox hides or shows the module at once. Answers whether anything changed and the revisions.
   */
  use(module: string, on: boolean): { changed: boolean; revs: { project: number; rev: number }[] } {
    const id = module
    const run = this.db.transaction(() => {
      const was = this.db.query<{ n: number }, [string]>('select 1 as n from inbox_muted where module = ?').get(id) !== null
      if (was === !on) return { changed: false, revs: [] }
      if (on) this.db.query('delete from inbox_muted where module = ?').run(id)
      else this.db.query('insert into inbox_muted (module, at) values (?, ?)').run(id, this.clock())
      const projects = this.db.query<{ id: number }, []>('select id from projects').all()
      return { changed: true, revs: projects.map((one) => ({ project: one.id, rev: this.#bump(one.id) })) }
    })
    return run()
  }

  moves(project: number): Move[] {
    return this.db
      .query<{ module: string; id: string; state: string; at: number; label: string }, [number]>(
        'select module, id, state, at, label from inbox_moves where project = ? and act is null order by seq',
      )
      .all(project)
      .map((row) => ({ ...row, state: row.state as ActivityState }))
  }

  /** The log: closed entries and past states, newest first, narrowed by scope, a page of it. */
  log(project: number, narrowing: Narrowing | null, offset: number, limit: number): { rows: LogRow[]; more: boolean; total: number } {
    /* What the person sees: a muted module's past is kept, and not drawn. */
    const muted = new Set(this.muted())
    const rows = logRows(this.all(project), this.moves(project)).filter(
      (row) => !muted.has(row.module) && (narrowing === null || inScope(row.place, narrowing.scope, narrowing.at)),
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
           (project, module, id, name, state, label, detail, place, priority, refs, grp, event, question, answered,
            entered, opened, closed, how, seen, dismissed, origin, touched, go)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (project, module, id) do update set
           name = excluded.name, state = excluded.state, label = excluded.label, detail = excluded.detail,
           place = excluded.place, priority = excluded.priority, refs = excluded.refs, grp = excluded.grp, event = excluded.event,
           question = excluded.question, answered = excluded.answered,
           entered = excluded.entered, closed = excluded.closed, how = excluded.how,
           seen = excluded.seen, dismissed = excluded.dismissed, touched = excluded.touched,
           origin = excluded.origin, go = excluded.go, opened = excluded.opened`,
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
        entry.named ? JSON.stringify(entry.named) : null,
        /* As the protocol spells it: no choices is no `choices` (an empty list is not one it takes). */
        entry.question ? JSON.stringify({ ...entry.question, choices: entry.question.choices.length ? entry.question.choices : undefined }) : null,
        entry.answered ? JSON.stringify(entry.answered) : null,
        entry.entered,
        entry.opened,
        entry.closed,
        entry.how,
        entry.seen,
        entry.dismissed,
        entry.origin,
        this.clock(),
        entry.go ? JSON.stringify(entry.go) : null,
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
    options: {
      silent?: boolean
      unreported?: boolean
      loadedAt?: number
      present?: Present | null
      events?: readonly InboxEvent[]
      /** The module relays other sessions' questions (`messages:as-person`): see `heldQuestion`. */
      relays?: boolean
    } = {},
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
        ...(options.events ? { events: options.events } : {}),
        ...(options.relays ? { relays: true } : {}),
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
    /** The host's own lines may be told as `low` (a module's notice is always `normal`). */
    priority: Priority = 'normal',
  ): Reported {
    const id = module
    const now = this.clock()
    const run = this.db.transaction((): Reported => {
      const made = noticeEntry(id, name, line, `notice:${now.toString(36)}:${crypto.randomUUID().slice(0, 8)}`, now, kehikko)
      made.entry.priority = priority
      this.#write(project, made.entry)
      this.#move(project, made.move)
      this.#trim(project)
      return { rev: this.#bump(project), open: this.open(project), earlier: this.snapshot(project).earlier, news: [] }
    })
    return run()
  }

  /**
   * An agent session's offer to take the person somewhere (`offer_jump`), filed as an open entry of
   * the module that runs the session (`offerEntry`). One open offer per session: the new one takes
   * the place of the last, in this project (the same id), and closes it as `replaced` in any other.
   * Answers this project's new rev and every other project it closed one in.
   */
  offer(
    project: number,
    module: string,
    name: string,
    session: string,
    label: string,
    place: Place | undefined,
    go: EntryGo,
  ): { rev: number; others: { project: number; rev: number }[]; replaced: boolean } {
    const now = this.clock()
    const run = this.db.transaction(() => {
      const id = offerId(session)
      const others: { project: number; rev: number }[] = []
      let replaced = false
      const elsewhere = this.db
        .query<ItemRow, [string, string, number]>('select * from inbox_items where module = ? and id = ? and project != ? and closed is null')
        .all(module, id, project)
      for (const row of elsewhere) {
        const was = toEntry(row)
        if (!isOffer(was)) continue
        this.#write(row.project, { ...was, closed: now, how: 'replaced' })
        others.push({ project: row.project, rev: this.#bump(row.project) })
        replaced = true
      }
      const before = this.entry(project, module, id)
      if (before && isOffer(before) && before.closed === null) replaced = true
      const made = offerEntry(module, name, session, label, place, go, now)
      this.#write(project, made.entry)
      this.#move(project, made.move)
      this.#trim(project)
      return { rev: this.#bump(project), others, replaced }
    })
    return run()
  }

  /**
   * The person took offers (pressed Take me there and arrived): each is marked seen and closed as
   * `taken` — an offer is done once taken. Only offers, and only open ones. The person's act alone.
   */
  took(project: number, keys: readonly { module: string; id: string }[]): { changed: number; rev: number } {
    const now = this.clock()
    const run = this.db.transaction(() => {
      let changed = 0
      for (const key of keys) {
        const entry = this.entry(project, key.module, key.id)
        if (!entry || !isOffer(entry) || entry.closed !== null) continue
        this.#write(project, { ...entry, seen: entry.entered, closed: now, how: 'taken' })
        changed += 1
      }
      return { changed, rev: changed ? this.#bump(project) : this.rev(project) }
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

  /** One entry, open or closed, or null. */
  entry(project: number, module: string, id: string): Entry | null {
    const row = this.db
      .query<ItemRow, [number, string, string]>('select * from inbox_items where project = ? and module = ? and id = ?')
      .get(project, module, id)
    return row ? this.#named([toEntry(row)])[0]! : null
  }

  /**
   * The person answered an open entry's question from the Inbox (the answer itself went to the
   * session already, `inboxRoutes.ts`). Held against the `entered` it answered, and recorded in the
   * entry's timeline as an act (`inbox_moves.act = 'answered'`, the answer as its label), which the
   * state timeline (`moves`) leaves out. The entry stays open: it closes when its module withdraws
   * it, as any other. Null when there is nothing open to answer.
   */
  answer(project: number, module: string, id: string, text: string): { rev: number; entry: Entry } | null {
    const run = this.db.transaction(() => {
      const was = this.entry(project, module, id)
      if (!was || !isAskable(was)) return null
      const at = this.clock()
      const entry: Entry = { ...was, answered: { entered: was.entered, at, text } }
      this.#write(project, entry)
      this.db
        .query("insert into inbox_moves (project, module, id, state, at, label, act) values (?, ?, ?, ?, ?, ?, 'answered')")
        .run(project, module, id, was.state, at, text)
      return { rev: this.#bump(project), entry }
    })
    return run()
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
            'select seq from inbox_moves where project = ? and module = ? and id = ? and act is null order by at desc, seq desc',
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
    -- "Use inbox" off, per module, for the whole machine: the person's switch (Inbox.use).
    create table if not exists inbox_muted (
      module text    primary key,
      at     integer not null
    );
  `)
  /* The module's named event (protocol 2.31.0), as `{ id, says }` JSON: added to a store from before it. */
  const columns = db.query<{ name: string }, []>('pragma table_info(inbox_items)').all()
  if (!columns.some((one) => one.name === 'event')) db.exec('alter table inbox_items add column event text')
  /* An item's question (protocol 2.55.0) and the person's answer to it from the Inbox, as JSON. */
  if (!columns.some((one) => one.name === 'question')) db.exec('alter table inbox_items add column question text')
  if (!columns.some((one) => one.name === 'answered')) db.exec('alter table inbox_items add column answered text')
  /* An act in an entry's timeline that is not a state it entered ('answered'); null for a state. */
  const moveColumns = db.query<{ name: string }, []>('pragma table_info(inbox_moves)').all()
  if (!moveColumns.some((one) => one.name === 'act')) db.exec('alter table inbox_moves add column act text')
  /* Where an agent's offer goes beyond its place (protocol 2.87.0): `{ step?, title? }` JSON, on an `offer` only. */
  if (!columns.some((one) => one.name === 'go')) db.exec('alter table inbox_items add column go text')
}

/** A list of items read off a request body: refused whole when the protocol would refuse it. */
export function itemsIn(raw: unknown): ActivityItem[] | null {
  const parsed = activityItemsSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
