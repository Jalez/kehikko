import { declaredEvent, worstActivity, type ActivityItem, type ActivityState, type InboxEvent } from 'kehikot-module-protocol'

import { placeOpened, placeSplit, type Namer, type Where } from './activity.ts'

/**
 * The Inbox: the host's one record of what its modules need from a person,
 * are doing, and have told them. Pure, and importable from both halves like
 * `parts.ts` — the page draws it and the server keeps it, and the two run the
 * same functions over the same shapes, so a list posted by a page and the
 * list a person sees cannot be read two ways.
 *
 * ## One record, with a life
 *
 * Per (project, module, item id) there is ONE `Entry`. It OPENS when a module
 * first reports it, records each state it enters with the time it entered
 * (`Move`), and CLOSES when the module drops it from its list, or stops
 * answering. A one-off notice is an entry born closed (`noticeEntry`). "Now"
 * is the open entries; "Earlier" is the closed ones and the states an open
 * one has left.
 *
 * ## Nothing outlives the module's word for it
 *
 * What a module said is held only while the module would still say it. Each
 * way it can stop saying it closes the entry, and `how` says which:
 *
 *  - `listed`: its latest whole list does not have it.
 *  - `silent`: the module stopped answering, or is on no kehikko of the project.
 *  - `unreported`: the module's page started again (a restart, an update, a
 *    reload of either page) and did not say it again within
 *    `REREPORT_GRACE_MS`. A list is the word of the page that sent it; a new
 *    page that never sends one has said nothing, and what the old one said is
 *    not carried over as if it had (`unreportedAfter`).
 *  - `gone`: its module is no longer installed, or its place — the kehikko or
 *    the epic it names — is no longer in the project (`retire`, `Present`). A
 *    list naming a gone place is not held at all.
 *
 * The host's own items (`isHostModule`) are closed by the host's own lists
 * and are never taken for a module that went away.
 *
 * Nothing here names a module or a vendor. The by-line is the module's own
 * name as the host knows it; what an item says is the module's claim.
 *
 * ## Seen, dismissed, forgotten — all against `entered`
 *
 *  - **Seen** is for `done` alone: the entry holds the `entered` it was seen
 *    at, so a `done` that re-enters later is unseen again. `attention` and
 *    `working` end when the module says so, never by being seen.
 *  - **Dismissed** hides an open entry from "now" without telling the module,
 *    against the `entered` it was dismissed at: it returns if its state (or
 *    its `since`) changes.
 *  - **Forget** removes a closed entry from the log.
 *
 * ## Ordering
 *
 * What needs a person: urgent first, then normal, then low; within a priority
 * the longest waiting first. Finished is newest first. See `sections`.
 */

export type Priority = 'urgent' | 'normal' | 'low'
export type Place = NonNullable<ActivityItem['place']>

/** How an entry came to close, or where it came from. */
export type Origin = 'activity' | 'notice' | 'imported'
export type Closing = 'listed' | 'silent' | 'unreported' | 'gone' | 'notice' | 'imported'

/**
 * The host's own lists — the place asks (`kehikko`), the tracker notices
 * (`kehikko.trackers`), the settings lines (`kehikko.settings`), the mentions
 * in What's new (`kehikko.whatsnew`). No container
 * stands for them and no page sends them: they are never closed for a module
 * that is not on the kehikko, not answering, or not registered.
 */
export const isHostModule = (module: string): boolean => module === 'kehikko' || module.startsWith('kehikko.')

/**
 * How long a module's new page has to say its list again before what the last
 * page said closes as `unreported`. Long enough for a module whose list comes
 * from its own server's feed (it connects after the greeting); a list that
 * arrives later still reopens the entries, and without news when nothing about
 * them changed.
 */
export const REREPORT_GRACE_MS = 20_000

export interface EntryEvent {
  id: string
  says: string
}

