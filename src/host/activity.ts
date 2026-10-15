import { worstActivity, type ActivityItem, type ActivityState } from 'kehikot-module-protocol'

/**
 * What the modules say they are doing (protocol 1.5.0, `activity.set`), held
 * and marked.
 *
 * Pure, and importable from both halves like `parts.ts`: the page holds the
 * lists and draws; nothing here names a module.
 *
 * ## What is held
 *
 * Each module's LAST list, whole, per project (`Held`). A new list replaces the
 * old one; `[]` removes the module. The list goes when the module stops
 * answering or its container is gone (`dropped`): items are never kept as
 * "done" on behalf of a module that cannot say any more, so a module whose
 * server died does not leave `working` marks standing for ever.
 *
 * ## `entered`
 *
 * The moment an item entered its state: its own `since`, or — for a module
 * that sends none — the moment this host first held it in that state. It is
 * what "seen" is remembered against, so an item that comes back to `done`
 * later is unseen again.
 *
 * ## Seen
 *
 * Only `done` is ever cleared by being seen. A seen set is
 * `{ '<module>\u0000<id>': entered }`; an item is seen while its key holds
 * its current `entered`.
 *
 * ## Notices are derived, not reported
 *
 * A module says what it is doing with `activity.set` and nothing else: the
 * host turns each ENTRY into `attention` or `done` into ONE
 * `kehikot.notifications@1` line for whoever consumes it, as if the module had
 * sent it (`deriveNotices`, `noticeFor`). So the dots and the notice log are
 * two views of one report and cannot disagree. A module still uses
 * `events.emit` for a line that is not a state ("tracker read failed").
 *
 * Rules: none for `working`; none when the item's place is open on screen;
 * each `(module, id, state, entered)` at most once, remembered per project
 * across a reload (`Derived`, capped); the first list a module sends after a
 * page load is a baseline, where only an item whose own `since` is newer than
 * what was last derived (or than the page load) is told.
 */

export interface HeldItem extends ActivityItem {
  module: string
  entered: number
}

/** One project's lists, by module id. */
export type Lists = Readonly<Record<string, readonly HeldItem[]>>
/** Every project's, by project id. */
export type Held = Readonly<Record<number, Lists>>
export type Seen = Readonly<Record<string, number>>

/** The words each state carries, for the tooltip and assistive technology. Never colour alone. */
export const ACTIVITY_WORDS: Record<ActivityState, string> = {
  attention: 'needs your attention',
  done: 'finished',
  working: 'working',
}

const RANK: Record<ActivityState, number> = { attention: 3, working: 2, done: 1 }

export const NO_LISTS: Lists = Object.freeze({})

const same = (a: readonly HeldItem[], b: readonly HeldItem[]): boolean =>
  a.length === b.length &&
  a.every((one, i) => {
    const two = b[i]!
    return (
      one.id === two.id &&
      one.state === two.state &&
      one.label === two.label &&
      one.detail === two.detail &&
      one.entered === two.entered &&
      JSON.stringify(one.place ?? null) === JSON.stringify(two.place ?? null)
    )
  })

/** A module's whole list, replacing its last one in a project. The same object back when nothing changed. */
export function replaced(
  was: Held,
  project: number,
  module: string,
  items: readonly ActivityItem[],
  now: number,
): Held {
  const lists = was[project] ?? NO_LISTS
  const before = lists[module] ?? []
  const known = new Map(before.map((one) => [one.id, one]))
  const next: HeldItem[] = items.map((item) => {
    const kept = known.get(item.id)
    const entered = item.since ?? (kept && kept.state === item.state ? kept.entered : now)
    return { ...item, module, entered }
  })
  if (same(before, next)) return was
  const { [module]: _gone, ...rest } = lists
  const changed: Lists = next.length ? { ...rest, [module]: next } : rest
  const { [project]: _p, ...others } = was
  return Object.keys(changed).length ? { ...others, [project]: changed } : others
}