export interface Entry {
  module: string
  /** What the host knew the module as when it last said anything: the by-line's word. */
  name: string
  id: string
  state: ActivityState
  label: string
  detail?: string
  place?: Place
  priority: Priority
  refs: string[]
  group?: string
  /**
   * The module's named event this item is (protocol 2.31.0; `named` because
   * an item's `event` is the bare id the module sent): its id and what
   * the module calls it, "Research complete". Only one the module's manifest
   * declares for the item's state (`declaredEvent`); anything else is dropped
   * and the item is an ordinary item of its state. Still one of the states:
   * an event names a case, it is not a kind of its own.
   */
  named?: EntryEvent
  /** When it entered `state`: the module's own `since`, else when the host first held it there. */
  entered: number
  /** When it was first reported. */
  opened: number
  /** When it closed; `null` while it is open. */
  closed: number | null
  how: Closing | null
  /** The `entered` at which a `done` was seen; `null` for never. */
  seen: number | null
  /** The `entered` at which it was dismissed; `null` for never. */
  dismissed: number | null
  origin: Origin
}

/** A state an entry entered, and when. The current state's is the last. */
export interface Move {
  module: string
  id: string
  state: ActivityState
  at: number
  label: string
}

export const ENTRIES_MAX = 2000

export const rowKey = (one: { module: string; id: string }): string => `${one.module}\u0000${one.id}`

export const isOpen = (entry: Entry): boolean => entry.closed === null
export const isSeen = (entry: Entry): boolean => entry.state === 'done' && entry.seen === entry.entered
export const isDismissed = (entry: Entry): boolean => entry.dismissed === entry.entered
/** Open, and not put away by the person: what still asks for them or reports on something. */
export const isLive = (entry: Entry): boolean => isOpen(entry) && !isSeen(entry) && !isDismissed(entry)

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, normal: 1, low: 2 }

/* ---- the life of an entry ---- */

export interface ListOptions {
  now: number
  /** How an entry that is no longer listed closes. `silent` is a module that stopped answering; `unreported` one whose new page did not say it again. */
  how?: 'listed' | 'silent' | 'unreported'
  /** Whether a place is no longer in the project: an item naming one is not held, and an open entry naming one closes as `gone`. */
  gone?(place: Place | undefined): boolean
  /** When this page loaded: the first sight of a module is told only what is newer than that. */
  loadedAt?: number
  /** The `entered` of the last line told for (module, id, state) before the store held it. */
  told?(module: string, id: string, state: ActivityState): number | undefined
  /** The events the module's manifest declares (protocol 2.31.0): what an item's `event` is held to. */
  events?: readonly InboxEvent[]
}

export interface Applied {
  /** Entries to write: new, changed, or closed. */
  puts: Entry[]
  /** States entered, to append to the timeline. */
  moves: Move[]
  /** Entries that entered attention or done and are news — what a notice line is made of. */
  news: Entry[]
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((one, i) => one === b[i])
const samePlace = (a: Place | undefined, b: Place | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * One module's whole list, applied to what the store holds for that module.
 *
 * `have` is every entry of the module in the project, closed ones too (an id
 * that comes back reopens its record). Replace, never merge: an open entry that
 * is not in `items` closes.
 */
export function applyList(
  have: readonly Entry[],
  module: string,
  name: string,
  items: readonly ActivityItem[],
  options: ListOptions,
): Applied {
  const { now } = options
  const byId = new Map(have.map((one) => [one.id, one]))
  const baseline = have.length === 0
  const loadedAt = options.loadedAt ?? 0
  const out: Applied = { puts: [], moves: [], news: [] }
  const listed = new Set<string>()

  const gone = options.gone
  for (const item of items) {
    if (gone?.(item.place)) continue
    listed.add(item.id)
    const was = byId.get(item.id)
    const entered = item.since ?? (was && was.state === item.state ? was.entered : now)
    const event = declaredEvent(options.events, item)
    const next: Entry = {
      module,
      name,
      id: item.id,
      state: item.state,
      label: item.label,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.place ? { place: item.place } : {}),
      priority: item.priority ?? 'normal',
      refs: item.refs ? [...item.refs] : [],
      ...(item.group ? { group: item.group } : {}),
      ...(event ? { named: { id: event.id, says: event.says } } : {}),
      entered,
      opened: was?.opened ?? now,
      closed: null,
      how: null,
      seen: was?.seen ?? null,
      dismissed: was?.dismissed ?? null,
      origin: was?.origin ?? 'activity',
    }
    const moved = !was || was.state !== next.state || was.entered !== next.entered
    const changed =
      moved ||
      was.closed !== null ||
      was.name !== next.name ||
      was.label !== next.label ||
      was.detail !== next.detail ||
      was.priority !== next.priority ||
      was.group !== next.group ||
      was.named?.id !== next.named?.id ||
      was.named?.says !== next.named?.says ||
      !sameList(was.refs, next.refs) ||
      !samePlace(was.place, next.place)
    if (!changed) continue
    out.puts.push(next)
    if (!moved) continue
    out.moves.push({ module, id: next.id, state: next.state, at: entered, label: next.label })
    if (next.state === 'working') continue
    const last = options.told?.(module, next.id, next.state)
    if (last !== undefined && entered <= last) continue
    /* The first list a module ever sends this project is a baseline: only what
       says it is newer than this page is news. A new id of a module the store
       already knows is news whenever it arrived. */
    if (!was && baseline && (item.since === undefined || item.since < loadedAt)) continue
    out.news.push(next)
  }

  for (const entry of have) {
    if (entry.closed !== null || listed.has(entry.id)) continue
    out.puts.push({ ...entry, closed: now, how: gone?.(entry.place) ? 'gone' : (options.how ?? 'listed') })
  }
  return out
}

/**
 * What is still in the project, for `retire`. A field that is `null` is not
 * known (a registry that could not be read, a project with no epics folder)
 * and retires nothing.
 */
export interface Present {
  /** The ids of the modules installed on this machine. */
  modules: ReadonlySet<string> | null
  /** The keys of the project's kehikot. */
  kehikot: ReadonlySet<string> | null
  /** The slugs of the project's epics. */
  epics: ReadonlySet<string> | null
}

/** Whether a place names a kehikko or an epic the project no longer has. A place naming neither is never gone. */
export function placeGone(place: Place | undefined, present: Pick<Present, 'kehikot' | 'epics'>): boolean {
  if (!place) return false
  if (place.kehikko !== undefined && present.kehikot !== null && present.kehikot.size > 0 && !present.kehikot.has(place.kehikko)) return true
  if (place.epic !== undefined && place.epic !== '' && present.epics !== null && !present.epics.has(place.epic)) return true
  return false
}

/**
 * The open entries whose module or place is gone, closed as `gone`: a module
 * that was uninstalled, a kehikko that was removed, an epic that was deleted.
 * Nothing will ever report them again, so nothing would ever close them. The
 * host's own items are judged by their place only.
 */
export function retire(entries: readonly Entry[], present: Present, now: number): Entry[] {
  const out: Entry[] = []
  for (const entry of entries) {
    if (entry.closed !== null) continue
    const moduleGone = present.modules !== null && !isHostModule(entry.module) && !present.modules.has(entry.module)
    if (!moduleGone && !placeGone(entry.place, present)) continue
    out.push({ ...entry, closed: now, how: 'gone' })
  }
  return out
}

/**
 * The modules whose new page has had its grace and said nothing since it was
 * greeted: what they had open closes as `unreported`. `greeted` is when each
 * module's page last answered a greeting, `heard` when it last sent a list.
 */
export function unreportedAfter(
  greeted: ReadonlyMap<string, number>,
  heard: ReadonlyMap<string, number>,
  now: number,
  grace = REREPORT_GRACE_MS,
): string[] {
  const out: string[] = []
  for (const [module, at] of greeted) {
    if (isHostModule(module)) continue
    if (now - at < grace) continue
    if ((heard.get(module) ?? -Infinity) >= at) continue
    out.push(module)
  }
  return out.sort()
}

/** What one `events.emit` line of `kehikot.notifications@1` says, after the protocol parsed it. */
export interface NoticeLine {
  epic: string
  message: string
  level: string
  refs?: readonly string[]
  place?: Place
}

const LABEL_MAX = 120
const DETAIL_MAX = 400

/**
 * A legacy notice as an entry born closed, attributed to the module that sent
 * it. `kehikko` is the key of the kehikko it happened on, when the host knew.
 * level attention -> attention, done -> done, anything else -> done at normal.
 */
export function noticeEntry(
  module: string,
  name: string,
  line: NoticeLine,
  id: string,
  now: number,
  kehikko?: string,
): { entry: Entry; move: Move } {
  const clean = line.message.replace(/\s+/g, ' ').trim()
  /* The host's own line for an item (`noticeFor` in `activity.ts`), and an
     agent module's before it: 'Finished: \u201clabel\u201d \u2014 place'. The label is
     what the line is about; the rest is the place, which the entry carries. */
  const told = /^(Finished|Waiting for you): \u201c(.+?)\u201d(?: \u2014 .*)?$/.exec(clean)
  const state: ActivityState = told
    ? told[1] === 'Finished'
      ? 'done'
      : 'attention'
    : line.level === 'attention'
      ? 'attention'
      : 'done'
  const said = told ? told[2]! : clean
  const label = said.length > LABEL_MAX ? `${said.slice(0, LABEL_MAX - 1)}\u2026` : said
  const place: Place = {
    epic: line.place?.epic ?? line.epic,
    ...(line.place?.parts?.length ? { parts: [...line.place.parts] } : {}),
    ...(line.place?.kehikko !== undefined || kehikko !== undefined
      ? { kehikko: (line.place?.kehikko ?? kehikko) as string }
      : {}),
  }
  const entry: Entry = {
    module,
    name,
    id,
    state,
    label,
    ...(said.length > LABEL_MAX ? { detail: said.slice(0, DETAIL_MAX) } : {}),
    place,
    priority: 'normal',
    refs: [...(line.refs ?? [])].slice(0, 16),
    entered: now,
    opened: now,
    closed: now,
    how: 'notice',
    seen: null,
    dismissed: null,
    origin: 'notice',
  }
  return { entry, move: { module, id, state, at: now, label } }
}

/* ---- where an entry belongs, and scope ---- */

export type Here = 'here' | 'elsewhere' | 'unknown'

/**
 * Whether an entry is on the kehikko the person is on.
 *
 *  - It names a kehikko: that kehikko or not.
 *  - It names only an epic: the person's epic is the project's, so it is here
 *    when that is the open epic, elsewhere when it is another.
 *  - It names neither (a project-wide thing), or the host does not know which
 *    kehikko is open: `unknown`. A scope never says an unknown is not here.
 */
export function hereness(place: Place | undefined, at: Pick<Where, 'epic' | 'kehikko'>): Here {
  if (place?.kehikko !== undefined) {
    if (at.kehikko === null) return 'unknown'
    return place.kehikko === at.kehikko ? 'here' : 'elsewhere'
  }
  if (place?.epic !== undefined) {
    if (at.epic === null) return 'unknown'
    return place.epic === at.epic ? 'here' : 'elsewhere'
  }
  return 'unknown'
}

export type Scope = 'here' | 'everywhere'

/**
 * The scope the panel opens in. The default is `everywhere`: what is going on in
 * other kehikot, parts and epics is what the Inbox is for, and "This kehikko"
 * is one press away. Only a person who narrowed it is remembered (`here`, per
 * project, in their browser); anything else stored is read as the default.
 */
export function scopeFrom(stored: string | null | undefined): Scope {
  return stored === 'here' ? 'here' : 'everywhere'
}

/** Whether a scope shows an entry. `here` shows what is here and what cannot be told apart. */
export function inScope(place: Place | undefined, scope: Scope, at: Pick<Where, 'epic' | 'kehikko'>): boolean {
  return scope === 'everywhere' || hereness(place, at) !== 'elsewhere'
}

/* ---- ordering, sections, folding ---- */

/** Urgent first, then the longest waiting. */
export function byPressing(a: Entry, b: Entry): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    a.entered - b.entered ||
    a.module.localeCompare(b.module) ||
    a.id.localeCompare(b.id)
  )
}