/** Every list of a module that is not alive any more, across projects. The same object when none was. */
export function dropped(was: Held, alive: (module: string) => boolean): Held {
  let out: Record<number, Lists> | null = null
  for (const [project, lists] of Object.entries(was)) {
    const kept = Object.fromEntries(Object.entries(lists).filter(([module]) => alive(module)))
    if (Object.keys(kept).length === Object.keys(lists).length) continue
    out ??= { ...was }
    if (Object.keys(kept).length) out[Number(project)] = kept
    else delete out[Number(project)]
  }
  return out ?? was
}

export const seenKey = (module: string, id: string): string => `${module}\u0000${id}`

/** Whether the person has been told of this `done` item already. Only `done` is ever seen. */
export const isSeen = (seen: Seen, item: HeldItem): boolean =>
  item.state === 'done' && seen[seenKey(item.module, item.id)] === item.entered

/** The seen set with these items added. The same object when none is new. */
export function sawItems(seen: Seen, items: readonly HeldItem[]): Seen {
  let out: Record<string, number> | null = null
  for (const item of items) {
    if (item.state !== 'done' || isSeen(seen, item)) continue
    out ??= { ...seen }
    out[seenKey(item.module, item.id)] = item.entered
  }
  return out ?? seen
}

/** How many remembered entries are kept; the oldest go first. */
const SEEN_MAX = 400

export function boundSeen(seen: Seen): Seen {
  const entries = Object.entries(seen)
  if (entries.length <= SEEN_MAX) return seen
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX))
}

/** Where the person is: the open epic, the picked parts (none is the whole epic) and the open kehikko's key. */
export interface Where {
  epic: string | null
  parts: readonly string[]
  kehikko: string | null
}

type Place = NonNullable<ActivityItem['place']>

/** Whether a place is where the person is: every piece it names is open. A place naming nothing is never "here". */
export function placeOpened(place: Place | undefined, at: Where): boolean {
  if (!place) return false
  const named = place.epic !== undefined || (place.parts?.length ?? 0) > 0 || place.kehikko !== undefined
  if (!named) return false
  if (place.epic !== undefined && place.epic !== at.epic) return false
  if (place.parts?.length && at.parts.length && !place.parts.every((id) => at.parts.includes(id))) return false
  if (place.kehikko !== undefined && place.kehikko !== at.kehikko) return false
  return true
}

/** The `done` items whose place the person has just arrived at. */
export function visited(items: readonly HeldItem[], seen: Seen, at: Where): HeldItem[] {
  return items.filter((item) => item.state === 'done' && !isSeen(seen, item) && placeOpened(item.place, at))
}

/** What still counts: everything but a `done` that was seen. */
export const counted = (items: readonly HeldItem[], seen: Seen): HeldItem[] =>
  items.filter((item) => !isSeen(seen, item))

const worst = (items: Iterable<HeldItem>): ActivityState | null => worstActivity([...items].map((one) => one.state))

/** A container's mark: the worst of that module's items. */
export function moduleMark(items: readonly HeldItem[], module: string): ActivityState | null {
  return worst(items.filter((one) => one.module === module))
}

/** Each epic that holds something, with its worst state. An item naming a part of an epic marks that epic through its own `epic`. */
export function epicMarks(
  items: readonly HeldItem[],
  open: string | null,
  partsOf: (epic: string) => readonly string[] = () => [],
): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>()
  const add = (epic: string, state: ActivityState) => {
    const was = out.get(epic)
    if (!was || RANK[state] > RANK[was]) out.set(epic, state)
  }
  for (const item of items) {
    const { place } = item
    if (!place) continue
    if (place.epic !== undefined) add(place.epic, item.state)
    else if (place.parts?.length && open !== null) {
      /* No epic named but parts: they are the open epic's, or the epic that
         has such a part. */
      const ids = partsOf(open)
      if (place.parts.some((id) => ids.includes(id))) add(open, item.state)
    }
  }
  return out
}

/** The open epic's parts that hold something. An item naming another epic marks none of these. */
export function partMarks(items: readonly HeldItem[], open: string | null): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>()
  for (const item of items) {
    const { place } = item
    if (!place?.parts?.length) continue
    if (place.epic !== undefined && place.epic !== open) continue
    for (const id of place.parts) {
      const was = out.get(id)
      if (!was || RANK[item.state] > RANK[was]) out.set(id, item.state)
    }
  }
  return out
}