const newestFirst = (a: Entry, b: Entry): number =>
  b.entered - a.entered || a.module.localeCompare(b.module) || a.id.localeCompare(b.id)

export interface Sections {
  needs: Entry[]
  working: Entry[]
  finished: Entry[]
  /** Open `done` the person has seen: still reported, no longer news. Shown among the earlier. */
  seen: Entry[]
}

export function sections(entries: readonly Entry[]): Sections {
  const open = entries.filter((one) => isOpen(one) && !isDismissed(one))
  return {
    needs: open.filter((one) => one.state === 'attention').sort(byPressing),
    working: open.filter((one) => one.state === 'working').sort(byPressing),
    finished: open.filter((one) => one.state === 'done' && !isSeen(one)).sort(newestFirst),
    seen: open.filter((one) => isSeen(one)).sort(newestFirst),
  }
}

/** A row of the panel: one entry, or several of one module's `group` folded. */
export interface FoldedRow {
  /** The most pressing member (the first). */
  head: Entry
  members: Entry[]
  key: string
}

/** Entries with one module and one `group` folded into one row, in the order of their first member. */
export function fold(list: readonly Entry[]): FoldedRow[] {
  const rows: FoldedRow[] = []
  const at = new Map<string, FoldedRow>()
  for (const entry of list) {
    if (entry.group === undefined) {
      rows.push({ head: entry, members: [entry], key: rowKey(entry) })
      continue
    }
    const key = `${entry.module}\u0001${entry.group}\u0001${entry.state}`
    const there = at.get(key)
    if (there) {
      there.members.push(entry)
      continue
    }
    const row: FoldedRow = { head: entry, members: [entry], key: `group:${key}` }
    at.set(key, row)
    rows.push(row)
  }
  return rows.map((row) => (row.members.length === 1 ? { ...row, key: rowKey(row.head) } : row))
}