/** Each kehikko (by key) that holds something. */
export function kehikkoMarks(items: readonly HeldItem[]): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>()
  for (const item of items) {
    const key = item.place?.kehikko
    if (key === undefined) continue
    const was = out.get(key)
    if (!was || RANK[item.state] > RANK[was]) out.set(key, item.state)
  }
  return out
}

/** The worst of the marks of every key except `except`. */
export function worstOther(marks: ReadonlyMap<string, ActivityState>, except: string | null): ActivityState | null {
  return worstActivity([...marks].filter(([key]) => key !== except).map(([, state]) => state))
}

/** The menu's order: worst first, then the most recently entered. */
export function ordered(items: readonly HeldItem[]): HeldItem[] {
  return [...items].sort((a, b) => RANK[b.state] - RANK[a.state] || b.entered - a.entered)
}

/** How many items need the person: the menu badge. */
export const attentionCount = (items: readonly HeldItem[]): number =>
  items.filter((one) => one.state === 'attention').length

/** What names the place, in words: epic · parts · kehikko. Names the page does not know fall back to the id. */
export interface Namer {
  epic(slug: string): string | null
  part(epic: string | null, id: string): string | null
  kehikko(key: string): string | null
}

export function placeWords(place: Place | undefined, names: Namer): string {
  if (!place) return ''
  const out: string[] = []
  if (place.epic !== undefined) out.push(names.epic(place.epic) ?? place.epic)
  if (place.parts?.length) {
    out.push(place.parts.map((id) => names.part(place.epic ?? null, id) ?? id).join(', '))
  }
  if (place.kehikko !== undefined) out.push(names.kehikko(place.kehikko) ?? place.kehikko)
  return out.join(' · ')
}

/**
 * The place in two lines for the menu: `here` is the specific part (picked
 * parts · kehikko), which tells two rows apart, and `epic` is the long title
 * that may be cut. `placeWords` is these two joined, the other way round.
 */
export function placeSplit(place: Place | undefined, names: Namer): { epic: string; here: string } {
  if (!place) return { epic: '', here: '' }
  const here: string[] = []
  if (place.parts?.length) here.push(place.parts.map((id) => names.part(place.epic ?? null, id) ?? id).join(', '))
  if (place.kehikko !== undefined) here.push(names.kehikko(place.kehikko) ?? place.kehikko)
  return {
    epic: place.epic !== undefined ? (names.epic(place.epic) ?? place.epic) : '',
    here: here.join(' · '),
  }
}

/** A title for a mark: the state's words, and the label when there is one. */
export const markWords = (state: ActivityState, what?: string): string =>
  what ? `${what} — ${ACTIVITY_WORDS[state]}` : ACTIVITY_WORDS[state]

/* ---- remembered across a reload, per browser, per project ---- */

const SEEN_PREFIX = 'kehikot.activity.seen.'

export function readSeen(storage: Pick<Storage, 'getItem'> | null, project: number): Seen {
  try {
    const text = storage?.getItem(`${SEEN_PREFIX}${project}`)
    if (!text) return {}
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
    ) as Seen
  } catch {
    return {}
  }
}

export function writeSeen(storage: Pick<Storage, 'setItem'> | null, project: number, seen: Seen): void {
  try {
    storage?.setItem(`${SEEN_PREFIX}${project}`, JSON.stringify(boundSeen(seen)))
  } catch {
    /* A browser that will not keep it shows a green dot again after a reload; nothing else is lost. */
  }
}

/** What the server is told for `read_canvas`: one row per item of the project, with whether it was seen. */
export interface ActivityRow {
  module: string
  /** The module's name, for a person; the page fills it in when it posts. */
  name?: string
  id: string
  state: ActivityState
  label: string
  place: string
  detail?: string
  seen: boolean
}

export function rowsFor(items: readonly HeldItem[], seen: Seen, names: Namer): ActivityRow[] {
  return ordered(items).map((item) => ({
    module: item.module,
    id: item.id,
    state: item.state,
    label: item.label,
    place: placeWords(item.place, names),
    ...(item.detail ? { detail: item.detail } : {}),
    seen: isSeen(seen, item),
  }))
}