/* ---- the number on the bar, and Next ---- */

export interface Tally {
  /** Attention items here (scope `here` means here and unknown). */
  needHere: number
  needElsewhere: number
  working: number
  finished: number
  /** Entries whose kehikko cannot be told. */
  unknown: number
}

export function tally(entries: readonly Entry[], at: Pick<Where, 'epic' | 'kehikko'>): Tally {
  const out: Tally = { needHere: 0, needElsewhere: 0, working: 0, finished: 0, unknown: 0 }
  for (const entry of entries) {
    if (!isLive(entry)) continue
    const place = hereness(entry.place, at)
    if (place === 'unknown') out.unknown += 1
    if (entry.state === 'attention') {
      if (place === 'elsewhere') out.needElsewhere += 1
      else out.needHere += 1
    } else if (entry.state === 'working') out.working += 1
    else out.finished += 1
  }
  return out
}

/** What needs a person, in the order Next goes through it: urgent, longest waiting, the rest by age. */
export function needing(entries: readonly Entry[]): Entry[] {
  return entries.filter((one) => isLive(one) && one.state === 'attention').sort(byPressing)
}

/**
 * The entry Next goes to: the one after `last` in the order of what needs a
 * person (wrapping), or the first when `last` is gone or null. `null` when
 * nothing needs anybody.
 */
export function nextOf(entries: readonly Entry[], last: string | null): Entry | null {
  const list = needing(entries)
  if (!list.length) return null
  if (last === null) return list[0]!
  const at = list.findIndex((one) => rowKey(one) === last)
  return list[(at + 1) % list.length] ?? list[0]!
}

/** The sentence of what is going on when nothing needs a person. */
export function elsewhereWords(t: Tally): string {
  const bits = [
    t.working ? `${t.working} working` : null,
    t.finished ? `${t.finished} finished` : null,
  ].filter(Boolean)
  return bits.join(', ')
}

/* ---- words ---- */