/* ---- notices derived from entries ---- */

/** `{ '<module>\u0000<id>\u0000<state>': entered }` of the last notice derived for it. */
export type Derived = Readonly<Record<string, number>>

export const derivedKey = (module: string, id: string, state: ActivityState): string =>
  `${module}\u0000${id}\u0000${state}`

/**
 * Which items of a module's new list are to be told of, and the derived set
 * with every entry looked at added.
 *
 * `baseline` is true for the first list the module sent since the page loaded;
 * `loadedAt` is when that was. An item that is on screen is recorded as
 * derived without being told: the person was looking.
 */
export function deriveNotices(
  items: readonly HeldItem[],
  derived: Derived,
  at: Where,
  baseline: boolean,
  loadedAt: number,
): { fire: HeldItem[]; derived: Derived } {
  const fire: HeldItem[] = []
  let out: Record<string, number> | null = null
  for (const item of items) {
    if (item.state === 'working') continue
    const key = derivedKey(item.module, item.id, item.state)
    const last = derived[key]
    if (baseline) {
      /* Told only what is newer than what was last told — or, with nothing
         remembered, newer than this page. No `since`, no news: its `entered`
         is only when this page first held it. */
      if (item.since === undefined || item.entered <= (last ?? loadedAt)) continue
    } else if (last !== undefined && item.entered <= last) continue
    out ??= { ...derived }
    out[key] = item.entered
    if (!placeOpened(item.place, at)) fire.push(item)
  }
  return { fire, derived: out ?? derived }
}

export function boundDerived(derived: Derived): Derived {
  const entries = Object.entries(derived)
  if (entries.length <= SEEN_MAX) return derived
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX))
}

const DETAIL_MAX = 80
const MESSAGE_MAX = 400

/**
 * The line for a derived notice, in the format the Claude module sent for the
 * same two moments: the state in words, the label in quotes, the place in
 * words. Null when it cannot be filed — the format files every line under an
 * epic, and neither the item nor the open canvas names one.
 */
export function noticeFor(
  item: HeldItem,
  at: Where,
  names: Namer,
): {
  epic: string
  message: string
  level: 'attention' | 'done'
  refs: []
  place?: { epic: string; parts?: string[]; kehikko?: string }
} | null {
  if (item.state === 'working') return null
  const epic = item.place?.epic ?? at.epic
  if (!epic) return null
  const what = item.state === 'done' ? 'Finished' : 'Waiting for you'
  const where = placeWords(item.place, names)
  const detail = item.detail?.replace(/\s+/g, ' ').trim()
  let message = `${what}: \u201c${item.label}\u201d${where ? ` \u2014 ${where}` : ''}`
  if (detail && detail.length <= DETAIL_MAX) message += `. ${detail}`
  if (message.length > MESSAGE_MAX) message = `${message.slice(0, MESSAGE_MAX - 1)}\u2026`
  const place = item.place
  const parts = place?.parts
  return {
    epic,
    message,
    level: item.state === 'done' ? 'done' : 'attention',
    refs: [],
    ...(place?.epic !== undefined
      ? {
          place: {
            epic: place.epic,
            ...(parts?.length && parts.length <= 16 ? { parts: [...parts] } : {}),
            ...(place.kehikko !== undefined ? { kehikko: place.kehikko } : {}),
          },
        }
      : {}),
  }
}

const DERIVED_PREFIX = 'kehikot.activity.derived.'

export function readDerived(storage: Pick<Storage, 'getItem'> | null, project: number): Derived {
  try {
    const text = storage?.getItem(`${DERIVED_PREFIX}${project}`)
    if (!text) return {}
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
    ) as Derived
  } catch {
    return {}
  }
}

export function writeDerived(storage: Pick<Storage, 'setItem'> | null, project: number, derived: Derived): void {
  try {
    storage?.setItem(`${DERIVED_PREFIX}${project}`, JSON.stringify(boundDerived(derived)))
  } catch {
    /* Without it a reload may tell a person again; nothing else is lost. */
  }
}