export const STATE_WORDS: Record<ActivityState, string> = {
  attention: 'needs you',
  working: 'working',
  done: 'finished',
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "3 min ago", "2 h ago", "yesterday", "5 d ago". */
export function ageWords(now: number, at: number): string {
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`
  if (ms < 2 * DAY) return 'yesterday'
  return `${Math.floor(ms / DAY)} d ago`
}

/** The by-line, which comes BEFORE the claim and is the host's word for who said it. */
export const byLine = (entry: Pick<Entry, 'name' | 'module'>): string => `${entry.name || entry.module} says`

/** The place in words for a row: parts · kehikko first, then the epic. */
export function placeLines(entry: Pick<Entry, 'place'>, names: Namer): { here: string; epic: string } {
  return placeSplit(entry.place, names)
}

/** One closing of an entry, in the words of its last state. */
export function closedWords(entry: Pick<Entry, 'state' | 'how' | 'origin'>): string {
  if (entry.origin === 'notice' || entry.origin === 'imported') {
    return entry.state === 'attention' ? 'needed you' : 'finished'
  }
  if (entry.how === 'silent') return `stopped answering, was ${STATE_WORDS[entry.state]}`
  if (entry.how === 'unreported') return `not said again after the module restarted, was ${STATE_WORDS[entry.state]}`
  if (entry.how === 'gone') return `its module or place is gone, was ${STATE_WORDS[entry.state]}`
  if (entry.state === 'attention') return 'no longer needs you'
  if (entry.state === 'done') return 'finished'
  return 'stopped'
}

/** A past state, in words. */
export const wasWords = (state: ActivityState): string =>
  state === 'attention' ? 'was waiting for you' : state === 'done' ? 'had finished' : 'was working'

/* ---- the log ---- */

/** One row of Earlier: a closed entry, a state an open entry left, or a done that was seen. */
export interface LogRow {
  /** Unique within the log. */
  key: string
  kind: 'closed' | 'past' | 'seen'
  module: string
  name: string
  id: string
  state: ActivityState
  label: string
  detail?: string
  place?: Place
  priority: Priority
  refs: string[]
  /** When it happened: the close, the time the state was left, or when the done entered. */
  at: number
  how: Closing | null
  origin: Origin
}

/**
 * Earlier, from every entry and move of a project, newest first.
 *
 * A closed entry is ONE row (its last state, when it closed); the states it
 * passed through are not repeated. An open entry contributes a row for each
 * state it has left, and a `done` that was seen contributes one for itself.
 */
export function logRows(entries: readonly Entry[], moves: readonly Move[]): LogRow[] {
  const movesOf = new Map<string, Move[]>()
  for (const move of moves) {
    const key = rowKey(move)
    const list = movesOf.get(key)
    if (list) list.push(move)
    else movesOf.set(key, [move])
  }
  const rows: LogRow[] = []
  for (const entry of entries) {
    const base = {
      module: entry.module,
      name: entry.name,
      id: entry.id,
      priority: entry.priority,
      refs: entry.refs,
      ...(entry.place ? { place: entry.place } : {}),
      how: entry.how,
      origin: entry.origin,
    }
    if (entry.closed !== null) {
      rows.push({
        ...base,
        key: `c:${rowKey(entry)}`,
        kind: 'closed',
        state: entry.state,
        label: entry.label,
        ...(entry.detail ? { detail: entry.detail } : {}),
        at: entry.closed,
      })
      continue
    }
    if (isDismissed(entry)) continue
    const own = (movesOf.get(rowKey(entry)) ?? []).sort((a, b) => a.at - b.at)
    /* Every state but the one it is in now, each ending where the next began. */
    for (let i = 0; i < own.length - 1; i += 1) {
      const move = own[i]!
      if (move.state === own[i + 1]!.state) continue
      rows.push({
        ...base,
        key: `p:${rowKey(entry)}:${i}`,
        kind: 'past',
        state: move.state,
        label: move.label,
        at: own[i + 1]!.at,
      })
    }
    if (isSeen(entry)) {
      rows.push({
        ...base,
        key: `s:${rowKey(entry)}`,
        kind: 'seen',
        state: 'done',
        label: entry.label,
        ...(entry.detail ? { detail: entry.detail } : {}),
        at: entry.entered,
      })
    }
  }
  return rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
}

/* ---- for the dots: what is live, as the marks functions of `activity.ts` read it ---- */

export const liveOf = (entries: readonly Entry[]): Entry[] => entries.filter(isLive)

/** A container's worst live state, for its header dot. */
export function worstOf(entries: readonly Entry[], module: string): ActivityState | null {
  return worstActivity(entries.filter((one) => one.module === module && isLive(one)).map((one) => one.state))
}

/** Whether a place is open on screen: a notice line for it is not told. Re-exported for the page. */
export { placeOpened }
